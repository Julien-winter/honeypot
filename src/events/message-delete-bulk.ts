import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { dropMessages } from "../security/message-buffer";

const handler: EventHandler<GatewayDispatchEvents.MessageDeleteBulk> = {
    event: GatewayDispatchEvents.MessageDeleteBulk,
    handler: async ({ data: messageBatch, api, applicationId, redis, db }) => {
        if (!messageBatch.guild_id) return;
        dropMessages(messageBatch.channel_id, messageBatch.ids);
        try {
            await db.unsetHoneypotMsgs(messageBatch.guild_id, messageBatch.ids);
        } catch (err) {
            console.error(`Error with MessageDeleteBulk handler: ${err}`);
        }
    }
};

export default handler;
