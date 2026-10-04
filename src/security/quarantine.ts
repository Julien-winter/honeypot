import { ComponentType, ButtonStyle, type APIEmbed, type APIGuildMember } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { styleText } from "node:util";
import { getSecurityConfigCached, type DbModule } from "./config";
import { recordSecurityEvent, sendSecurityLog } from "./notify";
import type { SecurityConfig } from "../utils/db";

/** Resolve a channel for quarantine alerts: event log -> honeypot log -> system channel. */
async function resolveAlertChannel(api: API | API2, db: DbModule, guildId: string, cfg: SecurityConfig | null): Promise<string | null> {
    if (cfg?.event_log && cfg.event_log_channel_id) return cfg.event_log_channel_id;
    try {
        const honeypot = await db.getConfig(guildId);
        if (honeypot?.log_channel_id) return honeypot.log_channel_id;
    } catch { /* config missing */ }
    try {
        const guild = await api.guilds.get(guildId, undefined, { signal: AbortSignal.timeout(1000) });
        return guild.system_channel_id ?? null;
    } catch {
        return null;
    }
}

async function postAlert(
    api: API | API2,
    db: DbModule,
    guildId: string,
    cfg: SecurityConfig | null,
    body: { botUserId: string; botTag: string; addedBy: string | null; restoredRoles: string[]; restrip?: boolean },
): Promise<void> {
    const channelId = await resolveAlertChannel(api, db, guildId, cfg);
    if (!channelId) return;

    const embed: APIEmbed = {
        title: body.restrip ? "🔒 Quarantined bot got roles again" : "🔒 New bot quarantined",
        color: 0xfee75c,
        description: [
            `**Bot:** <@${body.botUserId}> (\`${body.botTag}\`)`,
            body.addedBy ? `**Added by:** <@${body.addedBy}>` : null,
            body.restoredRoles.length > 0
                ? `**Roles removed:** ${body.restoredRoles.map(r => `<@&${r}>`).join(" ")}`
                : "**Roles removed:** none (was powerless)",
            body.restrip ? "The roles were re-added before approval - removed again." : "Approve to restore the roles, or kick the bot.",
        ].filter(Boolean).join("\n"),
        timestamp: new Date().toISOString(),
        footer: { text: "Bot quarantine" },
    };

    try {
        await api.channels.createMessage(channelId, {
            embeds: [embed],
            allowed_mentions: { parse: [] },
            components: [{
                type: ComponentType.ActionRow,
                components: [
                    { type: ComponentType.Button, style: ButtonStyle.Success, label: "Approve", custom_id: `q_approve:${body.botUserId}` },
                    { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Kick", custom_id: `q_kick:${body.botUserId}` },
                ],
            }],
        });
    } catch (err) {
        console.error(`Failed to post quarantine alert in ${guildId}: ${err}`);
    }
}

/**
 * Strip a newly added bot and remember its roles until an admin approves it.
 * Called from the audit-log poller when a BOT_ADD entry shows up.
 */
export async function quarantineNewBot(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    guildId: string,
    botUserId: string,
    addedById: string | null,
    applicationId: string,
): Promise<boolean> {
    if (botUserId === applicationId) return false;
    const cfg = await getSecurityConfigCached(db, guildId);
    if (!cfg?.quarantine) return false;

    let member: APIGuildMember | null = null;
    try {
        member = await api.guilds.getMember(guildId, botUserId, { signal: AbortSignal.timeout(2000) });
    } catch (err) {
        console.error(`Failed to fetch new bot ${botUserId} in ${guildId}: ${err}`);
        return false;
    }
    if (!member?.user?.bot) return false;

    const roles = (member.roles ?? []).filter(id => id !== guildId);
    if (roles.length > 0) {
        try {
            await api.guilds.editMember(guildId, botUserId, { roles: [] },
                { reason: "Bot quarantine: awaiting owner approval" });
        } catch (err) {
            console.error(`Failed to quarantine bot ${botUserId} in ${guildId}: ${err}`);
            return false;
        }
    }

    try {
        await db.addQuarantinedBot(guildId, botUserId, addedById, roles);
        await recordSecurityEvent(db, redis, guildId, "quarantine", botUserId, null, {
            added_by: addedById,
            roles_removed: roles.length,
        });
    } catch (err) {
        console.error(`Failed to record quarantine for ${guildId}: ${err}`);
    }

    if (roles.length > 0 || cfg.event_log) {
        await postAlert(api, db, guildId, cfg, {
            botUserId,
            botTag: `${member.user.username}#${member.user.discriminator ?? "0"}`,
            addedBy: addedById,
            restoredRoles: roles,
        });
    }
    if (roles.length > 0) console.log(styleText("yellow", `[quarantine] stripped ${roles.length} role(s) from bot ${botUserId} in ${guildId}`));
    return true;
}

/**
 * A quarantined bot got new roles before someone approved it - strip them again.
 * Called for MEMBER_ROLE_UPDATE audit entries while quarantine is enabled.
 */
export async function enforceQuarantine(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    guildId: string,
    targetUserId: string,
): Promise<boolean> {
    try {
        const row = await db.getQuarantinedBot(guildId, targetUserId);
        if (!row || row.approved_at != null) return false;

        const member = await api.guilds.getMember(guildId, targetUserId, { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (!member) return false;
        const roles = (member.roles ?? []).filter(id => id !== guildId);
        if (roles.length === 0) return false;

        await api.guilds.editMember(guildId, targetUserId, { roles: [] },
            { reason: "Bot quarantine: roles re-added before approval" });
        await db.addQuarantinedBot(guildId, targetUserId, row.added_by, [...new Set([...row.roles, ...roles])]);

        const cfg = await getSecurityConfigCached(db, guildId);
        await postAlert(api, db, guildId, cfg, {
            botUserId: targetUserId,
            botTag: targetUserId,
            addedBy: row.added_by,
            restoredRoles: roles,
            restrip: true,
        });
        console.log(styleText("yellow", `[quarantine] re-stripped bot ${targetUserId} in ${guildId}`));
        return true;
    } catch (err) {
        console.error(`Failed to re-quarantine ${targetUserId} in ${guildId}: ${err}`);
        return false;
    }
}

/** Approve a quarantined bot: give its roles back. Returns an error message or null on success. */
export async function approveQuarantine(
    api: API | API2,
    db: DbModule,
    guildId: string,
    botUserId: string,
    approvedBy: string,
): Promise<string | null> {
    const row = await db.getQuarantinedBot(guildId, botUserId);
    if (!row) return "This bot has no quarantine record (it may have been removed or already handled).";

    const member = await api.guilds.getMember(guildId, botUserId).catch(() => null);
    if (!member) {
        await db.removeQuarantinedBot(guildId, botUserId);
        return "That bot is no longer in this server - I cleaned up its quarantine record.";
    }

    const roles = await api.guilds.getRoles(guildId).catch(() => null);
    const validRoleIds = new Set((roles ?? []).map(r => r.id));
    const restorable = row.roles.filter(id => validRoleIds.has(id) && id !== guildId);

    if (restorable.length > 0) {
        try {
            await api.guilds.editMember(guildId, botUserId, { roles: restorable },
                { reason: `Bot quarantine approved by ${approvedBy}` });
        } catch (err) {
            return `I couldn't restore the roles: \`${err}\`. Check that my role is above the bot's roles.`;
        }
    }

    await db.approveQuarantinedBot(guildId, botUserId, approvedBy);
    return null;
}

/** Kick a quarantined bot. Returns an error message or null on success. */
export async function kickQuarantine(
    api: API | API2,
    db: DbModule,
    guildId: string,
    botUserId: string,
    removedBy: string,
): Promise<string | null> {
    try {
        await api.guilds.removeMember(guildId, botUserId, { reason: `Quarantined bot kicked by ${removedBy}` });
    } catch (err) {
        return `I couldn't kick the bot: \`${err}\`. Check that my role is above it and I have Kick Members.`;
    }
    await db.removeQuarantinedBot(guildId, botUserId);
    return null;
}
