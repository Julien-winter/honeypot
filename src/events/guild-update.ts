import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { setGuildInfoCache } from "../utils/cache";

const handler: EventHandler<GatewayDispatchEvents.GuildUpdate> = {
    event: GatewayDispatchEvents.GuildUpdate,
    handler: async ({ data: guild, api, applicationId, redis, db }) => {
        setGuildInfoCache(guild.id, guild, redis);
        // keep the stored name/icon fresh (used by the public leaderboard)
        const config = await db.getConfig(guild.id).catch(() => null);
        const newName = guild.name ?? null;
        const newIcon = (guild as { icon?: string | null }).icon ?? null;
        if (config && (config.name !== newName || config.icon !== newIcon)) {
            await db.setConfig({ ...config, name: newName, icon: newIcon }).catch(() => null);
        }
    }
};

export default handler;
