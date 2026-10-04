import {
    ChannelType,
    type APIChannel,
    type APIRole,
    type RESTGetAPIGuildChannelsResult,
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

export type BackupData = {
    version: 1;
    channels: BackupChannel[];
    roles: BackupRole[];
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

const MAX_BACKUP_JSON = 60_000; // mysql TEXT limit, stay safely below it

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

/** Fetch the current structure and store it as a backup. Returns the new backup id (0 when nothing was stored). */
export async function createBackup(
    api: API | API2,
    db: DbModule,
    guildId: string,
    reason: string,
): Promise<{ id: number; channels: number; roles: number } | null> {
    try {
        const [channels, roles] = await Promise.all([
            api.guilds.getChannels(guildId),
            api.guilds.getRoles(guildId),
        ]);
        const data: BackupData = {
            version: 1,
            channels: serializeChannels(channels),
            roles: serializeRoles(roles),
        };
        const json = JSON.stringify(data);
        if (json.length > MAX_BACKUP_JSON) {
            console.error(`Backup for ${guildId} too large (${json.length} chars), skipping`);
            return null;
        }
        const id = await db.addSecurityBackup(guildId, json, { channels: data.channels.length, roles: data.roles.length }, reason);
        return { id, channels: data.channels.length, roles: data.roles.length };
    } catch (err) {
        console.error(`Failed to create backup for ${guildId}: ${err}`);
        return null;
    }
}

export type RestoreResult = {
    channelsCreated: string[];
    rolesCreated: string[];
    errors: string[];
};

/** Recreate every channel/role from the backup that is currently missing. Existing structure is left untouched. */
export async function restoreBackup(
    api: API | API2,
    backup: SecurityBackupRow,
    reason: string,
): Promise<RestoreResult> {
    const guildId = backup.guild_id;
    const data = JSON.parse(backup.data) as BackupData;
    const result: RestoreResult = { channelsCreated: [], rolesCreated: [], errors: [] };

    const [existingChannels, existingRoles] = await Promise.all([
        api.guilds.getChannels(guildId),
        api.guilds.getRoles(guildId),
    ]);

    // ---- roles: map backup role id -> live role id (matched by name, recreated when missing) ----
    const liveRolesByName = new Map<string, APIRole>();
    for (const role of existingRoles) {
        const key = role.name.toLowerCase();
        if (!liveRolesByName.has(key)) liveRolesByName.set(key, role);
    }

    const roleIdMap = new Map<string, string>();
    const createdRoles: { id: string; position: number }[] = [];
    const sortedRoles = [...data.roles].sort((a, b) => a.position - b.position);
    for (const role of sortedRoles) {
        const existing = liveRolesByName.get(role.name.toLowerCase());
        if (existing) {
            roleIdMap.set(role.id, existing.id);
            continue;
        }
        try {
            const created = await api.guilds.createRole(guildId, {
                name: role.name,
                color: role.color,
                permissions: role.permissions,
                hoist: role.hoist,
                mentionable: role.mentionable,
            }, { reason });
            roleIdMap.set(role.id, created.id);
            liveRolesByName.set(role.name.toLowerCase(), created);
            createdRoles.push({ id: created.id, position: role.position });
            result.rolesCreated.push(role.name);
        } catch (err) {
            result.errors.push(`role "${role.name}": ${err}`);
        }
    }

    // give recreated roles their original position (highest first)
    if (createdRoles.length > 0) {
        try {
            await api.guilds.setRolePositions(guildId,
                createdRoles.map(r => ({ id: r.id as Snowflake, position: r.position })),
                { reason });
        } catch (err) {
            result.errors.push(`role positions: ${err}`);
        }
    }

    // ---- channels: match by name+type, recreate what is gone (categories first) ----
    const liveChannelsByKey = new Map<string, { id: string }>();
    for (const channel of existingChannels) {
        const key = `${channel.type}:${channel.name}`.toLowerCase();
        if (!liveChannelsByKey.has(key)) liveChannelsByKey.set(key, channel);
    }

    const channelIdMap = new Map<string, string>(existingChannels.map(c => [c.id, c.id]));
    const byPosition = [...data.channels].sort((a, b) => {
        const aCat = a.type === ChannelType.GuildCategory ? 0 : 1;
        const bCat = b.type === ChannelType.GuildCategory ? 0 : 1;
        if (aCat !== bCat) return aCat - bCat;
        return a.position - b.position;
    });

    for (const channel of byPosition) {
        const key = `${channel.type}:${channel.name}`.toLowerCase();
        const existing = liveChannelsByKey.get(key);
        if (existing) {
            channelIdMap.set(channel.id, existing.id);
            continue;
        }

        const parentId = channel.parent_id
            ? (channelIdMap.get(channel.parent_id) ?? liveChannelsByKey.get(`4:${(data.channels.find(c => c.id === channel.parent_id)?.name ?? "").toLowerCase()}`)?.id ?? null)
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
            liveChannelsByKey.set(key, created);
            result.channelsCreated.push(`#${channel.name}`);
        } catch (err) {
            result.errors.push(`channel #${channel.name}: ${err}`);
        }
    }

    return result;
}

/** Human summary for log embeds / command replies. */
export function restoreSummary(result: RestoreResult): string {
    const lines: string[] = [];
    if (result.channelsCreated.length > 0) lines.push(`**Channels restored:** ${result.channelsCreated.slice(0, 20).join(", ")}${result.channelsCreated.length > 20 ? ` (+${result.channelsCreated.length - 20})` : ""}`);
    if (result.rolesCreated.length > 0) lines.push(`**Roles restored:** ${result.rolesCreated.slice(0, 20).join(", ")}${result.rolesCreated.length > 20 ? ` (+${result.rolesCreated.length - 20})` : ""}`);
    if (lines.length === 0) lines.push("Nothing was missing - structure already matches the backup.");
    if (result.errors.length > 0) lines.push(`**Errors:** ${result.errors.slice(0, 5).join("; ")}`);
    return lines.join("\n");
}
