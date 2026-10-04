import { Routes, type APIEmbed } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import type { SecurityConfig } from "../utils/db";
import type { DbModule } from "./config";
import { getGuildInfo } from "../utils/cache";
import { recordSecurityEvent, sendSecurityLog } from "./notify";
import {
    createBackup,
    decodeBackupData,
    findMissingStructure,
    restoreBackup,
    restoreSummary,
    type RestoreProgress,
    type RestoreResult,
} from "./backup";

/** One restore per guild at a time. */
const inFlight = new Set<string>();

/** Cached bot owners (application owner / team) - the "bot inviter" side of the approval. */
let appOwnerCache: { ids: Set<string>; at: number } | null = null;

/** Bot owners who may approve restores (env OWNER_IDS, same source as the dashboard). */
const FALLBACK_BOT_OWNERS = ["1062884939093246045", "1160672514616336456"];

function configuredBotOwners(): string[] {
    const fromEnv = (process.env.OWNER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
    return [...new Set([...FALLBACK_BOT_OWNERS, ...fromEnv])];
}

async function getBotOwners(api: API | API2): Promise<Set<string>> {
    const ids = new Set(configuredBotOwners());
    if (appOwnerCache && Date.now() - appOwnerCache.at < 10 * 60_000) {
        for (const id of appOwnerCache.ids) ids.add(id);
        return ids;
    }
    try {
        const app = await api.rest.get(Routes.oauth2CurrentApplication()) as {
            owner?: { id: string } | null;
            owners?: { id: string }[];
            team?: { members?: { user: { id: string } }[] } | null;
        };
        if (app.owner?.id) ids.add(app.owner.id);
        for (const o of app.owners ?? []) ids.add(o.id);
        for (const m of app.team?.members ?? []) ids.add(m.user.id);
        appOwnerCache = { ids, at: Date.now() };
        return ids;
    } catch (err) {
        console.error(`Failed to read application owners: ${err}`);
        return ids;
    }
}

/** Everyone allowed to approve a restore: server owner + bot owner(s). */
export async function getRestoreApprovers(api: API | API2, guildId: string, applicationId: string): Promise<string[]> {
    const ids = new Set<string>();
    try {
        const guildInfo = await getGuildInfo(api, guildId, AbortSignal.timeout(1000)).catch(() => null);
        if (guildInfo?.ownerId) ids.add(guildInfo.ownerId);
    } catch { /* guild info unavailable - bot owners still apply */ }
    for (const id of await getBotOwners(api)) ids.add(id);
    return [...ids];
}

/** Restore approvers: the server owner, or a configured bot owner. */
export async function isRestoreApprover(api: API | API2, guildId: string, userId: string, applicationId: string): Promise<boolean> {
    try {
        return (await getRestoreApprovers(api, guildId, applicationId)).includes(userId);
    } catch {
        return configuredBotOwners().includes(userId);
    }
}

// --- manual restore approval request (one open request per guild) ---

type PendingManualRestore = { requester: string; expires: number };
const pendingRestores = new Map<string, PendingManualRestore>();
export const RESTORE_REQUEST_TTL = 5 * 60_000;

export function getPendingRestore(guildId: string): PendingManualRestore | undefined {
    const pending = pendingRestores.get(guildId);
    if (pending && pending.expires < Date.now()) {
        pendingRestores.delete(guildId);
        return undefined;
    }
    return pending;
}

export function setPendingRestore(guildId: string, requester: string): void {
    pendingRestores.set(guildId, { requester, expires: Date.now() + RESTORE_REQUEST_TTL });
}

export function clearPendingRestore(guildId: string): boolean {
    return pendingRestores.delete(guildId);
}

const PHASE_LABEL: Record<RestoreProgress["phase"], string> = {
    roles: "Rebuilding roles",
    channels: "Rebuilding channels",
    members: "Repairing member roles",
    identity: "Restoring server name / icon",
    messages: "Re-posting message history",
};

export type RunRestoreOptions = {
    reason: string;
    /** Where the live progress message goes (event log channel or the approval channel). */
    channelId: string | null;
    requestedBy?: string | null;
    approvedBy?: string | null;
    /** Also refresh the snapshot afterwards (default true). */
    backupAfter?: boolean;
};

export type RunRestoreOutcome = {
    ok: boolean;
    backupId: number | null;
    result: RestoreResult | null;
    error: string | null;
};

/**
 * Runs a restore end-to-end with a live progress message, database status rows and
 * verify retries. Safe to call from both the anti-nuke response and the manual
 * approval flow - only one run per guild at a time.
 */
export async function runRestore(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    guildId: string,
    opts: RunRestoreOptions,
): Promise<RunRestoreOutcome> {
    if (inFlight.has(guildId)) {
        return { ok: false, backupId: null, result: null, error: "A restore is already running in this server." };
    }
    inFlight.add(guildId);

    let progressMessageId: string | null = null;
    let lastEdit = 0;
    let lastDbWrite = 0;
    const editProgress = async (content: string, force = false) => {
        if (!opts.channelId) return;
        const now = Date.now();
        if (!force && now - lastEdit < 1500) return;
        lastEdit = now;
        try {
            if (!progressMessageId) {
                const msg = await api.channels.createMessage(opts.channelId, { content, allowed_mentions: { parse: [] } });
                progressMessageId = msg.id;
            } else {
                await api.channels.editMessage(opts.channelId, progressMessageId, { content });
            }
        } catch (err) {
            console.error(`Restore progress message failed in ${guildId}: ${err}`);
            progressMessageId = null; // try to recreate next time
        }
    };

    const backup = await db.getLatestSecurityBackup(guildId).catch(() => null);
    if (!backup) {
        inFlight.delete(guildId);
        return { ok: false, backupId: null, result: null, error: "No snapshot available yet - the first backup runs within 10 minutes of enabling Anti-Nuke." };
    }

    const restoreId = await db.startSecurityRestore(guildId, backup.id, opts.requestedBy ?? null, opts.approvedBy ?? null);

    let result: RestoreResult | null = null;
    let error: string | null = null;

    try {
        await editProgress(`🔄 **Restore started** (snapshot #${backup.id}) - fetching backup…`, true);

        const onProgress = (p: RestoreProgress) => {
            void editProgress(`🔄 **Restore in progress** (snapshot #${backup.id}) — ${PHASE_LABEL[p.phase]}: ${p.done}/${p.total}`);
            if (restoreId != null && Date.now() - lastDbWrite > 3000) {
                lastDbWrite = Date.now();
                void db.updateSecurityRestore(restoreId, "running", p as unknown as Record<string, unknown>);
            }
        };

        result = await restoreBackup(api, backup, opts.reason, { onProgress });
        if (restoreId != null) void db.updateSecurityRestore(restoreId, "running", { phase: "verify", missing: result.missingChannels.length + result.missingRoles.length });

        // verify passes: if structure is still missing, wait and retry (twice max)
        for (let pass = 1; pass <= 2; pass++) {
            if (result.missingChannels.length === 0 && result.missingRoles.length === 0) break;
            await editProgress(`🔁 **Verify pass ${pass}/2** - ${result.missingChannels.length + result.missingRoles.length} item(s) missing, retrying in 45s…`, true);
            await new Promise(r => setTimeout(r, 45_000));
            const missing = await findMissingStructure(api, guildId, backup.data).catch(() => null);
            if (!missing || (missing.channels.length === 0 && missing.roles.length === 0)) break;
            const retry = await restoreBackup(api, backup, opts.reason);
            result.missingChannels = retry.missingChannels;
            result.missingRoles = retry.missingRoles;
            result.channelsCreated.push(...retry.channelsCreated);
            result.rolesCreated.push(...retry.rolesCreated);
            result.membersFixed += retry.membersFixed;
            result.messagesRestored += retry.messagesRestored;
            result.messageChannels += retry.messageChannels;
            result.errors.push(...retry.errors);
            if (retry.identityRestored) result.identityRestored = true;
        }

        const done = result.missingChannels.length === 0 && result.missingRoles.length === 0;
        if (restoreId != null) await db.finishSecurityRestore(restoreId, done ? "done" : "partial", {
            channels: result.channelsCreated.length,
            roles: result.rolesCreated.length,
            members_fixed: result.membersFixed,
            messages: result.messagesRestored,
            missing: result.missingChannels.length + result.missingRoles.length,
        });

        const summary = restoreSummary(result);
        await editProgress(
            `✅ **Restore ${done ? "finished" : "finished with gaps"}** (snapshot #${backup.id})\n${summary}`,
            true,
        );

        await recordSecurityEvent(db, redis, guildId, "restore", opts.approvedBy ?? opts.requestedBy ?? null, null, {
            backup_id: backup.id,
            channels: result.channelsCreated.length,
            roles: result.rolesCreated.length,
            members_fixed: result.membersFixed,
            messages: result.messagesRestored,
            missing: result.missingChannels.length + result.missingRoles.length,
            trigger: opts.reason.startsWith("Anti-nuke") ? "anti_nuke" : "manual",
        });

        // keep a fresh snapshot of the restored state
        if (opts.backupAfter !== false) {
            await createBackup(api, db, guildId, "post restore snapshot").catch(() => null);
        }

        return { ok: true, backupId: backup.id, result, error: null };
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`Restore failed in ${guildId}: ${error}`);
        if (restoreId != null) await db.finishSecurityRestore(restoreId, "failed", { error: error.slice(0, 200) });
        await editProgress(`❌ **Restore failed** (snapshot #${backup.id}): ${error.slice(0, 300)}`, true);
        return { ok: false, backupId: backup.id, result, error };
    } finally {
        inFlight.delete(guildId);
    }
}

/** Status line for the /security embed. */
export async function restoreStatusLine(db: DbModule, guildId: string): Promise<string | null> {
    const row = await db.getLatestSecurityRestore(guildId).catch(() => null);
    if (!row) return null;
    const age = Math.max(0, Math.floor(Date.now() / 1000 - row.started_at));
    const ago = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
    const icon = row.status === "done" ? "✅" : row.status === "failed" ? "❌" : row.status === "partial" ? "⚠️" : "🔄";
    return `${icon} Last restore: **${row.status}** ${ago} ago (backup #${row.backup_id ?? "?"})`;
}

/** Post the restore result into the event log (used by the manual flow). */
export async function logRestoreResult(
    api: API | API2,
    db: DbModule,
    guildId: string,
    cfg: SecurityConfig | null,
    outcome: RunRestoreOutcome,
    byUserId: string,
): Promise<void> {
    const embed: APIEmbed = {
        title: outcome.ok ? "♻️ Manual restore completed" : "❌ Manual restore failed",
        color: outcome.ok ? 0x57f287 : 0xf04747,
        description: outcome.ok && outcome.result
            ? `**Requested by:** <@${byUserId}>\n**Snapshot:** #${outcome.backupId}\n${restoreSummary(outcome.result)}`
            : `**Requested by:** <@${byUserId}>\n**Error:** ${outcome.error ?? "unknown error"}`,
        timestamp: new Date().toISOString(),
        footer: { text: "Honeypot restore" },
    };
    const logged = await sendSecurityLog(api, db, guildId, cfg, embed);
    if (!logged) console.log(`[restore] ${guildId}: ${embed.title} - ${embed.description?.replace(/\n/g, " | ")}`);
}
