import {
    ApplicationCommandOptionType,
    ButtonStyle,
    ChannelType,
    ComponentType,
    InteractionType,
    MessageFlags,
    PermissionFlagsBits,
    SelectMenuDefaultValueType,
    type APIEmbed,
    type APIInteraction,
    type APIModalInteractionResponseCallbackData,
    type APISelectMenuOption,
    type RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { styleText } from "node:util";
import type { SecurityConfig, SecurityModule } from "../utils/db";
import { getGuildInfo } from "../utils/cache";
import { hasPermission, trim } from "../utils/tools";
import { HAS_MESSAGE_INTENT } from "../utils/constants";
import {
    CRITICAL_MODULES,
    SECURITY_MODULES,
    primeSecurityConfig,
    keepMessagesUnrestricted,
    type DbModule,
} from "./config";
import { approveQuarantine, kickQuarantine } from "./quarantine";
import { createBackup, restoreBackup, restoreSummary } from "./backup";
import { recordSecurityEvent, sendSecurityLog } from "./notify";

const MODULE_LABELS: Record<SecurityModule, { label: string; emoji: string; description: string }> = {
    anti_nuke: { label: "Anti-Nuke & Restore", emoji: "🛡️", description: "Catches mass channel/role deletions, strips the attacker, rebuilds from backup" },
    quarantine: { label: "Bot Quarantine", emoji: "🔒", description: "New bots join without permissions until approved" },
    anti_spam: { label: "Anti-Spam", emoji: "🚫", description: "Floods, mass mentions and coordinated raids" },
    anti_phishing: { label: "Anti-Phishing", emoji: "🔗", description: "Removes fake nitro / token stealer links" },
    event_log: { label: "Event Log", emoji: "📜", description: "Logs every change (channels, roles, bans, invites…)" },
    backups: { label: "Auto-Backups", emoji: "💾", description: "Snapshots channels & roles every 10 minutes" },
};

const SPAM_LEVELS = {
    strict: { spam_threshold: 3, spam_window_sec: 5, mention_threshold: 3, label: "Strict (3 msgs / 5s, 3 mentions)" },
    normal: { spam_threshold: 5, spam_window_sec: 10, mention_threshold: 5, label: "Normal (5 msgs / 10s, 5 mentions)" },
    lenient: { spam_threshold: 8, spam_window_sec: 15, mention_threshold: 8, label: "Lenient (8 msgs / 15s, 8 mentions)" },
} as const;

type SpamLevel = keyof typeof SPAM_LEVELS;

function defaultConfig(guildId: string): SecurityConfig {
    return {
        guild_id: guildId,
        anti_nuke: false,
        quarantine: false,
        anti_spam: false,
        anti_phishing: false,
        event_log: false,
        backups: false,
        event_log_channel_id: null,
        spam_threshold: SPAM_LEVELS.normal.spam_threshold,
        spam_window_sec: SPAM_LEVELS.normal.spam_window_sec,
        mention_threshold: SPAM_LEVELS.normal.mention_threshold,
        anti_nuke_action: "strip",
    };
}

function spamLevelOf(cfg: SecurityConfig): SpamLevel {
    if (cfg.spam_threshold <= 3) return "strict";
    if (cfg.spam_threshold >= 8) return "lenient";
    return "normal";
}

function replyEphemeral(api: API | API2, interaction: APIInteraction, body: RESTPostAPIChannelMessageJSONBody) {
    return api.interactions.reply(interaction.id, interaction.token, {
        ...body,
        allowed_mentions: { parse: [] },
        flags: (body.flags ?? 0) | MessageFlags.Ephemeral,
    });
}

function hasAppPerms(interaction: APIInteraction, bits: bigint): boolean {
    return hasPermission(BigInt(interaction.app_permissions ?? "0"), bits);
}

function memberHas(interaction: APIInteraction, bits: bigint): boolean {
    if (!interaction.member) return true; // e.g. dm-installed context shouldn't happen here
    return hasPermission(BigInt(interaction.member.permissions ?? "0"), bits);
}

/**
 * Handles everything the security modules add to InteractionCreate:
 * /security, /backup (create|list|restore), quarantine buttons and backup restore buttons.
 * Returns true when the interaction was consumed.
 */
export async function handleSecurityInteraction(
    interaction: APIInteraction,
    api: API | API2,
    redis: Bun.RedisClient | undefined,
    db: DbModule,
    userContextHash: string,
): Promise<boolean> {
    const guildId = interaction.guild_id;
    const userId = interaction.member?.user.id || interaction.user?.id;
    if (!guildId || !userId) return false;
    const username = interaction.member?.user.username || interaction.user?.username || userId;

    try {
        // ------------------------- /security -------------------------
        if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "security") {
            const current = (await db.getSecurityConfig(guildId)) ?? defaultConfig(guildId);
            const moduleOptions: APISelectMenuOption[] = (Object.keys(MODULE_LABELS) as SecurityModule[]).map((module) => ({
                label: MODULE_LABELS[module].label,
                value: module,
                description: module === "anti_phishing" && !HAS_MESSAGE_INTENT
                    ? "needs HAS_MESSAGE_INTENT=1 to read links"
                    : trim(MODULE_LABELS[module].description, 100),
                default: current[module],
            }));

            const level = spamLevelOf(current);
            const modal: APIModalInteractionResponseCallbackData = {
                title: "Security",
                custom_id: `security_modal:${userContextHash}`,
                components: [
                    {
                        type: ComponentType.Label,
                        label: "Modules",
                        description: "Pick the protections you want enabled",
                        component: {
                            type: ComponentType.StringSelect,
                            custom_id: "sec_modules",
                            placeholder: "Select modules to enable",
                            options: moduleOptions,
                            min_values: 0,
                            max_values: moduleOptions.length,
                            required: false,
                        },
                    },
                    {
                        type: ComponentType.Label,
                        label: "Event log channel",
                        description: "Where changes, incidents and quarantine alerts are posted",
                        component: {
                            type: ComponentType.ChannelSelect,
                            custom_id: "sec_log_channel",
                            min_values: 0,
                            max_values: 1,
                            placeholder: "#security-log",
                            channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread],
                            default_values: current.event_log_channel_id
                                ? [{ id: current.event_log_channel_id, type: SelectMenuDefaultValueType.Channel }]
                                : [],
                            required: false,
                        },
                    },
                    {
                        type: ComponentType.Label,
                        label: "Spam sensitivity",
                        component: {
                            type: ComponentType.RadioGroup,
                            custom_id: "sec_spam_level",
                            required: true,
                            options: (Object.keys(SPAM_LEVELS) as SpamLevel[]).map(key => ({
                                label: SPAM_LEVELS[key].label,
                                value: key,
                                default: level === key,
                            })),
                        },
                    },
                    {
                        type: ComponentType.Label,
                        label: "Anti-nuke response",
                        description: "What happens to the attacker once the threshold is crossed",
                        component: {
                            type: ComponentType.RadioGroup,
                            custom_id: "sec_nuke_action",
                            required: true,
                            options: [
                                { label: "Strip roles", value: "strip", description: "Remove all their roles (default)", default: current.anti_nuke_action === "strip" },
                                { label: "Strip roles + ban", value: "strip_ban", description: "Also ban them and delete the last hour", default: current.anti_nuke_action === "strip_ban" },
                                { label: "Alert only", value: "alert", description: "Don't touch anyone, only restore & log", default: current.anti_nuke_action === "alert" },
                            ],
                        },
                    },
                ],
            };
            await api.interactions.createModal(interaction.id, interaction.token, modal);
            return true;
        }

        // ------------------------- /security modal submit -------------------------
        if (interaction.type === InteractionType.ModalSubmit && interaction.data.custom_id === `security_modal:${userContextHash}`) {
            const current = (await db.getSecurityConfig(guildId)) ?? defaultConfig(guildId);

            let selectedModules: string[] | null = null;
            let logChannel: string | null = current.event_log_channel_id;
            let spamLevel: SpamLevel = spamLevelOf(current);
            let nukeAction = current.anti_nuke_action;

            for (const label of interaction.data.components) {
                if (label.type !== ComponentType.Label) continue;
                const c = label.component ?? label;
                if (!c) continue;

                if (c.type === ComponentType.StringSelect) {
                    if (c.custom_id === "sec_modules" && Array.isArray(c.values)) selectedModules = c.values;
                }
                if (c.type === ComponentType.ChannelSelect) {
                    if (c.custom_id === "sec_log_channel" && Array.isArray(c.values)) logChannel = c.values[0] ?? null;
                }
                if (c.type === ComponentType.RadioGroup) {
                    if (c.custom_id === "sec_spam_level" && c.value) spamLevel = c.value as SpamLevel;
                    if (c.custom_id === "sec_nuke_action" && c.value) nukeAction = c.value as SecurityConfig["anti_nuke_action"];
                }
            }

            const enabled = new Set<SecurityModule>(
                (selectedModules ?? SECURITY_MODULES.filter(m => current[m])) as SecurityModule[],
            );
            for (const module of enabled) if (!SECURITY_MODULES.includes(module)) enabled.delete(module);

            // critical modules may only be switched off by the owner or an administrator
            const disabling = CRITICAL_MODULES.filter(m => current[m] && !enabled.has(m));
            if (disabling.length > 0) {
                const guildInfo = await getGuildInfo(api, guildId, AbortSignal.timeout(1000), redis).catch(() => null);
                const isOwner = guildInfo?.ownerId === userId;
                const isAdmin = memberHas(interaction, PermissionFlagsBits.Administrator);
                if (!isOwner && !isAdmin) {
                    await replyEphemeral(api, interaction, {
                        content: `❌ Only the **server owner** or an **administrator** can turn off: ${disabling.map(m => MODULE_LABELS[m].label).join(", ")}.\n-# This protects you against a rogue moderator disabling your protection.`,
                    });
                    return true;
                }
            }

            if (enabled.has("event_log") && !logChannel) {
                await replyEphemeral(api, interaction, {
                    content: "❌ Select an **event log channel** to enable the Event Log module.",
                });
                return true;
            }
            if (enabled.has("anti_spam") && !memberHas(interaction, PermissionFlagsBits.ManageMessages)) {
                await replyEphemeral(api, interaction, {
                    content: "❌ You need the **Manage Messages** permission to enable Anti-Spam.",
                });
                return true;
            }

            const levelCfg = SPAM_LEVELS[spamLevel] ?? SPAM_LEVELS.normal;
            const newConfig: SecurityConfig = {
                guild_id: guildId,
                anti_nuke: enabled.has("anti_nuke"),
                quarantine: enabled.has("quarantine"),
                anti_spam: enabled.has("anti_spam"),
                anti_phishing: enabled.has("anti_phishing"),
                event_log: enabled.has("event_log"),
                backups: enabled.has("backups"),
                event_log_channel_id: enabled.has("event_log") ? logChannel : null,
                spam_threshold: levelCfg.spam_threshold,
                spam_window_sec: levelCfg.spam_window_sec,
                mention_threshold: levelCfg.mention_threshold,
                anti_nuke_action: nukeAction,
            };

            await db.setSecurityConfig(newConfig);
            primeSecurityConfig(newConfig);

            // anti-spam/phishing need the raw gateway message stream: drop the honeypot channel restriction
            if (newConfig.anti_spam || newConfig.anti_phishing) keepMessagesUnrestricted(guildId, redis);

            // make sure there is something to restore from
            let initialBackup: Awaited<ReturnType<typeof createBackup>> = null;
            if (newConfig.anti_nuke || newConfig.backups) {
                const latest = await db.getLatestSecurityBackup(guildId).catch(() => null);
                if (!latest) initialBackup = await createBackup(api, db, guildId, "initial (security setup)").catch(() => null);
            }

            const lines = (Object.keys(MODULE_LABELS) as SecurityModule[])
                .map(m => `${newConfig[m] ? "✅" : "⚪"} ${MODULE_LABELS[m].emoji} **${MODULE_LABELS[m].label}**`);
            const notes: string[] = [];
            if (newConfig.event_log && newConfig.event_log_channel_id) notes.push(`Event log → <#${newConfig.event_log_channel_id}>`);
            if (newConfig.anti_spam || newConfig.anti_phishing) notes.push(`Spam sensitivity: **${levelCfg.label}**`);
            if (newConfig.anti_nuke) notes.push(`Anti-nuke response: **${nukeAction === "strip_ban" ? "strip roles + ban" : nukeAction}**`);
            if (newConfig.anti_phishing && !HAS_MESSAGE_INTENT) notes.push("⚠️ Anti-Phishing needs `HAS_MESSAGE_INTENT=1` (Message Content Intent) to read links.");
            if (initialBackup) notes.push(`Initial backup created: **#${initialBackup.id}** (${initialBackup.channels} channels, ${initialBackup.roles} roles).`);
            else if ((newConfig.anti_nuke || newConfig.backups)) notes.push("Auto-backup runs every **10 minutes** (first one may take up to 10 min).");

            await api.interactions.reply(interaction.id, interaction.token, {
                embeds: [{
                    title: "🛡️ Security settings saved",
                    color: 0x57f287,
                    description: lines.join("\n") + (notes.length ? `\n\n${notes.join("\n")}` : ""),
                    timestamp: new Date().toISOString(),
                    footer: { text: `configured by ${username}` },
                }],
                allowed_mentions: { parse: [] },
                flags: MessageFlags.Ephemeral,
            });

            // notify the event log about the change itself
            if (newConfig.event_log && newConfig.event_log_channel_id) {
                await sendSecurityLog(api, db, guildId, newConfig, {
                    title: "⚙️ Security configuration changed",
                    color: 0x5865f2,
                    description: `**By:** <@${userId}>\n**Modules:** ${[...enabled].join(", ") || "none"}\n**Spam level:** ${levelCfg.label}\n**Anti-nuke:** ${nukeAction}`,
                    timestamp: new Date().toISOString(),
                    footer: { text: "Honeypot event log" },
                });
            }

            // background: initial backup if it was too slow for the reply
            if ((newConfig.anti_nuke || newConfig.backups) && !initialBackup) {
                createBackup(api, db, guildId, "initial (security setup)").then(result => {
                    if (result) console.log(styleText("dim", `[backup] ${guildId}: initial #${result.id}`));
                });
            }
            return true;
        }

        // ------------------------- /backup -------------------------
        if (interaction.type === InteractionType.ApplicationCommand && interaction.data.name === "backup") {
            const options = "options" in interaction.data ? interaction.data.options : undefined;
            const subcommandOption = options?.find(o => o.type === ApplicationCommandOptionType.Subcommand);
            const subcommand = subcommandOption?.name ?? "create";
            const subcommandOptions = subcommandOption && "options" in subcommandOption ? subcommandOption.options : undefined;

            if (subcommand === "create") {
                if (!hasAppPerms(interaction, PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles)) {
                    await replyEphemeral(api, interaction, {
                        content: "❌ I need the **Manage Channels** and **Manage Roles** permissions to create a backup.",
                    });
                    return true;
                }
                const result = await createBackup(api, db, guildId, `manual by ${username}`);
                if (!result) {
                    await replyEphemeral(api, interaction, { content: "❌ Failed to create a backup - check my permissions and try again." });
                    return true;
                }
                await db.logSecurityEvent(guildId, "backup", userId, null, { id: result.id });
                redis?.publish("security_event", "backup");
                await api.interactions.reply(interaction.id, interaction.token, {
                    content: `💾 Backup **#${result.id}** created — ${result.channels} channels, ${result.roles} roles stored.\n-# Use \`/backup list\` to restore it later.`,
                    allowed_mentions: { parse: [] },
                    flags: MessageFlags.Ephemeral,
                });
                return true;
            }

            if (subcommand === "list") {
                const backups = await db.getSecurityBackups(guildId, 10);
                if (backups.length === 0) {
                    await replyEphemeral(api, interaction, {
                        content: "No backups yet. Run `/backup create` (or enable the Auto-Backups module via `/security`).",
                    });
                    return true;
                }
                const rows = backups.map(b =>
                    `**#${b.id}** · <t:${b.created_at}:R> · ${b.meta?.channels ?? "?"} channels, ${b.meta?.roles ?? "?"} roles${b.reason ? ` · ${trim(b.reason, 50)}` : ""}`
                );
                const buttons = backups.slice(0, 5).map(b => ({
                    type: ComponentType.Button as const,
                    style: ButtonStyle.Danger as const,
                    label: `Restore #${b.id}`,
                    custom_id: `backup_restore:${b.id}`,
                }));
                await replyEphemeral(api, interaction, {
                    embeds: [{
                        title: "💾 Recent backups",
                        color: 0x5865f2,
                        description: rows.join("\n"),
                        footer: { text: `${backups.length} shown - restoring only recreates missing channels & roles` },
                    }],
                    components: [
                        { type: ComponentType.ActionRow, components: buttons },
                    ],
                });
                return true;
            }

            if (subcommand === "restore") {
                const idOption = subcommandOptions?.find(o => o.name === "id");
                const requestedId = idOption && "value" in idOption ? Number(idOption.value) : null;
                const backup = requestedId
                    ? await db.getSecurityBackup(guildId, requestedId)
                    : await db.getLatestSecurityBackup(guildId);
                if (!backup) {
                    await replyEphemeral(api, interaction, {
                        content: requestedId ? `❌ Backup #${requestedId} doesn't exist for this server.` : "❌ No backups yet - run `/backup create` first.",
                    });
                    return true;
                }
                await sendRestoreConfirm(api, interaction, backup.id, backup.created_at, backup.meta?.channels ?? 0, backup.meta?.roles ?? 0);
                return true;
            }
            return false;
        }

        // ------------------------- quarantine buttons -------------------------
        if (interaction.type === InteractionType.MessageComponent &&
            (interaction.data.custom_id.startsWith("q_approve:") || interaction.data.custom_id.startsWith("q_kick:"))) {
            const isApprove = interaction.data.custom_id.startsWith("q_approve:");
            const botUserId = interaction.data.custom_id.slice(isApprove ? "q_approve:".length : "q_kick:".length);

            if (!memberHas(interaction, PermissionFlagsBits.ManageGuild)) {
                await replyEphemeral(api, interaction, { content: "❌ You need the **Manage Server** permission to do that." });
                return true;
            }

            const error = isApprove
                ? await approveQuarantine(api, db, guildId, botUserId, userId)
                : await kickQuarantine(api, db, guildId, botUserId, userId);

            if (error) {
                await replyEphemeral(api, interaction, { content: `❌ ${error}` });
                return true;
            }

            // retire the buttons on the original alert
            await api.channels.editMessage(interaction.message.channel_id, interaction.message.id, {
                components: [],
            }).catch(() => null);

            await api.interactions.reply(interaction.id, interaction.token, {
                content: isApprove
                    ? `✅ <@${botUserId}> was approved by <@${userId}> - their roles are back.`
                    : `🗑️ <@${botUserId}> was kicked by <@${userId}>.`,
                allowed_mentions: { parse: [] },
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }

        // ------------------------- backup restore confirm -------------------------
        if (interaction.type === InteractionType.MessageComponent && interaction.data.custom_id.startsWith("backup_restore:")) {
            const backupId = Number(interaction.data.custom_id.slice("backup_restore:".length));
            const backup = await db.getSecurityBackup(guildId, backupId);
            if (!backup) {
                await replyEphemeral(api, interaction, { content: `❌ Backup #${backupId} no longer exists.` });
                return true;
            }
            await sendRestoreConfirm(api, interaction, backup.id, backup.created_at, backup.meta?.channels ?? 0, backup.meta?.roles ?? 0);
            return true;
        }

        if (interaction.type === InteractionType.MessageComponent && interaction.data.custom_id.startsWith("backup_do:")) {
            const backupId = Number(interaction.data.custom_id.slice("backup_do:".length));
            if (!memberHas(interaction, PermissionFlagsBits.ManageChannels) || !memberHas(interaction, PermissionFlagsBits.ManageRoles)) {
                await replyEphemeral(api, interaction, { content: "❌ You need **Manage Channels** and **Manage Roles** to restore a backup." });
                return true;
            }
            if (!hasAppPerms(interaction, PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageRoles)) {
                await replyEphemeral(api, interaction, { content: "❌ I need **Manage Channels** and **Manage Roles** to restore a backup." });
                return true;
            }

            const backup = await db.getSecurityBackup(guildId, backupId);
            if (!backup) {
                await replyEphemeral(api, interaction, { content: `❌ Backup #${backupId} no longer exists.` });
                return true;
            }

            await api.interactions.reply(interaction.id, interaction.token, {
                content: "⏳ Restoring…",
                allowed_mentions: { parse: [] },
                flags: MessageFlags.Ephemeral,
            });

            const result = await restoreBackup(api, backup, `Manual restore of #${backupId} by ${username}`);
            await recordSecurityEvent(db, redis, guildId, "restore", userId, null, {
                backup_id: backupId,
                channels: result.channelsCreated.length,
                roles: result.rolesCreated.length,
            });

            const cfg = await db.getSecurityConfig(guildId).catch(() => null);
            const embed: APIEmbed = {
                title: `♻️ Backup #${backupId} restored`,
                color: 0x57f287,
                description: trim(restoreSummary(result), 3900),
                timestamp: new Date().toISOString(),
                footer: { text: `restored by ${username}` },
            };
            await api.interactions.followUp(interaction.id, interaction.token, {
                embeds: [embed],
                allowed_mentions: { parse: [] },
                flags: MessageFlags.Ephemeral,
            }).catch(async () => {
                await api.channels.createMessage(interaction.message.channel_id, { embeds: [embed], allowed_mentions: { parse: [] } }).catch(() => null);
            });
            await sendSecurityLog(api, db, guildId, cfg, embed);
            return true;
        }
    } catch (err) {
        console.error(`Error with security interaction (${interaction.type === InteractionType.ApplicationCommand ? `/${(interaction.data as { name?: string }).name}` : interaction.type}): ${err}`);
    }
    return false;
}

async function sendRestoreConfirm(
    api: API | API2,
    interaction: APIInteraction,
    backupId: number,
    createdAt: number,
    channels: number,
    roles: number,
) {
    await replyEphemeral(api, interaction, {
        embeds: [{
            title: `♻️ Restore backup #${backupId}?`,
            color: 0xfee75c,
            description: [
                `Created <t:${createdAt}:R> · ${channels} channels, ${roles} roles`,
                "",
                "Only **missing** channels & roles are recreated - existing ones stay untouched.",
            ].join("\n"),
        }],
        components: [{
            type: ComponentType.ActionRow,
            components: [{
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                label: "Restore now",
                custom_id: `backup_do:${backupId}`,
            }],
        }],
    });
}
