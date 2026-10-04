import { GatewayDispatchEvents } from "discord-api-types/v10";
import type { EventHandler } from "./events";
import { handleStructureDelete } from "../security/anti-nuke";

const handler: EventHandler<GatewayDispatchEvents.GuildRoleDelete> = {
    event: GatewayDispatchEvents.GuildRoleDelete,
    handler: async ({ data: role, api, applicationId, redis, db }) => {
        const guildId = role.guild_id;
        if (!guildId) return;
        try {
            await handleStructureDelete(api, db, redis, applicationId, guildId, "role");
        } catch (err) {
            console.error(`Error with RoleDelete handler: ${err}`);
        }
    }
};

export default handler;
