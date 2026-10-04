import { ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits, type RESTPutAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

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
        name: "security",
        description: "Configure anti-nuke, bot quarantine, anti-spam, phishing filter, event log & backups",
        type: ApplicationCommandType.ChatInput,
        options: [],
        default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        name: "backup",
        description: "Create, list and restore structure backups (channels & roles)",
        type: ApplicationCommandType.ChatInput,
        options: [
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "create",
                description: "Create a backup of all channels & roles right now",
            },
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "list",
                description: "List the most recent backups of this server",
            },
            {
                type: ApplicationCommandOptionType.Subcommand,
                name: "restore",
                description: "Restore channels & roles from a backup",
                options: [
                    {
                        type: ApplicationCommandOptionType.Integer,
                        name: "id",
                        description: "Backup id (see /backup list) - defaults to the newest one",
                        required: false,
                        min_value: 1,
                    },
                ],
            },
        ],
        default_member_permissions:
            (PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles).toString(),
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

