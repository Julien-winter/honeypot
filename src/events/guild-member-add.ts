import { GatewayDispatchEvents, RESTJSONErrorCodes } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { getDiscordDate, getDiscordDateMention } from "../utils/tools";
import { DiscordAPIError } from "@discordjs/rest";
import { styleText } from "node:util";

// Join guard: alt-detection + shared banlist (both opt-in per guild).
// Needs the Server Members intent (privileged, enable in Developer Portal).
// Action is a kick (rejoin possible) + explanatory DM + detailed log entry.

const ALT_MAX_AGE_DAYS = 7;

async function kickMember(api: any, guildId: string, userId: string, reason: string): Promise<"kicked" | "timeout" | false> {
    try {
        await api.guilds.removeMember(guildId, userId, { reason });
        return "kicked";
    } catch (err) {
        if (!(err instanceof DiscordAPIError) || (err.code !== RESTJSONErrorCodes.MissingPermissions && err.code !== RESTJSONErrorCodes.MissingAccess)) {
            console.log(`Join-guard kick failed: ${err}`);
            return false;
        }
        // no kick permission: fall back to a 1h timeout so something still happens
        console.log(styleText("dim", `Join-guard kick failed (no Kick Members perm), trying timeout: ${err}`));
        try {
            await api.guilds.editMember(
                guildId,
                userId,
                { communication_disabled_until: new Date(Date.now() + 3_600_000).toISOString() },
                { reason: `${reason} (fallback: no kick permission)` },
            );
            return "timeout";
        } catch (err2) {
            console.log(styleText("dim", `Join-guard fallback timeout failed: ${err2}`));
            return false;
        }
    }
}

async function sendGuardDM(
    api: any,
    db: typeof import("../utils/db"),
    guildId: string,
    guildName: string,
    userId: string,
    reason: string,
    reinviteUrl: string | null,
): Promise<boolean> {
    try {
        const { id: dmId } = await api.users.createDM(userId);
        await api.channels.createMessage(dmId, {
            content: `## Removed by Join Guard\nHey <@${userId}>, you were **removed** from **${guildName}** right after joining: ${reason}.\n`
                + (reinviteUrl
                    ? `If this was a mistake, you can rejoin here: ${reinviteUrl}`
                    : `If this was a mistake, please contact the server mods for a new invite.`)
                + `\n-# Automated message sent on behalf of **${guildName}**. Replies are not monitored.`,
            allowed_mentions: {},
        });
        return true;
    } catch (err) {
        console.log(styleText("dim", `Join-guard DM failed: ${err}`));
        return false;
    }
}

async function logToMods(api: any, db: typeof import("../utils/db"), guildId: string, content: string): Promise<void> {
    try {
        const config = await db.getConfig(guildId);
        if (!config?.log_channel_id) {
            console.log(styleText("dim", content.replace(/<[@#][^>]*>/g, "").slice(0, 200)));
            return;
        }
        await api.channels.createMessage(config.log_channel_id, { content, allowed_mentions: {} });
    } catch {
        // log channel best effort only
    }
}

const handler: EventHandler<GatewayDispatchEvents.GuildMemberAdd> = {
    event: GatewayDispatchEvents.GuildMemberAdd,
    handler: async ({ data: member, api, db }) => {
        try {
            const guildId = (member as any).guild_id as string | undefined;
            const user = (member as any).user as { id: string; bot?: boolean; avatar: string | null; username?: string } | undefined;
            if (!guildId || !user || user.bot) return;

            const config = await db.getConfig(guildId);
            if (!config) return;
            const experiments = config.experiments || [];
            if (!experiments.includes("alt-detection") && !experiments.includes("shared-banlist")) return;

            const createdMention = getDiscordDateMention(getDiscordDate(user.id));
            const hasAvatar = !!user.avatar;
            let detail: string | null = null;
            let dmReason: string | null = null;

            // 1. Shared network list takes precedence (known spammers).
            if (experiments.includes("shared-banlist")) {
                const hit = await db.isSharedBanned(user.id).catch(() => null);
                if (hit) {
                    detail = `on the **shared spammer list** (previously: ${hit.action})`;
                    dmReason = `your account is on the shared spammer list (previously moderated: ${hit.action})`;
                }
            }

            // 2. Alt detection: ban evaders first, then suspicious new accounts.
            if (experiments.includes("alt-detection")) {
                const match = await db.findEvasionMatch(user.id, {
                    username: (user as any)?.username ?? null,
                    global_name: (user as any)?.global_name ?? null,
                    avatar: user.avatar ?? null,
                }).catch(() => null);
                if (match) {
                    const action = await kickMember(api, guildId, user.id, "Join guard: possible ban evader");
                    if (!action) {
                        await logToMods(api, db, guildId,
                            `⚠️ <@${user.id}> (\`${user.id}\`) looks like previously moderated **${match.username ?? match.user_id}** (\`${match.user_id}\`) but I could **not** remove them — missing Kick/Timeout permissions.`);
                        return;
                    }
                    const [reinviteCode2, guildInfo2] = await Promise.all([
                        db.getReinvite(guildId).catch(() => null),
                        api.guilds.get(guildId).catch(() => null),
                    ]).catch(() => [null, null] as const);
                    const guildName2 = (guildInfo2 as any)?.name ?? guildId;
                    const dmOk2 = await sendGuardDM(api, db, guildId, guildName2, user.id,
                        "your account matches a previously removed spam account",
                        reinviteCode2 ? `https://discord.gg/${reinviteCode2}` : null);
                    const pastTense2 = action === "kicked" ? "kicked" : "timed out for 1h (no kick permission)";
                    await logToMods(api, db, guildId,
                        `🔁 <@${user.id}> (\`${user.id}\`) **${pastTense2}** on join — possible **ban evader** (matches **${match.username ?? "unknown"}** \`${match.user_id}\`)\n`
                        + `-# Account created: ${createdMention} • Avatar: ${hasAvatar ? "yes" : "no"} • DM: ${dmOk2 ? "sent" : "failed (DMs closed)"}`);
                    return;
                }
                const ageDays = (Date.now() - getDiscordDate(user.id)) / 86_400_000;
                const triggers: string[] = [];
                if (ageDays < ALT_MAX_AGE_DAYS) triggers.push(`${Math.max(0, Math.floor(ageDays))} days old`);
                if (!hasAvatar) triggers.push("no avatar");
                if (triggers.length > 0) {
                    detail = `suspicious new account (${triggers.join(", ")})`;
                    dmReason = `your account looks suspicious (${triggers.join(", ")})`;
                }
            }

            if (!detail || !dmReason) return;

            const action = await kickMember(api, guildId, user.id, `Join guard: ${detail.replace(/\*\*/g, "")}`);
            if (!action) {
                await logToMods(api, db, guildId,
                    `⚠️ <@${user.id}> (\`${user.id}\`) triggered the join guard (${detail}) but I could **not** remove them — missing Kick/Timeout permissions.`);
                return;
            }

            const [reinviteCode, guildInfo] = await Promise.all([
                db.getReinvite(guildId).catch(() => null),
                api.guilds.get(guildId).catch(() => null),
            ]).catch(() => [null, null] as const);
            const guildName = (guildInfo as any)?.name ?? guildId;
            const dmOk = await sendGuardDM(api, db, guildId, guildName, user.id,
                dmReason, reinviteCode ? `https://discord.gg/${reinviteCode}` : null);

            const pastTense = action === "kicked" ? "kicked" : "timed out for 1h (no kick permission)";
            await logToMods(api, db, guildId,
                `🛡️ <@${user.id}> (\`${user.id}\`) **${pastTense}** on join — ${detail}\n`
                + `-# Account created: ${createdMention} • Avatar: ${hasAvatar ? "yes" : "no"} • DM: ${dmOk ? "sent" : "failed (DMs closed)"}`);
        } catch (err) {
            console.log(`Error with GuildMemberAdd handler: ${err}`);
        }
    }
};

export default handler;
