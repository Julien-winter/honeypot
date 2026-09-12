import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits, type RESTPutAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

export const commandsPayload: RESTPutAPIApplicationCommandsJSONBody = [
    {
        // this command opens a modal for configuring the honeypot
        name: "honeypot",
        description: "Configure/setup the honeypot channel and its settings",
        type: ApplicationCommandType.ChatInput,
        options: [],
        default_member_permissions:
            (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageChannels).toString(),
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        // this command opens a modal for configuring the messages
        name: "honeypot-messages",
        description: "Configure the honeypot messages that the bot sends",
        type: ApplicationCommandType.ChatInput,
        options: [],
        default_member_permissions:
            (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ManageChannels).toString(),
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        name: "stats",
        description: "See statistics for all servers using honeypot",
        type: ApplicationCommandType.ChatInput,
        options: [],
        contexts: [InteractionContextType.BotDM, InteractionContextType.Guild],
    },
]

