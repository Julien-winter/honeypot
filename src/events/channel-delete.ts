import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { handleStructureDelete } from "../security/anti-nuke";

const handler: EventHandler<GatewayDispatchEvents.ChannelDelete> = {
    event: GatewayDispatchEvents.ChannelDelete,
    handler: async ({ data: channel, api, applicationId, redis, db }) => {
        const { guild_id: guildId, id: channelId } = channel;
        if (!guildId) return;
        try {
            await db.unsetHoneypotChannel(guildId, channelId);
            await db.unsetLogChannel(guildId, channelId);
        } catch (err) {
            console.error(`Error with ChannelDelete handler: ${err}`);
        }
        try {
            await handleStructureDelete(api, db, redis, applicationId, guildId, "channel");
        } catch (err) {
            console.error(`Error with ChannelDelete anti-nuke hook: ${err}`);
        }
    }
};

export default handler;
