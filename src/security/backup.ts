import {
    ChannelType,
    Routes,
    type APIMessage,
    type APIChannel,
    type APIRole,
    type RESTGetAPIGuildChannelsResult,
    type RESTPatchAPIGuildJSONBody,
    type RESTPostAPIGuildChannelJSONBody,
    type Snowflake,
} from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import type { SecurityBackupRow } from "../utils/db";
import type { DbModule } from "./config";

export type BackupChannel = {
    id: string;
    name: string;
    type: number;
    position: number;
    parent_id: string | null;
    topic?: string | null;
    nsfw?: boolean;
    rate_limit_per_user?: number;
    user_limit?: number;
    bitrate?: number;
    rtc_region?: string | null;
    permission_overwrites: { id: string; type: number; allow: string; deny: string }[];
};

export type BackupRole = {
    id: string;
    name: string;
    color: number;
    permissions: string;
    hoist: boolean;
    mentionable: boolean;
    position: number;
};

/** A single captured message - re-posted verbatim (author name + pfp) through a webhook on restore. */
export type BackupMessage = {
    c: string; // content
    a: string; // author display name
    av: string | null; // author avatar url (or default avatar)
};

export type BackupMember = {
    id: string;
    r: string[]; // role ids
};

export type BackupData = {
    version: 2;
    guild: { name: string; icon: string | null };
    channels: BackupChannel[];
    roles: BackupRole[];
    members: BackupMember[];
    messages: Record<string, BackupMessage[]>; // channel id -> oldest first
};

type PermissiveChannel = Partial<{
    topic: string | null;
    nsfw: boolean;
    rate_limit_per_user: number;
    user_limit: number;
    bitrate: number;
    rtc_region: string | null;
    position: number;
    parent_id: string | null;
    name: string;
    permission_overwrites: { id: string; type: number | string; allow: string; deny: string }[];
}> & Partial<APIChannel>;

type LiveChannel = RESTGetAPIGuildChannelsResult[number];

/** Sanity cap for the raw JSON before compression. */
const MAX_BACKUP_RAW = 2_000_000;
/** Stored size cap after gzip (fits comfortably in TEXT columns, sqlite/postgres have no practical limit). */
const MAX_BACKUP_STORED = 400_000;
/** How many messages to capture per text channel (BACKUP_MESSAGES=0 disables message history). */
function messageLimit(): number {
    const v = Number(process.env.BACKUP_MESSAGES);
    if (!Number.isFinite(v) || v < 0) return 30;
    return Math.min(50, Math.floor(v));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function compress(json: string): string {
    const bytes = Bun.gzipSync(new TextEncoder().encode(json));
    return "gz:" + Buffer.from(bytes).toString("base64");
}

function decompress(stored: string): string {
    const bytes = Bun.gunzipSync(Buffer.from(stored.slice(3), "base64"));
    return new TextDecoder().decode(bytes);
}

/** Decompress a stored row to its plain JSON text (legacy rows are stored uncompressed). */
export function backupRawToPlain(raw: string): string {
    return raw.startsWith("gz:") ? decompress(raw) : raw;
}

/** Decode any backup row (v1 legacy or v2 gzip) into a full BackupData with safe defaults. */
export function decodeBackupData(raw: string): BackupData {
    const parsed = JSON.parse(backupRawToPlain(raw)) as Partial<BackupData> & { version?: number };
    return {
        version: 2,
        guild: parsed.guild ?? { name: "", icon: null },
        channels: parsed.channels ?? [],
        roles: parsed.roles ?? [],
        members: parsed.members ?? [],
        messages: parsed.messages ?? {},
    };
}

function defaultAvatar(userId: string): string {
    try {
        const idx = Number((BigInt(userId) >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    } catch {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }
}

function authorAvatar(author: APIMessage["author"]): string {
    if (author.avatar) return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
    return defaultAvatar(author.id);
}

function errMsg(err: unknown): string {
    const s = err instanceof Error ? err.message : String(err);
    return s.length > 180 ? s.slice(0, 177) + "..." : s;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (i < items.length) {
            const idx = i++;
            await fn(items[idx]!);
        }
    });
    await Promise.all(workers);
}

/** All members that have at least one role (paginated, capped at 10k). */
async function fetchMembersWithRoles(api: API | API2, guildId: string): Promise<BackupMember[]> {
    const out: BackupMember[] = [];
    let after = "0";
    for (let page = 0; page < 10 && out.length < 10_000; page++) {
        const batch = await api.guilds.getMembers(guildId, { limit: 1000, after });
        for (const m of batch) {
            if (m.user && m.roles?.length) out.push({ id: m.user.id, r: m.roles });
        }
        if (batch.length < 1000) break;
        after = batch[batch.length - 1]!.user!.id;
    }
    return out;
}

function splitContent(text: string): string[] {
    const t = text.length > 6000 ? text.slice(0, 6000) : text;
    if (t.length <= 2000) return [t];
    const parts: string[] = [];
    let cur = "";
    for (const line of t.split("\n")) {
        if (cur && cur.length + 1 + line.length > 2000) {
            parts.push(cur);
            cur = line;
        } else {
            cur = cur ? cur + "\n" + line : line;
        }
        if (cur.length > 2000) {
            parts.push(cur.slice(0, 2000));
            cur = "";
        }
    }
    if (cur) parts.push(cur);
    return parts.filter((s) => s.length > 0);
}

export function serializeChannels(channels: RESTGetAPIGuildChannelsResult): BackupChannel[] {
    return channels.map((raw) => {
        const c = raw as PermissiveChannel;
        return {
            id: c.id ?? "",
            name: c.name ?? "",
            type: c.type ?? 0,
            position: c.position ?? 0,
            parent_id: c.parent_id ?? null,
            topic: c.topic ?? null,
            nsfw: c.nsfw ?? undefined,
            rate_limit_per_user: c.rate_limit_per_user ?? undefined,
            user_limit: c.user_limit ?? undefined,
            bitrate: c.bitrate ?? undefined,
            rtc_region: c.rtc_region ?? undefined,
            permission_overwrites: (c.permission_overwrites ?? []).map(o => ({
                id: o.id,
                type: typeof o.type === "string" ? (o.type === "role" ? 0 : 1) : o.type,
                allow: o.allow,
                deny: o.deny,
            })),
        };
    });
}

export function serializeRoles(roles: APIRole[]): BackupRole[] {
    return roles.map(r => ({
        id: r.id,
        name: r.name,
        color: typeof r.color === "number" ? r.color : 0,
        permissions: r.permissions,
        hoist: !!r.hoist,
        mentionable: !!r.mentionable,
        position: r.position ?? 0,
    }));
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/**
 * Fetch the current state (structure, server identity, member roles, recent messages)
 * and store it as a compressed backup. Returns null when nothing changed or on failure.
 */
export async function createBackup(
    api: API | API2,
    db: DbModule,
    guildId: string,
    reason: string,
): Promise<{ id: number; channels: number; roles: number; messages: number; bytes: number } | null> {
    try {
        const limit = messageLimit();
        const [channels, roles, guild] = await Promise.all([
            api.guilds.getChannels(guildId),
            api.guilds.getRoles(guildId),
            api.guilds.get(guildId).catch(() => null),
        ]);

        const members = await fetchMembersWithRoles(api, guildId).catch(() => [] as BackupMember[]);

        const messages: Record<string, BackupMessage[]> = {};
        if (limit > 0) {
            const textChannels = channels.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
            await pool(textChannels, 4, async (ch) => {
                try {
                    const msgs = await api.channels.getMessages(ch.id, { limit }) as APIMessage[];
                    const list: BackupMessage[] = [];
                    for (let i = msgs.length - 1; i >= 0; i--) { // oldest first
                        const m = msgs[i]!;
                        if (!m.content) continue;
                        const globalName = (m.author as { global_name?: string | null }).global_name ?? null;
                        const author = (globalName ?? m.author.username ?? "Unknown").slice(0, 80);
                        list.push({ c: m.content, a: author, av: authorAvatar(m.author) });
                    }
                    if (list.length) messages[ch.id] = list;
                } catch {
                    // channel unreadable - the backup simply won't carry its history
                }
            });
        }

        const data: BackupData = {
            version: 2,
            guild: { name: guild?.name ?? "", icon: guild?.icon ?? null },
            channels: serializeChannels(channels),
            roles: serializeRoles(roles),
            members,
            messages,
        };

        const json = JSON.stringify(data);
        if (json.length > MAX_BACKUP_RAW) {
            console.error(`Backup for ${guildId} too large (${json.length} chars), skipping`);
            return null;
        }
        const stored = compress(json);
        if (stored.length > MAX_BACKUP_STORED) {
            console.error(`Backup for ${guildId} too large after compression (${stored.length} chars), skipping`);
            return null;
        }

        // nothing changed since the newest snapshot - do not waste storage on a duplicate
        const latest = await db.getLatestSecurityBackup(guildId).catch(() => null);
        if (latest && backupRawToPlain(latest.data) === json) return null;

        const messageCount = Object.values(messages).reduce((n, l) => n + l.length, 0);
        const id = await db.addSecurityBackup(
            guildId,
            stored,
            { channels: data.channels.length, roles: data.roles.length, messages: messageCount, bytes: stored.length },
            reason,
        );
        return { id, channels: data.channels.length, roles: data.roles.length, messages: messageCount, bytes: stored.length };
    } catch (err) {
        console.error(`Failed to create backup for ${guildId}: ${err}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export type RestorePhase = "roles" | "channels" | "members" | "identity" | "messages";
export type RestoreProgress = { phase: RestorePhase; done: number; total: number };

export type RestoreOptions = {
    onProgress?: (p: RestoreProgress) => void;
};

export type RestoreResult = {
    channelsCreated: string[];
    rolesCreated: string[];
    membersChecked: number;
    membersFixed: number;
    identityRestored: boolean;
    messagesRestored: number;
    messageChannels: number;
    missingChannels: string[];
    missingRoles: string[];
    errors: string[];
};

function emptyResult(): RestoreResult {
    return {
        channelsCreated: [],
        rolesCreated: [],
        membersChecked: 0,
        membersFixed: 0,
        identityRestored: false,
        messagesRestored: 0,
        messageChannels: 0,
        missingChannels: [],
        missingRoles: [],
        errors: [],
    };
}

/**
 * Recreate every channel/role from the backup that is currently missing, repair member
 * roles, restore the server name/icon and re-post captured messages into recreated
 * channels (via webhook, using each author's name and avatar). Existing structure is
 * left untouched; verify passes retry anything that failed.
 */
export async function restoreBackup(
    api: API | API2,
    backup: SecurityBackupRow,
    reason: string,
    opts: RestoreOptions = {},
): Promise<RestoreResult> {
    const guildId = backup.guild_id;
    const data = decodeBackupData(backup.data);
    const result = emptyResult();
    const emit = (phase: RestorePhase, done: number, total: number) => {
        try { opts.onProgress?.({ phase, done, total }); } catch { /* progress must never fail a restore */ }
    };
    const addErr = (msg: string) => {
        if (result.errors.length < 15 && !result.errors.includes(msg)) result.errors.push(msg);
    };

    const [liveChannels, liveRoles] = await Promise.all([
        api.guilds.getChannels(guildId),
        api.guilds.getRoles(guildId),
    ]);

    // ---- roles ----
    const roleIdMap = new Map<string, string>();
    const sortedRoles = [...data.roles].sort((a, b) => a.position - b.position);
    let roleDone = 0;
    emit("roles", 0, sortedRoles.length);

    const ensureRoles = async (rolesNow: APIRole[], attempt: number): Promise<APIRole[]> => {
        const byName = new Map<string, APIRole>();
        for (const r of rolesNow) {
            const k = r.name.toLowerCase();
            if (!byName.has(k)) byName.set(k, r);
        }
        const created: { id: string; position: number }[] = [];
        for (const role of sortedRoles) {
            const k = role.name.toLowerCase();
            const existing = byName.get(k);
            if (existing) {
                roleIdMap.set(role.id, existing.id);
                continue;
            }
            try {
                const newRole = await api.guilds.createRole(guildId, {
                    name: role.name,
                    color: role.color,
                    permissions: role.permissions,
                    hoist: role.hoist,
                    mentionable: role.mentionable,
                }, { reason });
                roleIdMap.set(role.id, newRole.id);
                byName.set(k, newRole);
                created.push({ id: newRole.id, position: role.position });
                result.rolesCreated.push(role.name);
                rolesNow.push(newRole);
            } catch (err) {
                addErr(`role "${role.name}": ${errMsg(err)}`);
            }
            if (attempt === 0) emit("roles", ++roleDone, sortedRoles.length);
        }
        if (created.length > 0) {
            try {
                await api.guilds.setRolePositions(guildId,
                    created.map(r => ({ id: r.id as Snowflake, position: r.position })),
                    { reason });
            } catch (err) {
                addErr(`role positions: ${errMsg(err)}`);
            }
        }
        return rolesNow;
    };

    await ensureRoles(liveRoles, 0);

    // ---- channels ----
    const channelIdMap = new Map<string, string>(liveChannels.map(c => [c.id, c.id]));
    const createdChannelIds = new Set<string>();
    let channelDone = 0;
    const sortedChannels = [...data.channels].sort((a, b) => {
        const aCat = a.type === ChannelType.GuildCategory ? 0 : 1;
        const bCat = b.type === ChannelType.GuildCategory ? 0 : 1;
        if (aCat !== bCat) return aCat - bCat;
        return a.position - b.position;
    });
    emit("channels", 0, sortedChannels.length);

    const ensureChannels = async (channelsNow: LiveChannel[], attempt: number): Promise<LiveChannel[]> => {
        const byKey = new Map<string, LiveChannel>();
        for (const c of channelsNow) {
            const key = `${c.type}:${c.name}`.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, c);
        }
        for (const channel of sortedChannels) {
            const key = `${channel.type}:${channel.name}`.toLowerCase();
            const existing = byKey.get(key);
            if (existing) {
                channelIdMap.set(channel.id, existing.id);
                continue;
            }

            const parentId = channel.parent_id
                ? (channelIdMap.get(channel.parent_id) ?? byKey.get(`4:${(data.channels.find(c => c.id === channel.parent_id)?.name ?? "").toLowerCase()}`)?.id ?? null)
                : null;

            const body: RESTPostAPIGuildChannelJSONBody = {
                name: channel.name,
                type: channel.type as ChannelType,
                parent_id: parentId,
                permission_overwrites: channel.permission_overwrites
                    .map(o => ({
                        id: roleIdMap.get(o.id) ?? channelIdMap.get(o.id) ?? o.id,
                        type: o.type as 0 | 1,
                        allow: o.allow,
                        deny: o.deny,
                    })),
                reason,
            } as RESTPostAPIGuildChannelJSONBody;

            // optional bits - only set them when the channel type actually supports them
            if (channel.topic != null) (body as { topic?: string }).topic = channel.topic;
            if (channel.nsfw != null) (body as { nsfw?: boolean }).nsfw = channel.nsfw;
            if (channel.rate_limit_per_user != null) (body as { rate_limit_per_user?: number }).rate_limit_per_user = channel.rate_limit_per_user;
            if (channel.user_limit != null) (body as { user_limit?: number }).user_limit = channel.user_limit;
            if (channel.bitrate != null) (body as { bitrate?: number }).bitrate = channel.bitrate;
            if (channel.rtc_region !== undefined) (body as { rtc_region?: string | null }).rtc_region = channel.rtc_region;

            try {
                const created = await api.guilds.createChannel(guildId, body, { reason });
                channelIdMap.set(channel.id, created.id);
                createdChannelIds.add(channel.id);
                byKey.set(key, created as LiveChannel);
                channelsNow.push(created as LiveChannel);
                result.channelsCreated.push(`#${channel.name}`);
            } catch (err) {
                addErr(`channel #${channel.name}: ${errMsg(err)}`);
            }
            if (attempt === 0) emit("channels", ++channelDone, sortedChannels.length);
        }
        return channelsNow;
    };

    await ensureChannels(liveChannels, 0);

    // ---- verify passes: refetch and retry anything that failed (up to 2 extra rounds) ----
    for (let pass = 1; pass <= 2; pass++) {
        const [chNow, roleNow] = await Promise.all([
            api.guilds.getChannels(guildId),
            api.guilds.getRoles(guildId),
        ]);
        const liveRoleNames = new Set(roleNow.map(r => r.name.toLowerCase()));
        const liveChannelKeys = new Set(chNow.map(c => `${c.type}:${c.name}`.toLowerCase()));
        const missingRoles = sortedRoles.filter(r => !liveRoleNames.has(r.name.toLowerCase()));
        const missingChannels = sortedChannels.filter(c => !liveChannelKeys.has(`${c.type}:${c.name}`.toLowerCase()));
        if (missingRoles.length === 0 && missingChannels.length === 0) break;
        if (missingRoles.length > 0) await ensureRoles(roleNow, pass);
        if (missingChannels.length > 0) await ensureChannels(chNow, pass);
    }

    // final tally of what is still missing
    {
        const [chNow, roleNow] = await Promise.all([
            api.guilds.getChannels(guildId),
            api.guilds.getRoles(guildId),
        ]);
        const liveRoleNames = new Set(roleNow.map(r => r.name.toLowerCase()));
        const liveChannelKeys = new Set(chNow.map(c => `${c.type}:${c.name}`.toLowerCase()));
        result.missingRoles = sortedRoles.filter(r => !liveRoleNames.has(r.name.toLowerCase())).map(r => r.name);
        result.missingChannels = sortedChannels.filter(c => !liveChannelKeys.has(`${c.type}:${c.name}`.toLowerCase())).map(c => `#${c.name}`);
    }

    // ---- member roles (only ever ADD missing roles, never remove) ----
    if (data.members.length > 0) {
        emit("members", 0, data.members.length);
        result.membersChecked = data.members.length;
        try {
            const liveMembers = new Map<string, string[]>();
            let after = "0";
            for (let page = 0; page < 10; page++) {
                const batch = await api.guilds.getMembers(guildId, { limit: 1000, after });
                for (const m of batch) if (m.user) liveMembers.set(m.user.id, m.roles ?? []);
                if (batch.length < 1000) break;
                after = batch[batch.length - 1]!.user!.id;
            }

            let memberDone = 0;
            await pool(data.members, 5, async (bm) => {
                try {
                    const live = liveMembers.get(bm.id);
                    if (live) {
                        const wanted = bm.r.map(id => roleIdMap.get(id) ?? id);
                        const missing = wanted.filter(id => !live.includes(id));
                        if (missing.length > 0) {
                            await api.guilds.editMember(guildId, bm.id, { roles: [...live, ...missing] }, { reason });
                            result.membersFixed++;
                        }
                    }
                } catch (err) {
                    addErr(`member ${bm.id}: ${errMsg(err)}`);
                } finally {
                    memberDone++;
                    emit("members", memberDone, data.members.length);
                }
            });
        } catch (err) {
            addErr(`member list: ${errMsg(err)}`);
        }
    }

    // ---- server identity (name + icon) ----
    if (data.guild.name || data.guild.icon) {
        emit("identity", 0, 1);
        try {
            const live = await api.guilds.get(guildId);
            const patch: RESTPatchAPIGuildJSONBody = {};
            let changed = false;
            if (data.guild.name && live.name !== data.guild.name) {
                patch.name = data.guild.name;
                changed = true;
            }
            if (data.guild.icon && live.icon !== data.guild.icon) {
                const iconUrl = `https://cdn.discordapp.com/icons/${guildId}/${data.guild.icon}.png?size=256`;
                try {
                    const res = await fetch(iconUrl, { signal: AbortSignal.timeout(5000) });
                    if (res.ok) {
                        const type = res.headers.get("content-type") || "image/png";
                        const buf = Buffer.from(await res.arrayBuffer());
                        patch.icon = `data:${type};base64,${buf.toString("base64")}`;
                        changed = true;
                    } else {
                        addErr(`server icon: backup image unavailable (${res.status})`);
                    }
                } catch (err) {
                    addErr(`server icon: ${errMsg(err)}`);
                }
            }
            if (changed) {
                await api.guilds.edit(guildId, patch, { reason });
                result.identityRestored = true;
            }
            emit("identity", 1, 1);
        } catch (err) {
            addErr(`server identity: ${errMsg(err)}`);
        }
    }

    // ---- message history for channels that were recreated in this run ----
    const messageTargets = Object.keys(data.messages).filter(id => createdChannelIds.has(id));
    if (messageTargets.length > 0) {
        emit("messages", 0, messageTargets.length);
        let msgDone = 0;
        for (const oldChannelId of messageTargets) {
            const liveChannelId = channelIdMap.get(oldChannelId);
            const msgs = data.messages[oldChannelId] ?? [];
            if (liveChannelId && msgs.length > 0) {
                try {
                    const sent = await repostMessages(api, liveChannelId, msgs, reason);
                    if (sent > 0) {
                        result.messagesRestored += sent;
                        result.messageChannels++;
                    }
                } catch (err) {
                    addErr(`messages: ${errMsg(err)}`);
                }
            }
            msgDone++;
            emit("messages", msgDone, messageTargets.length);
        }
    }

    return result;
}

/** Re-post captured messages through a fresh webhook using each author's name and avatar. */
async function repostMessages(api: API | API2, channelId: string, msgs: BackupMessage[], reason: string): Promise<number> {
    let webhook;
    try {
        webhook = await api.channels.createWebhook(channelId, { name: "Honeypot restore" }, { reason });
    } catch (err) {
        throw new Error(`webhook unavailable (needs Manage Webhooks): ${errMsg(err)}`);
    }
    if (!webhook.token) {
        await api.rest.delete(Routes.webhook(webhook.id), { reason }).catch(() => { });
        throw new Error("webhook unavailable (no token returned)");
    }
    const token: string = webhook.token;
    let sent = 0;
    try {
        for (const m of msgs) {
            for (const chunk of splitContent(m.c)) {
                await api.webhooks.execute(webhook.id, token, {
                    content: chunk,
                    username: m.a.slice(0, 80),
                    ...(m.av ? { avatar_url: m.av } : {}),
                });
                sent++;
            }
        }
    } finally {
        await api.rest.delete(Routes.webhook(webhook.id), { reason }).catch(() => { });
    }
    return sent;
}

/** Cheap structure check used by the anti-nuke follow-up (no writes). */
export async function findMissingStructure(
    api: API | API2,
    guildId: string,
    rawBackup: string,
): Promise<{ channels: string[]; roles: string[] }> {
    const data = decodeBackupData(rawBackup);
    const [channels, roles] = await Promise.all([
        api.guilds.getChannels(guildId),
        api.guilds.getRoles(guildId),
    ]);
    const liveRoleNames = new Set(roles.map(r => r.name.toLowerCase()));
    const liveChannelKeys = new Set(channels.map(c => `${c.type}:${c.name}`.toLowerCase()));
    return {
        channels: data.channels.filter(c => !liveChannelKeys.has(`${c.type}:${c.name}`.toLowerCase())).map(c => `#${c.name}`),
        roles: data.roles.filter(r => !liveRoleNames.has(r.name.toLowerCase())).map(r => r.name),
    };
}

/** Human summary for log embeds / command replies. */
export function restoreSummary(result: RestoreResult): string {
    const lines: string[] = [];
    if (result.channelsCreated.length > 0) {
        lines.push(`**Channels restored:** ${result.channelsCreated.slice(0, 20).join(", ")}${result.channelsCreated.length > 20 ? ` (+${result.channelsCreated.length - 20})` : ""}`);
    }
    if (result.rolesCreated.length > 0) {
        lines.push(`**Roles restored:** ${result.rolesCreated.slice(0, 20).join(", ")}${result.rolesCreated.length > 20 ? ` (+${result.rolesCreated.length - 20})` : ""}`);
    }
    if (result.membersChecked > 0) lines.push(`**Member roles:** ${result.membersFixed} of ${result.membersChecked} member(s) repaired`);
    if (result.identityRestored) lines.push("**Server identity:** name / icon restored to the backup state");
    if (result.messagesRestored > 0) lines.push(`**Messages:** ${result.messagesRestored} re-posted in ${result.messageChannels} channel(s)`);
    if (result.missingChannels.length > 0 || result.missingRoles.length > 0) {
        const parts: string[] = [];
        if (result.missingChannels.length > 0) parts.push(`${result.missingChannels.length} channel(s)`);
        if (result.missingRoles.length > 0) parts.push(`${result.missingRoles.length} role(s)`);
        lines.push(`**Still missing after retries:** ${parts.join(", ")}`);
    }
    if (lines.length === 0) lines.push("Nothing was missing - the server already matches the backup.");
    if (result.errors.length > 0) {
        lines.push(`**Errors (${result.errors.length}):** ${result.errors.slice(0, 4).join("; ")}${result.errors.length > 4 ? " ..." : ""}`);
    }
    return lines.join("\n");
}
