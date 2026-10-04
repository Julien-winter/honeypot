import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import type { APIEmbed } from "discord-api-types/v10";
import { DiscordAPIError } from "@discordjs/rest";
import { RESTJSONErrorCodes } from "discord-api-types/v10";
import type { SecurityConfig, SecurityEventType } from "../utils/db";
import type { DbModule } from "./config";

/** Post an embed to the guild's event log channel (if the module is on and the channel exists). */
export async function sendSecurityLog(
    api: API | API2,
    db: DbModule,
    guildId: string,
    cfg: SecurityConfig | null,
    embed: APIEmbed,
) {
    if (!cfg?.event_log || !cfg.event_log_channel_id) return false;
    try {
        await api.channels.createMessage(cfg.event_log_channel_id, {
            embeds: [embed],
            allowed_mentions: { parse: [] },
        });
        return true;
    } catch (err) {
        if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.UnknownChannel || err.code === RESTJSONErrorCodes.MissingAccess)) {
            console.error(`Event log channel ${cfg.event_log_channel_id} unusable in ${guildId}, disabling: ${err}`);
            await db.unsetSecurityLogChannel(guildId).catch(() => { });
        } else {
            console.error(`Failed to send security log message in ${guildId}: ${err}`);
        }
        return false;
    }
}

/** Record an incident for the stats page and nudge the stats api (same channel pattern as moderate_event). */
export async function recordSecurityEvent(
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    guildId: string,
    type: SecurityEventType,
    userId?: string | null,
    channelId?: string | null,
    meta?: Record<string, unknown> | null,
) {
    try {
        await db.logSecurityEvent(guildId, type, userId ?? null, channelId ?? null, meta ?? null);
        redis?.publish("security_event", type);
    } catch (err) {
        console.error(`Failed to record security event (${type}) in ${guildId}: ${err}`);
    }
}
