import type { GatewayDispatchEvents, GatewayDispatchPayload } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";


export type EventHandler<K extends GatewayDispatchEvents = GatewayDispatchEvents> = {
    event: K,
    handler: (listener: {
        data: (Extract<GatewayDispatchPayload, { t: K }>["d"]),
        api: API | API2,
        applicationId: string,
        redis?: Bun.RedisClient,
        db: typeof import("../utils/db")
    }) => Promise<any>;
};



import guildCreate from "./guild-create";
import guildDelete from "./guild-delete";
import guildUpdate from "./guild-update";
import guildMemberAdd from "./guild-member-add";
import channelDelete from "./channel-delete";
import channelCreate from "./channel-create";
import threadDelete from "./thread-delete";
import roleDelete from "./role-delete";
import messageDelete from "./message-delete";
import messageDeleteBulk from "./message-delete-bulk";
import messageCreate from "./message-create";
import interactionCreate from "./interaction-create";

export const eventHandlers = [
    guildCreate,
    guildDelete,
    guildUpdate,
    guildMemberAdd,
    channelDelete,
    channelCreate,
    threadDelete,
    roleDelete,
    messageDelete,
    messageDeleteBulk,
    messageCreate,
    interactionCreate,
]

export default eventHandlers;
