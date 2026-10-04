import { AuditLogEvent, Routes, type APIEmbed, type APIUser } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { styleText } from "node:util";
import { getGuildInfo } from "../utils/cache";
import { getDiscordDate } from "../utils/tools";
import type { SecurityConfig } from "../utils/db";
import { getSecurityConfigCached, type DbModule } from "./config";
import { recordSecurityEvent, sendSecurityLog } from "./notify";
import { fetchAuditLogEntries } from "./audit-log";
import { restoreSummary } from "./backup";
import { runRestore } from "./restore-run";

type StructureKind = "channel" | "role";

const TRIGGER: Record<StructureKind, { threshold: number; windowMs: number }> = {
    channel: { threshold: 3, windowMs: 60_000 },
    role: { threshold: 5, windowMs: 60_000 },
};

const deleteWindows = new Map<string, number[]>();
const memoryLocks = new Map<string, number>();

/** Push a deletion into the per-guild window and report whether the threshold was crossed. */
function recordDeletion(guildId: string, kind: StructureKind): boolean {
    const { threshold, windowMs } = TRIGGER[kind];
    const now = Date.now();
    const key = `${guildId}:${kind}`;
    const timestamps = (deleteWindows.get(key) ?? []).filter(t => now - t < windowMs);
    timestamps.push(now);
    if (deleteWindows.size > 10_000) {
        for (const [k, v] of deleteWindows) if (v.every(t => now - t > windowMs)) deleteWindows.delete(k);
    }
    deleteWindows.set(key, timestamps);
    return timestamps.length >= threshold;
}

/** Only one anti-nuke response per guild at a time (works across replicas when redis is present). */
async function acquireLock(guildId: string, redis?: Bun.RedisClient | null): Promise<boolean> {
    if (redis) {
        try {
            const result = await redis.hsetex("anti_nuke_lock", "FNX", "EX", 120, "FIELDS", 1, guildId, "true");
            return Number(result) !== 0; // 0 == already locked
        } catch (err) {
            console.error(`Anti-nuke lock failed, using memory: ${err}`);
        }
    }
    const expires = memoryLocks.get(guildId) ?? 0;
    if (expires > Date.now()) return false;
    memoryLocks.set(guildId, Date.now() + 120_000);
    return true;
}

function releaseLock(guildId: string, redis?: Bun.RedisClient | null) {
    if (redis) Promise.resolve(redis.hdel("anti_nuke_lock", guildId)).catch(() => { });
    memoryLocks.delete(guildId);
}

/**
 * Called from ChannelDelete / RoleDelete. Watches how fast structure disappears,
 * identifies the executor in the audit log, strips them and restores from the latest backup.
 */
export async function handleStructureDelete(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    applicationId: string,
    guildId: string,
    kind: StructureKind,
) {
    try {
        const cfg = await getSecurityConfigCached(db, guildId);
        if (!cfg?.anti_nuke) return;

        if (!recordDeletion(guildId, kind)) return;
        if (!(await acquireLock(guildId, redis))) return;

        await respondToNuke(api, db, redis, applicationId, guildId, kind, cfg);
    } catch (err) {
        console.error(`Anti-nuke handler failed in ${guildId}: ${err}`);
    }
}

async function respondToNuke(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    applicationId: string,
    guildId: string,
    kind: StructureKind,
    cfg: SecurityConfig,
) {
    const auditAction = kind === "channel" ? AuditLogEvent.ChannelDelete : AuditLogEvent.RoleDelete;

    // ---- who did it? ----
    let executor: { id: string; bot: boolean; tag: string } | null = null;
    try {
        const entries = await fetchAuditLogEntries(api, guildId, { action_type: auditAction, limit: 10 });
        const recent = entries.find(e => Date.now() - getDiscordDate(e.id) < 120_000 && e.user_id);
        if (recent?.user_id) {
            // the audit log only carries the id - resolve bot flag + username
            let bot = false;
            let tag = recent.user_id;
            try {
                const user = await api.rest.get(Routes.user(recent.user_id)) as APIUser;
                bot = !!user.bot;
                tag = user.username;
            } catch { /* executor stays usable without the lookup */ }
            executor = { id: recent.user_id, bot, tag };
        }
    } catch (err) {
        console.error(`Failed to read audit log during anti-nuke in ${guildId}: ${err}`);
    }

    // our own maintenance (channel recreate experiment etc) - never fight ourselves
    if (executor && executor.id === applicationId) {
        releaseLock(guildId, redis);
        return;
    }

    // ---- neutralize the attacker ----
    let neutralized = false;
    let neutralizeError: string | null = null;
    if (executor && executor.id !== applicationId && cfg.anti_nuke_action !== "alert") {
        const guildInfo = await getGuildInfo(api, guildId, AbortSignal.timeout(1000), redis).catch(() => null);
        const isOwner = guildInfo?.ownerId === executor.id;

        if (!isOwner) {
            const reason = `Anti-nuke: suspected ${kind} nuke`;
            if (executor.bot) {
                await api.guilds.removeMember(guildId, executor.id, { reason })
                    .then(() => { neutralized = true; })
                    .catch(err => { neutralizeError = `kicking the bot failed: ${err}`; });
            } else {
                await api.guilds.editMember(guildId, executor.id, { roles: [] }, { reason })
                    .then(() => { neutralized = true; })
                    .catch(err => { neutralizeError = `removing their roles failed: ${err}`; });

                if (cfg.anti_nuke_action === "strip_ban") {
                    await api.guilds.banUser(guildId, executor.id, { delete_message_seconds: 3600 }, { reason })
                        .then(() => { neutralized = true; })
                        .catch(err => { neutralizeError = `banning them failed: ${err}`; });
                }
            }
        } else {
            neutralizeError = "the executor is the server owner - I can't touch them";
        }
    }

    // ---- restore the structure (live progress message + verify passes + fresh snapshot) ----
    let outcome = null as Awaited<ReturnType<typeof runRestore>> | null;
    let backupId = 0;
    try {
        const latest = await db.getLatestSecurityBackup(guildId).catch(() => null);
        backupId = latest?.id ?? 0;
        outcome = await runRestore(api, db, redis, guildId, {
            reason: `Anti-nuke restore (backup #${backupId || "?"})`,
            channelId: cfg.event_log_channel_id ?? null,
            requestedBy: executor?.id ?? null,
            approvedBy: executor?.id ?? null,
            backupAfter: true,
        });
        if (outcome && !outcome.ok && outcome.error?.startsWith("No snapshot")) outcome = null;
    } catch (err) {
        console.error(`Anti-nuke restore failed in ${guildId}: ${err}`);
    }
    const restored = outcome?.ok ? outcome.result : null;
    if (outcome && outcome.backupId) backupId = outcome.backupId;

    // ---- report ----
    const didWork = neutralized || (restored && (restored.channelsCreated.length > 0 || restored.rolesCreated.length > 0));
    const lines = [
        `**Trigger:** ${TRIGGER[kind].threshold}+ ${kind}s deleted within ${TRIGGER[kind].windowMs / 1000}s`,
        executor
            ? `**Executor:** <@${executor.id}> (\`${executor.tag}\`${executor.bot ? ", bot" : ""})`
            : "**Executor:** could not be determined from the audit log",
        neutralized
            ? `**Action:** ${executor?.bot ? "Bot kicked" : "All roles removed"}${cfg.anti_nuke_action === "strip_ban" ? " + banned" : ""}`
            : neutralizeError
                ? `**Action:** ${neutralizeError}`
                : `**Action:** ${cfg.anti_nuke_action === "alert" ? "alert only (anti-nuke response is set to *alert*)" : "no action taken"}`,
        restored
            ? `**Restore:** ${restored.channelsCreated.length} channel(s), ${restored.rolesCreated.length} role(s) recreated from backup #${backupId} — ${restored.membersFixed} member role fix(es), ${restored.messagesRestored} message(s) re-posted\n${restoreSummary(restored)}`
            : outcome && outcome.error
                ? `**Restore failed:** ${outcome.error}`
                : "**Restore:** no automatic snapshot yet (the first one is taken within ~10 minutes of enabling Anti-Nuke)",
    ];

    const embed: APIEmbed = {
        title: "🚨 Anti-nuke triggered",
        color: 0xf04747,
        description: lines.join("\n"),
        timestamp: new Date().toISOString(),
        footer: { text: "Honeypot anti-nuke" },
    };

    const logged = await sendSecurityLog(api, db, guildId, cfg, embed);
    if (!logged) {
        // still alert somewhere when the event log module is off
        try {
            const honeypot = await db.getConfig(guildId);
            if (honeypot?.log_channel_id) {
                await api.channels.createMessage(honeypot.log_channel_id, {
                    embeds: [embed],
                    allowed_mentions: { parse: [] },
                });
            } else {
                console.error(styleText("red", `[anti-nuke] ${guildId}: no log channel available - ${lines.join(" | ")}`));
            }
        } catch (err) {
            console.error(`[anti-nuke] failed to alert in ${guildId}: ${err}`);
        }
    }

    await recordSecurityEvent(db, redis, guildId, "anti_nuke", executor?.id ?? null, null, {
        kind,
        neutralized,
        restored_channels: restored?.channelsCreated.length ?? 0,
        restored_roles: restored?.rolesCreated.length ?? 0,
        restored_members: restored?.membersFixed ?? 0,
        restored_messages: restored?.messagesRestored ?? 0,
    });
    // (the "restore" incident + post-restore snapshot are recorded by runRestore itself)

    console.log(styleText("red", `[anti-nuke] ${guildId}: ${kind} nuke${didWork ? " stopped" : " detected"} (executor: ${executor?.id ?? "unknown"})`));

    releaseLock(guildId, redis);
}
