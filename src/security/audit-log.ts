import { AuditLogEvent, type APIAuditLogEntry, type APIEmbed, type RESTGetAPIAuditLogResult, Routes } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { DiscordAPIError } from "@discordjs/rest";
import { styleText } from "node:util";
import { getDiscordDate, trim } from "../utils/tools";
import type { SecurityConfig } from "../utils/db";
import { sendSecurityLog } from "./notify";
import { enforceQuarantine, quarantineNewBot } from "./quarantine";
import type { DbModule } from "./config";

type ActionInfo = { label: string; color: number; target?: "user" | "channel" | "role" };

/** Audit actions the event log reports on (the categories Protector shows as its "event log"). */
const TRACKED_ACTIONS: Record<number, ActionInfo> = {
    [AuditLogEvent.GuildUpdate]: { label: "Server updated", color: 0x5865f2 },
    [AuditLogEvent.ChannelCreate]: { label: "Channel created", color: 0x57f287, target: "channel" },
    [AuditLogEvent.ChannelUpdate]: { label: "Channel updated", color: 0xfee75c, target: "channel" },
    [AuditLogEvent.ChannelDelete]: { label: "Channel deleted", color: 0xed4245, target: "channel" },
    [AuditLogEvent.ChannelOverwriteCreate]: { label: "Channel permission created", color: 0x5865f2, target: "channel" },
    [AuditLogEvent.ChannelOverwriteUpdate]: { label: "Channel permission updated", color: 0xfee75c, target: "channel" },
    [AuditLogEvent.ChannelOverwriteDelete]: { label: "Channel permission removed", color: 0xed4245, target: "channel" },
    [AuditLogEvent.MemberKick]: { label: "Member kicked", color: 0xeb459e, target: "user" },
    [AuditLogEvent.MemberBanAdd]: { label: "Member banned", color: 0xf04747, target: "user" },
    [AuditLogEvent.MemberBanRemove]: { label: "Member unbanned", color: 0x57f287, target: "user" },
    [AuditLogEvent.MemberUpdate]: { label: "Member updated", color: 0x5865f2, target: "user" },
    [AuditLogEvent.MemberRoleUpdate]: { label: "Member roles changed", color: 0xfee75c, target: "user" },
    [AuditLogEvent.BotAdd]: { label: "Bot added", color: 0x5865f2, target: "user" },
    [AuditLogEvent.RoleCreate]: { label: "Role created", color: 0x57f287, target: "role" },
    [AuditLogEvent.RoleUpdate]: { label: "Role updated", color: 0xfee75c, target: "role" },
    [AuditLogEvent.RoleDelete]: { label: "Role deleted", color: 0xed4245, target: "role" },
    [AuditLogEvent.InviteCreate]: { label: "Invite created", color: 0x5865f2 },
    [AuditLogEvent.InviteDelete]: { label: "Invite deleted", color: 0xf04747 },
    [AuditLogEvent.WebhookCreate]: { label: "Webhook created", color: 0x5865f2 },
    [AuditLogEvent.WebhookUpdate]: { label: "Webhook updated", color: 0xfee75c },
    [AuditLogEvent.WebhookDelete]: { label: "Webhook deleted", color: 0xf04747 },
    [AuditLogEvent.EmojiCreate]: { label: "Emoji created", color: 0x57f287 },
    [AuditLogEvent.EmojiUpdate]: { label: "Emoji updated", color: 0xfee75c },
    [AuditLogEvent.EmojiDelete]: { label: "Emoji deleted", color: 0xf04747 },
};

/** Newest-first list of audit log entries. */
export async function fetchAuditLogEntries(
    api: API | API2,
    guildId: string,
    opts: { limit?: number; before?: string; after?: string; action_type?: AuditLogEvent } = {},
): Promise<APIAuditLogEntry[]> {
    const query: Record<string, string> = { limit: String(Math.min(opts.limit ?? 10, 100)) };
    if (opts.before) query.before = opts.before;
    if (opts.after) query.after = opts.after;
    if (opts.action_type !== undefined) query.action_type = String(opts.action_type);

    const result = await api.rest.get(Routes.guildAuditLog(guildId), { query: new URLSearchParams(query) }) as RESTGetAPIAuditLogResult;
    return result.audit_log_entries.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
}

function formatValue(value: unknown): string {
    if (value === null || value === undefined) return "*nothing*";
    if (typeof value === "object") return trim(JSON.stringify(value), 60);
    return trim(String(value), 60);
}

function formatTarget(entry: APIAuditLogEntry): string {
    const target = entry.target_id ? `(\`${entry.target_id}\`)` : "";
    switch (entry.action_type) {
        case AuditLogEvent.ChannelCreate:
        case AuditLogEvent.ChannelUpdate:
        case AuditLogEvent.ChannelDelete:
        case AuditLogEvent.ChannelOverwriteCreate:
        case AuditLogEvent.ChannelOverwriteUpdate:
        case AuditLogEvent.ChannelOverwriteDelete:
            return entry.target_id ? `<#${entry.target_id}> ${target}` : `a channel ${target}`;
        case AuditLogEvent.RoleCreate:
        case AuditLogEvent.RoleUpdate:
        case AuditLogEvent.RoleDelete:
            return entry.target_id ? `<@&${entry.target_id}> ${target}` : `a role ${target}`;
        case AuditLogEvent.MemberKick:
        case AuditLogEvent.MemberBanAdd:
        case AuditLogEvent.MemberBanRemove:
        case AuditLogEvent.MemberUpdate:
        case AuditLogEvent.MemberRoleUpdate:
        case AuditLogEvent.BotAdd:
            return entry.target_id ? `<@${entry.target_id}> ${target}` : `a member ${target}`;
        case AuditLogEvent.GuildUpdate:
            return "this server";
        default:
            return entry.target_id ? `\`${entry.target_id}\`` : "*unknown*";
    }
}

function entryToEmbed(entry: APIAuditLogEntry): APIEmbed {
    const info = TRACKED_ACTIONS[entry.action_type];
    const changes = (entry.changes ?? []).slice(0, 3).map(c => `-# - \`${c.key}\`: ${formatValue(c.old_value)} → ${formatValue(c.new_value)}`);
    const lines = [
        `**By:** <@${entry.user_id ?? "0"}> (\`${entry.user_id ?? "?"}\`)`,
        `**Target:** ${formatTarget(entry)}`,
        entry.reason ? `**Reason:** ${trim(entry.reason, 200)}` : null,
        ...changes,
    ].filter(Boolean);

    return {
        title: info?.label ?? `Audit log entry ${entry.action_type}`,
        color: info?.color ?? 0x5865f2,
        description: lines.join("\n"),
        timestamp: new Date(getDiscordDate(entry.id)).toISOString(),
        footer: { text: `Honeypot event log · action ${entry.action_type}` },
    };
}

// ------------------------- poller -------------------------

const cursors = new Map<string, string>();
/** guild id -> timestamp when polling may be tried again (missing access is often fixed by admins). */
const blockedUntil = new Map<string, number>();
const BLOCK_RETRY_MS = 60 * 60_000;

/**
 * Polls the audit log of every guild with event-log/quarantine enabled:
 *  - posts an embed per tracked change to the event log channel
 *  - quarantines freshly added bots (BOT_ADD)
 *  - re-strips quarantined bots that got roles back (MEMBER_ROLE_UPDATE)
 *
 * Cadence: SECURITY_POLL_SEC (default 20s) per tick, each guild is visited about
 * every SECURITY_CYCLE_SEC (default 120s). Set SECURITY_POLLER=0 to disable.
 */
export function startSecurityPoller(
    api: API | API2,
    db: DbModule,
    redis?: Bun.RedisClient | null,
): () => void {
    if (process.env.SECURITY_POLLER === "0") return () => { };

    const pollMs = Math.max(5_000, (Number(process.env.SECURITY_POLL_SEC) || 20) * 1000);
    const cycleSec = Math.max(30, Number(process.env.SECURITY_CYCLE_SEC) || 120);
    let offset = 0;
    let running = false;
    let stopped = false;

    const applicationId = (() => {
        const token = process.env.DISCORD_TOKEN;
        try { return token ? atob(token.split(".")[0]!) : ""; } catch { return ""; }
    })();

    const pollGuild = async (guildId: string, cfg: SecurityConfig) => {
        try {
            const last = cursors.get(guildId);
            const entries = await fetchAuditLogEntries(api, guildId, { limit: 20, ...(last ? { after: last } : {}) });

            if (!last) {
                // first visit: remember the newest entry so we never replay old history
                if (entries.length > 0) cursors.set(guildId, entries[0]!.id);
                return;
            }
            if (entries.length === 0) return;

            const newest = entries.reduce((acc, e) => (BigInt(e.id) > BigInt(acc) ? e.id : acc), last);
            cursors.set(guildId, newest);

            for (const entry of entries.slice().reverse()) { // oldest first
                if (BigInt(entry.id) <= BigInt(last)) continue;
                try {
                    let handledByQuarantine = false;
                    if (cfg.quarantine) {
                        if (entry.action_type === AuditLogEvent.BotAdd) {
                            handledByQuarantine = await quarantineNewBot(api, db, redis ?? undefined, guildId, entry.target_id ?? "", entry.user_id ?? null, applicationId);
                        } else if (entry.action_type === AuditLogEvent.MemberRoleUpdate && entry.target_id) {
                            await enforceQuarantine(api, db, redis ?? undefined, guildId, entry.target_id);
                        }
                    }
                    if (cfg.event_log && !handledByQuarantine && TRACKED_ACTIONS[entry.action_type]) {
                        await sendSecurityLog(api, db, guildId, cfg, entryToEmbed(entry));
                    }
                } catch (err) {
                    console.error(`Error processing audit entry ${entry.id} in ${guildId}: ${err}`);
                }
            }
        } catch (err) {
            if (err instanceof DiscordAPIError && (err.code === 50001 || err.code === 50013)) {
                blockedUntil.set(guildId, Date.now() + BLOCK_RETRY_MS);
                console.error(styleText("red", `[security-poller] missing access to audit log in ${guildId}, pausing polls for this server for 1h: ${err}`));
            } else {
                console.error(`[security-poller] ${guildId}: ${err}`);
            }
        }
    };

    const tick = async () => {
        if (running || stopped) return;
        running = true;
        try {
            const [logGuilds, quarantineGuilds] = await Promise.all([
                db.getSecurityGuilds("event_log"),
                db.getSecurityGuilds("quarantine"),
            ]);
            const byId = new Map<string, SecurityConfig>();
            for (const cfg of [...logGuilds, ...quarantineGuilds]) byId.set(cfg.guild_id, cfg);

            const ids = [...byId.keys()].filter(id => (blockedUntil.get(id) ?? 0) <= Date.now()).sort();
            if (ids.length === 0) return;

            const ticksPerCycle = Math.max(1, Math.round((cycleSec * 1000) / pollMs));
            const budget = Math.max(1, Math.ceil(ids.length / ticksPerCycle));
            for (let i = 0; i < Math.min(budget, ids.length); i++) {
                const guildId = ids[(offset + i) % ids.length]!;
                await pollGuild(guildId, byId.get(guildId)!);
            }
            offset = (offset + budget) % ids.length;
        } catch (err) {
            console.error(`[security-poller] tick failed: ${err}`);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void tick(), pollMs);
    void tick();
    console.log(styleText("dim", `[security-poller] started (every ${pollMs / 1000}s, guild cycle ~${cycleSec}s)`));

    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
