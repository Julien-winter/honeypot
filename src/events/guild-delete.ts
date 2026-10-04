import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { invalidateGuildInfoCache, removeGuildSubscribedChannelCache } from "../utils/cache";
import { invalidateSecurityConfig } from "../security/config";

const handler: EventHandler<GatewayDispatchEvents.GuildDelete> = {
    event: GatewayDispatchEvents.GuildDelete,
    handler: async ({ data: guild, api, applicationId, redis, db }) => {
        try {
            // The bot didnt actually leave the guild, discord itself merely is having some issues there
            if (guild.unavailable === true) return;
            // Grace period: keep honeypot data for 3 days (rejoin restores everything),
            // a daily cron purges it afterwards to save storage.
            await db.markGuildLeft(guild.id);
            // security data (config, backups, quarantine, events) is removed right away
            await db.deleteSecurityData(guild.id);
            invalidateGuildInfoCache(guild.id, redis);
            invalidateSecurityConfig(guild.id);
            if (redis) removeGuildSubscribedChannelCache(guild.id, redis);
            redis?.publish("guild_count", "-1");
        } catch (err) {
            console.error(`Failed to delete honeypot config for guild ${guild.id}:`, err);
        }
    }
};

export default handler;
