import { MessageType, PermissionFlagsBits, type APIEmbed, type APIMessage, type GatewayMessageCreateDispatchData } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { styleText } from "node:util";
import { getGuildInfo } from "../utils/cache";
import { hasPermission } from "../utils/tools";
import { HAS_MESSAGE_INTENT } from "../utils/constants";
import type { SecurityConfig } from "../utils/db";
import { ensureMessagesUnrestricted, getSecurityConfigCached, messageModulesEnabled, type DbModule } from "./config";
import { findPhishingMatch, type PhishingMatch } from "./phishing-list";
import { recordSecurityEvent, sendSecurityLog } from "./notify";

/** Message types worth scanning - everything else is joins/pins/polls/system noise. */
const scannableTypes = new Set<number>([
    MessageType.Default,
    MessageType.Reply,
    MessageType.ThreadStarterMessage,
    MessageType.ChatInputCommand,
    MessageType.ContextMenuCommand,
]);

const ACTION_COOLDOWN_MS = 60_000;
const TIMEOUT_MS = 10 * 60 * 1000;

// ------------------------- flood window -------------------------

const memoryWindows = new Map<string, number[]>();
const actionCooldown = new Map<string, number>();

function pruneMemoryWindows(now: number) {
    for (const [key, timestamps] of memoryWindows) {
        const fresh = timestamps.filter(t => now - t < 60_000);
        if (fresh.length === 0) memoryWindows.delete(key);
        else memoryWindows.set(key, fresh);
    }
}

function windowKey(guildId: string, userId: string) {
    return `spam_win:${guildId}:${userId}`;
}

/** Count messages a user sent inside the configured window (redis-backed when available so it works across replicas). */
async function countRecentMessages(guildId: string, userId: string, windowSec: number, redis?: Bun.RedisClient | null): Promise<number> {
    const now = Date.now();
    if (redis) {
        try {
            const key = windowKey(guildId, userId);
            const count = await redis.incr(key);
            // fixed window: only the first message sets the TTL, otherwise a slow trickle
            // (1 message per window) would refresh the key forever and false-positive as flooding.
            // The modulo is a safety net that heals keys that somehow lost their TTL.
            if (count === 1 || count % 100 === 0) await redis.pexpire(key, windowSec * 1000);
            return Number(count);
        } catch (err) {
            console.error(`Redis spam window failed, using memory: ${err}`);
        }
    }
    const key = `${guildId}:${userId}`;
    const timestamps = (memoryWindows.get(key) ?? []).filter(t => now - t < windowSec * 1000);
    timestamps.push(now);
    if (memoryWindows.size > 20_000) pruneMemoryWindows(now);
    memoryWindows.set(key, timestamps);
    return timestamps.length;
}

async function resetFloodWindow(guildId: string, userId: string, redis?: Bun.RedisClient | null) {
    if (redis) await Promise.resolve(redis.del(windowKey(guildId, userId))).catch(() => { });
    memoryWindows.delete(`${guildId}:${userId}`);
}

// ------------------------- coordinated raid detection -------------------------

const contentBuckets = new Map<string, Map<string, { users: Set<string>; ts: number }>>();

function hashText(text: string): string {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

const COORDINATED_THRESHOLD = 3;
const COORDINATED_WINDOW_MS = 60_000;

/** True when the same message was already posted by 2+ other accounts in this guild recently. */
function trackCoordinated(guildId: string, content: string, userId: string): number {
    const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length < 20) return 0;

    let guildMap = contentBuckets.get(guildId);
    if (!guildMap) contentBuckets.set(guildId, guildMap = new Map());

    const now = Date.now();
    if (guildMap.size > 100) guildMap.clear();
    for (const [key, entry] of guildMap) {
        if (now - entry.ts > COORDINATED_WINDOW_MS) guildMap.delete(key);
    }

    const hash = hashText(normalized);
    let entry = guildMap.get(hash);
    if (!entry) guildMap.set(hash, entry = { users: new Set(), ts: now });
    entry.users.add(userId);
    entry.ts = now;
    return entry.users.size;
}

// ------------------------- main entry point -------------------------

export async function handleSecurityMessage(
    message: GatewayMessageCreateDispatchData,
    api: API | API2,
    applicationId: string,
    redis: Bun.RedisClient | undefined,
    db: DbModule,
) {
    try {
        const guildId = message.guild_id;
        if (!guildId || !scannableTypes.has(message.type)) return;
        if (message.author.id === applicationId) return;

        const cfg = await getSecurityConfigCached(db, guildId);
        if (!messageModulesEnabled(cfg)) return;
        ensureMessagesUnrestricted(guildId, redis);

        const content = HAS_MESSAGE_INTENT ? (message.content ?? "") : "";
        const isBotAuthor = !!message.author.bot || !!message.webhook_id;

        // ---- phishing: content/embed/attachment links (needs the message content intent) ----
        if (cfg!.anti_phishing && HAS_MESSAGE_INTENT) {
            const match = scanForPhishing(message, content);
            if (match) {
                return await actOnMessage(api, db, redis, cfg!, {
                    type: "phishing",
                    reason: `${match.reason} — \`${match.url.slice(0, 100)}\``,
                    guildId,
                    userId: message.author.id,
                    channelId: message.channel_id,
                    messageId: message.id,
                    content,
                    isBotAuthor,
                    onCooldown: false,
                });
            }
        }

        // flood / mentions only apply to human members (webhooks & bots are handled by phishing checks)
        if (!cfg!.anti_spam || isBotAuthor) return;

        const mentionCount = (message.mentions?.length ?? 0) + (message.mention_roles?.length ?? 0);
        const memberPermissionBit = message.member && "permissions" in message.member ? (message.member.permissions as string) : null;
        const memberPerms = memberPermissionBit ? BigInt(memberPermissionBit) : 0n;
        const mayMentionEveryone = memberPermissionBit
            ? hasPermission(memberPerms, PermissionFlagsBits.MentionEveryone)
            : false;
        const mentionSignal = (!mayMentionEveryone && !!message.mention_everyone) || mentionCount >= cfg!.mention_threshold;
        const giantSignal = content.length >= 3999;

        const messageCount = await countRecentMessages(guildId, message.author.id, cfg!.spam_window_sec, redis);
        const floodSignal = messageCount >= cfg!.spam_threshold || giantSignal;
        const coordinatedUsers = trackCoordinated(guildId, content, message.author.id);
        const coordinatedSignal = coordinatedUsers >= COORDINATED_THRESHOLD;

        if (!mentionSignal && !floodSignal && !coordinatedSignal) return;

        const guildInfo = await getGuildInfo(api, guildId, AbortSignal.timeout(500), redis).catch(() => null);
        const memberRoles = message.member?.roles ?? [];
        if (guildInfo?.ownerId === message.author.id) return;
        if (guildInfo?.adminRoles?.some(role => memberRoles.includes(role))) return;

        const reason = mentionSignal
            ? (message.mention_everyone && mentionCount === 0
                ? "Posted @everyone without permission"
                : `Mass mentions (${mentionCount} users/roles)`)
            : coordinatedSignal
                ? `Coordinated raid — same message from ${coordinatedUsers} accounts`
                : giantSignal && messageCount < cfg!.spam_threshold
                    ? "Giant message (wall of text)"
                    : `Flooding — ${messageCount} messages in ${cfg!.spam_window_sec}s`;

        const onCooldown = (actionCooldown.get(`${guildId}:${message.author.id}`) ?? 0) > Date.now();

        const acted = await actOnMessage(api, db, redis, cfg!, {
            type: "spam",
            reason,
            guildId,
            userId: message.author.id,
            channelId: message.channel_id,
            messageId: message.id,
            content,
            isBotAuthor,
            onCooldown,
        });
        if (acted) await resetFloodWindow(guildId, message.author.id, redis);
    } catch (err) {
        console.error(`Error with security message handler: ${err}`);
    }
}

function scanForPhishing(message: APIMessage, content: string): PhishingMatch | null {
    if (content) {
        const match = findPhishingMatch(content);
        if (match) return match;
    }
    for (const embed of message.embeds ?? []) {
        const text = [embed.url, embed.title, embed.description].filter(Boolean).join(" ");
        if (!text) continue;
        const match = findPhishingMatch(text);
        if (match) return match;
    }
    for (const attachment of message.attachments ?? []) {
        const text = [attachment.url, attachment.filename].filter(Boolean).join(" ");
        if (!text) continue;
        const match = findPhishingMatch(text);
        if (match) return match;
    }
    return null;
}

type ActArgs = {
    type: "spam" | "phishing";
    reason: string;
    guildId: string;
    userId: string;
    channelId: string;
    messageId: string;
    content: string;
    isBotAuthor: boolean;
    onCooldown: boolean;
};

/** Delete the message, timeout the author (spam only) and log the incident. Returns true when it acted. */
async function actOnMessage(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    cfg: SecurityConfig,
    args: ActArgs,
): Promise<boolean> {
    if (args.onCooldown) return false;
    actionCooldown.set(`${args.guildId}:${args.userId}`, Date.now() + ACTION_COOLDOWN_MS);
    if (actionCooldown.size > 5_000) {
        for (const [key, expires] of actionCooldown) if (expires < Date.now()) actionCooldown.delete(key);
    }

    await api.channels.deleteMessage(args.channelId, args.messageId, { reason: `Honeypot security: ${args.reason}` })
        .then(() => console.log(styleText("dim", `[${args.type}] deleted message in ${args.channelId}: ${args.reason}`)))
        .catch((err) => console.log(styleText("dim", `[${args.type}] failed to delete message in ${args.channelId}: ${err}`)));

    if (args.type === "spam" && !args.isBotAuthor) {
        await api.guilds.editMember(args.guildId, args.userId, {
            communication_disabled_until: new Date(Date.now() + TIMEOUT_MS).toISOString(),
        }, { reason: `Honeypot security: ${args.reason}` })
            .catch((err) => console.log(styleText("dim", `[${args.type}] failed to timeout ${args.userId}: ${err}`)));
    }

    await recordSecurityEvent(db, redis, args.guildId, args.type, args.userId, args.channelId, { reason: args.reason });

    const embed: APIEmbed = {
        title: args.type === "phishing" ? "🔗 Phishing link removed" : "🚫 Spam stopped",
        color: args.type === "phishing" ? 0xf04747 : 0xeb459e,
        description: [
            `**Author:** <@${args.userId}> (\`${args.userId}\`)`,
            `**Channel:** <#${args.channelId}>`,
            `**Reason:** ${args.reason}`,
            `**Message:** [jump](https://discord.com/channels/${args.guildId}/${args.channelId}/${args.messageId})`,
        ].join("\n"),
        timestamp: new Date().toISOString(),
        footer: { text: "Honeypot security" },
    };
    await sendSecurityLog(api, db, args.guildId, cfg, embed);

    return true;
}
