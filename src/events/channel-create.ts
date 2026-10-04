import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { handleChannelCreate } from "../security/anti-nuke";

const handler: EventHandler<GatewayDispatchEvents.ChannelCreate> = {
    event: GatewayDispatchEvents.ChannelCreate,
    handler: async ({ data: channel, api, applicationId, redis, db }) => {
        const guildId = channel.guild_id;
        if (!guildId) return;
        try {
            await handleChannelCreate(api, db, redis, applicationId, guildId);
        } catch (err) {
            console.error(`Error with ChannelCreate anti-nuke hook: ${err}`);
        }
    }
};

export default handler;
