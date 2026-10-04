import { AuditLogEvent, ButtonStyle, ComponentType, Routes, type APIEmbed, type APIUser } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { styleText } from "node:util";
import { getGuildInfo } from "../utils/cache";
import { getDiscordDate } from "../utils/tools";
import type { SecurityConfig } from "../utils/db";
import { getSecurityConfigCached, type DbModule } from "./config";
import { recordSecurityEvent, sendSecurityLog } from "./notify";
import { fetchAuditLogEntries } from "./audit-log";
import { createBackup, restoreSummary } from "./backup";
import { clearPendingRestore, getRestoreApprovers, isRestoreApprover, isRestoreInFlight, runRestore } from "./restore-run";
import { hasRecentStructureDeletion, noteStructureDeletion } from "./structure-state";

type StructureKind = "channel" | "role";

const WINDOW_MS = 60_000;
const REQUEST_TTL = 5 * 60_000;

/** Deletions performed by members holding one of these roles are never treated as a nuke. */
const TRUSTED_ROLES = new Set(
    (process.env.ANTI_NUKE_TRUSTED_ROLES ?? "").split(",").map(s => s.trim()).filter(Boolean),
);

const deleteWindows = new Map<string, number[]>(); // guild id -> recent deletion timestamps (all kinds)
const memoryLocks = new Map<string, number>();

/** Mass channel creation: snapshot + alert threshold (own throttle, never borrows the delete-response lock). */
const CREATE_THRESHOLD = 3;
const CREATE_COOLDOWN_MS = 10 * 60_000;
const createWindows = new Map<string, number[]>(); // guild id -> recent channel-create timestamps
const createCooldowns = new Map<string, number>(); // guild id -> next time a snapshot alert may fire

/** An open "possible nuke" approval request. While one is live, the next deletion escalates. */
type PendingNuke = {
    kind: StructureKind;
    executor: { id: string; bot: boolean; tag: string } | null;
    count: number;
    expires: number;
    channel_id: string;
    message_id: string;
};
const pendingNukes = new Map<string, PendingNuke>();

/** Push a deletion into the per-guild 60s window and report how many happened in it. */
function recordStructureDeletion(guildId: string): number {
    const now = Date.now();
    const timestamps = (deleteWindows.get(guildId) ?? []).filter(t => now - t < WINDOW_MS);
    timestamps.push(now);
    if (deleteWindows.size > 10_000) {
        for (const [k, v] of deleteWindows) if (v.every(t => now - t > WINDOW_MS)) deleteWindows.delete(k);
    }
    deleteWindows.set(guildId, timestamps);
    return timestamps.length;
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

/** Who deleted it? Audit log entry + user lookup (bot flag, username). */
async function resolveExecutor(
    api: API | API2,
    guildId: string,
    kind: StructureKind,
): Promise<{ id: string; bot: boolean; tag: string } | null> {
    try {
        const auditAction = kind === "channel" ? AuditLogEvent.ChannelDelete : AuditLogEvent.RoleDelete;
        const entries = await fetchAuditLogEntries(api, guildId, { action_type: auditAction, limit: 10 });
        const recent = entries.find(e => Date.now() - getDiscordDate(e.id) < 120_000 && e.user_id);
        if (!recent?.user_id) return null;
        let bot = false;
        let tag = recent.user_id;
        try {
            const user = await api.rest.get(Routes.user(recent.user_id)) as APIUser;
            bot = !!user.bot;
            tag = user.username;
        } catch { /* executor stays usable without the lookup */ }
        return { id: recent.user_id, bot, tag };
    } catch (err) {
        console.error(`Failed to read audit log during anti-nuke in ${guildId}: ${err}`);
        return null;
    }
}

/** Members holding a whitelisted role may delete freely - never treated as a nuke. */
async function isTrustedExecutor(api: API | API2, guildId: string, userId: string): Promise<boolean> {
    if (TRUSTED_ROLES.size === 0) return false;
    try {
        const member = await api.guilds.getMember(guildId, userId);
        return (member.roles ?? []).some(r => TRUSTED_ROLES.has(r));
    } catch {
        return false; // left the server or lookup failed -> cannot confirm trust
    }
}

/** Who created channels recently? Newest ChannelCreate audit entry (null = unknown). */
async function resolveCreateExecutor(api: API | API2, guildId: string): Promise<string | null> {
    try {
        const entries = await fetchAuditLogEntries(api, guildId, { action_type: AuditLogEvent.ChannelCreate, limit: 10 });
        const recent = entries.find(e => Date.now() - getDiscordDate(e.id) < 120_000 && e.user_id);
        return recent?.user_id ?? null;
    } catch {
        return null;
    }
}

/**
 * Called from ChannelDelete / RoleDelete.
 *  - first deletion: posts an approval request (nothing is changed yet) - a deliberate
 *    cleanup must not trigger the response by itself
 *  - structure keeps disappearing while the request is open: intervenes IMMEDIATELY
 *    (strip + restore) without waiting for anyone's approval
 */
export async function handleStructureDelete(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    applicationId: string,
    guildId: string,
    kind: StructureKind,
) {
    // note the deletion for EVERY guild (before the anti-nuke check): auto-snapshots
    // must stand back while structure is missing, or they would replace the good
    // restore point with the damaged state (backup-only guilds included)
    noteStructureDeletion(guildId);
    try {
        const cfg = await getSecurityConfigCached(db, guildId);
        if (!cfg?.anti_nuke) return;

        const executor = await resolveExecutor(api, guildId, kind);

        // our own maintenance (channel recreate experiment etc) - never fight ourselves
        if (executor?.id === applicationId) return;
        // whitelisted roles may delete structure on purpose
        if (executor && (await isTrustedExecutor(api, guildId, executor.id))) return;

        const count = recordStructureDeletion(guildId);

        let pending = pendingNukes.get(guildId) ?? null;
        if (pending && pending.expires < Date.now()) {
            pendingNukes.delete(guildId);
            pending = null;
        }

        // escalation: structure keeps disappearing -> act NOW, no approval round-trip
        if (count >= 2) {
            if (!(await acquireLock(guildId, redis))) return;
            await respondToNuke(api, db, redis, applicationId, guildId, kind, cfg, "escalate", executor, count);
            return;
        }

        // first deletion: ask before touching anything (a deliberate cleanup must not trigger us)
        if (!pending) {
            if (!(await acquireLock(guildId, redis))) return;
            await respondToNuke(api, db, redis, applicationId, guildId, kind, cfg, "request", executor, count);
            return;
        }
        // a request is already open and nothing new happened - let it stand
    } catch (err) {
        console.error(`Anti-nuke handler failed in ${guildId}: ${err}`);
    }
}

/**
 * Called from ChannelCreate. Anti-nuke needs a restore point BEFORE a raid fills the
 * server with channels: when 3+ channels appear within 60s, snapshot immediately
 * (the original channels still exist at that point) and alert the event log.
 *
 * Guards (in order): never during our own restore, never right after deletions
 * (the deletion side owns the restore + the good snapshot), never when the
 * creator is this bot. Runs on its own cooldown - it must not borrow the 120s
 * delete-response lock.
 */
export async function handleChannelCreate(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    applicationId: string,
    guildId: string,
) {
    try {
        const cfg = await getSecurityConfigCached(db, guildId);
        if (!cfg?.anti_nuke) return;

        const now = Date.now();
        if ((createCooldowns.get(guildId) ?? 0) > now) return;
        // our own recreations happen mid-restore: the post-restore snapshot covers them
        if (isRestoreInFlight(guildId)) return;

        const stamps = (createWindows.get(guildId) ?? []).filter(t => now - t < WINDOW_MS);
        stamps.push(now);
        createWindows.set(guildId, stamps);
        if (stamps.length < CREATE_THRESHOLD) return;
        createWindows.delete(guildId); // consume the batch - every path below resets it

        // recent deletions: the restore is running (or about to) from the GOOD snapshot -
        // snapshotting the damaged state now would replace it (only one is kept)
        if (hasRecentStructureDeletion(guildId)) {
            console.log(styleText("dim", `[anti-nuke] ${guildId}: channel creations after a deletion - skipping extra snapshot`));
            return;
        }
        // creators that are this bot (restore recreations that outlived the restore run)
        const creator = await resolveCreateExecutor(api, guildId);
        if (creator && creator === applicationId) {
            console.log(styleText("dim", `[anti-nuke] ${guildId}: own channel recreation - skipping mass-create response`));
            return;
        }

        createCooldowns.set(guildId, now + CREATE_COOLDOWN_MS);

        const result = await createBackup(api, db, guildId, "mass channel creation detected (anti-nuke)");
        const embed: APIEmbed = {
            title: "🆕 Mass channel creation detected",
            color: 0xfaa61a,
            description: [
                `**Detected:** ${CREATE_THRESHOLD}+ channels created within ${WINDOW_MS / 1000}s.`,
                result
                    ? `**Snapshot:** #${result.id} saved right now (${result.channels} channels, ${result.messages} messages) - later deletions can be restored from it.`
                    : "**Snapshot:** nothing new to store (the current state is already captured).",
                "If structure starts disappearing from the same actor, the approval flow takes over.",
            ].join("\n"),
            timestamp: new Date().toISOString(),
            footer: { text: "Honeypot anti-nuke" },
        };
        const logged = await sendSecurityLog(api, db, guildId, cfg, embed);
        if (!logged) {
            const honeypot = await db.getConfig(guildId).catch(() => null);
            if (honeypot?.log_channel_id) {
                await api.channels.createMessage(honeypot.log_channel_id, { embeds: [embed], allowed_mentions: { parse: [] } }).catch(() => { });
            }
        }
        await recordSecurityEvent(db, redis, guildId, "anti_nuke", null, null, { stage: "mass_create" });
        console.log(styleText("yellow", `[anti-nuke] ${guildId}: mass channel creation detected - snapshot ${result ? `#${result.id}` : "unchanged"}`));
    } catch (err) {
        console.error(`Anti-nuke channel-create hook failed in ${guildId}: ${err}`);
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
    mode: "request" | "escalate",
    executor: { id: string; bot: boolean; tag: string } | null,
    count: number,
) {
    try {
        const latestBackup = await db.getLatestSecurityBackup(guildId).catch(() => null);

        // ---- approval request (false-positive guard, nothing is changed yet) ----
        if (mode === "request") {
            const honeypot = await db.getConfig(guildId).catch(() => null);
            const targetChannel = cfg.event_log_channel_id ?? honeypot?.log_channel_id ?? null;

            if (!targetChannel) {
                // nobody could approve -> fall through to the full automatic response
                console.log(styleText("yellow", `[anti-nuke] ${guildId}: no channel for an approval request - responding automatically`));
            } else {
                const approvers = await getRestoreApprovers(api, guildId, applicationId).catch(() => []);
                const ping = approvers.find(id => id !== executor?.id) ?? approvers[0] ?? null;
                const embed: APIEmbed = {
                    title: "👀 Possible nuke - approval needed",
                    color: 0xfaa61a,
                    description: [
                        `**Executor:** ${executor ? `<@${executor.id}> (\`${executor.tag}\`${executor.bot ? ", bot" : ""})` : "could not be determined from the audit log"}`,
                        `**Detected:** ${count} structure deletion(s) within ${WINDOW_MS / 1000}s (${kind})`,
                        `**Snapshot:** #${latestBackup?.id ?? "?"} - nothing has been changed yet.`,
                        "",
                        `**Approve** = strip the executor and restore from the snapshot.`,
                        `**Dismiss** = restore the structure, but do NOT punish the executor.`,
                        `If structure keeps disappearing, I will intervene **immediately** without waiting for approval.`,
                    ].join("\n"),
                    timestamp: new Date().toISOString(),
                    footer: { text: `Honeypot anti-nuke - only server/bot owner can act - expires in ${REQUEST_TTL / 60_000} min` },
                };
                try {
                    const msg = await api.channels.createMessage(targetChannel, {
                        embeds: [embed],
                        components: [{
                            type: ComponentType.ActionRow,
                            components: [
                                { type: ComponentType.Button, style: ButtonStyle.Success, label: "Approve response", emoji: { name: "✅" }, custom_id: "nuke_ok" },
                                { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Dismiss", emoji: { name: "✖️" }, custom_id: "nuke_no" },
                            ],
                        }],
                        allowed_mentions: ping ? { users: [ping] } : { parse: [] },
                    });
                    pendingNukes.set(guildId, {
                        kind,
                        executor,
                        count,
                        expires: Date.now() + REQUEST_TTL,
                        channel_id: targetChannel,
                        message_id: msg.id,
                    });
                    await recordSecurityEvent(db, redis, guildId, "anti_nuke", executor?.id ?? null, null, {
                        stage: "approval_pending",
                        kind,
                        count,
                    });
                    console.log(styleText("yellow", `[anti-nuke] ${guildId}: possible ${kind} nuke - approval requested (executor: ${executor?.id ?? "unknown"})`));
                    return;
                } catch (err) {
                    console.error(`Anti-nuke approval request failed in ${guildId}: ${err}`);
                    pendingNukes.delete(guildId);
                    // fall through: if we cannot ask, we must protect
                }
            }
        }

        // ---- full automatic response: neutralize the attacker ----
        const openRequest = pendingNukes.get(guildId) ?? null;
        pendingNukes.delete(guildId);
        clearPendingRestore(guildId); // a stale manual restore request is superseded
        if (openRequest) await retireRequestMessage(api, openRequest);

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
        let backupId = latestBackup?.id ?? 0;
        try {
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
            `**Trigger:** ${count}+ structure deletion(s) within ${WINDOW_MS / 1000}s (${kind})`,
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
                    : "**Restore:** no automatic snapshot yet (the first one is taken right after enabling Anti-Nuke, then every 10-60 minutes)",
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
    } finally {
        releaseLock(guildId, redis);
    }
}

/** Remove the buttons from an open approval message. */
async function retireRequestMessage(api: API | API2, pending: PendingNuke): Promise<void> {
    try {
        await api.channels.editMessage(pending.channel_id, pending.message_id, { components: [] });
    } catch { /* message already deleted or edited */ }
}

/**
 * Approval / dismiss buttons of the "possible nuke" request (handled from interactions).
 * Returns a short status string for the ephemeral reply.
 */
export async function handleNukeApproval(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    applicationId: string,
    guildId: string,
    userId: string,
    approve: boolean,
): Promise<string> {
    const pending = pendingNukes.get(guildId);
    if (!pending) return "There is no open nuke response request.";
    if (pending.expires < Date.now()) {
        pendingNukes.delete(guildId);
        await retireRequestMessage(api, pending);
        return "The request has expired.";
    }
    if (!(await isRestoreApprover(api, guildId, userId, applicationId).catch(() => false))) {
        return "❌ Only the **server owner** or a **bot owner** can decide this.\n-# That keeps an attacker from approving (or cancelling) the response themselves.";
    }

    pendingNukes.delete(guildId);
    await retireRequestMessage(api, pending);

    if (!approve) {
        // false alarm: nobody gets punished, but the deleted structure still comes back
        deleteWindows.delete(guildId);
        if (!(await acquireLock(guildId, redis))) return "A response is already running - try again in a moment.";
        try {
            const cfg = await getSecurityConfigCached(db, guildId);
            if (!cfg?.anti_nuke) return "Anti-Nuke has been switched off in the meantime.";

            const backup = await db.getLatestSecurityBackup(guildId).catch(() => null);
            if (!backup) {
                await recordSecurityEvent(db, redis, guildId, "anti_nuke", userId, null, { stage: "dismissed", kind: pending.kind });
                return "✅ Dismissed - the executor is not punished. No snapshot exists yet, so nothing can be restored.";
            }

            const outcome = await runRestore(api, db, redis, guildId, {
                reason: `Restore after dismissed nuke request (backup #${backup.id})`,
                channelId: cfg.event_log_channel_id ?? null,
                requestedBy: pending.executor?.id ?? null,
                approvedBy: userId,
                backupAfter: true,
            });

            const embed: APIEmbed = {
                title: "♻️ Structure restored (dismissed request)",
                color: 0x57f287,
                description: [
                    `**Dismissed by:** <@${userId}> - the deletions are treated as intentional, the executor is **not** punished.`,
                    `**Executor:** ${pending.executor ? `<@${pending.executor.id}> (\`${pending.executor.tag}\`)` : "unknown"}`,
                    outcome.ok && outcome.result
                        ? `**Snapshot:** #${outcome.backupId}\n${restoreSummary(outcome.result)}`
                        : `**Restore failed:** ${outcome.error ?? "unknown error"}`,
                ].join("\n"),
                timestamp: new Date().toISOString(),
                footer: { text: "Honeypot anti-nuke" },
            };
            const logged = await sendSecurityLog(api, db, guildId, cfg, embed);
            if (!logged) {
                // same fallback as the triggered response: never lose the result silently
                try {
                    const honeypot = await db.getConfig(guildId);
                    if (honeypot?.log_channel_id) {
                        await api.channels.createMessage(honeypot.log_channel_id, { embeds: [embed], allowed_mentions: { parse: [] } });
                    } else {
                        console.log(`[anti-nuke] ${guildId}: dismissed -> ${outcome.ok ? "restored" : "restore failed"}`);
                    }
                } catch {
                    console.log(`[anti-nuke] ${guildId}: dismissed -> ${outcome.ok ? "restored" : "restore failed"}`);
                }
            }

            await recordSecurityEvent(db, redis, guildId, "anti_nuke", userId, null, { stage: "dismissed", kind: pending.kind });
            return outcome.ok
                ? "✅ Dismissed - the executor stays untouched, restoring the structure now (progress in the event log)."
                : `✅ Dismissed - but the restore failed: ${(outcome.error ?? "unknown error").slice(0, 150)}`;
        } finally {
            releaseLock(guildId, redis);
        }
    }

    if (!(await acquireLock(guildId, redis))) return "A response is already running.";
    const cfg = await getSecurityConfigCached(db, guildId);
    if (!cfg?.anti_nuke) {
        releaseLock(guildId, redis);
        return "Anti-Nuke has been switched off in the meantime.";
    }
    await respondToNuke(api, db, redis, applicationId, guildId, pending.kind, cfg, "escalate", pending.executor, pending.count);
    return "🚀 Response approved - stripping the executor and restoring from the snapshot.";
}
