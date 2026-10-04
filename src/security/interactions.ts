import {
    ButtonStyle,
    ChannelType,
    ComponentType,
    InteractionType,
    MessageFlags,
    PermissionFlagsBits,
    SelectMenuDefaultValueType,
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
import { createBackup } from "./backup";
import { sendSecurityLog } from "./notify";
import {
    getRestoreApprovers,
    isRestoreApprover,
    logRestoreResult,
    restoreStatusLine,
    runRestore,
    type RunRestoreOutcome,
} from "./restore-run";

/** One pending manual restore request per guild (no repeated pings). */
const pendingRestores = new Map<string, { requester: string; expires: number }>();

/** Drop a pending manual request - used when the anti-nuke takes over on its own. */
export function clearPendingRestore(guildId: string): boolean {
    return pendingRestores.delete(guildId);
}

const RESTORE_REQUEST_TTL = 5 * 60_000;

/** Run a restore that has been approved (by an approver directly, or via the button flow). */
async function startApprovedRestore(
    api: API | API2,
    db: DbModule,
    redis: Bun.RedisClient | undefined,
    guildId: string,
    applicationId: string,
    channelId: string | null,
    requestedBy: string | null,
    approvedBy: string,
): Promise<RunRestoreOutcome> {
    const cfg = await db.getSecurityConfig(guildId).catch(() => null);
    const outcome = await runRestore(api, db, redis, guildId, {
        reason: "Manual restore (approved)",
        channelId,
        requestedBy,
        approvedBy,
        backupAfter: true,
    });
    await logRestoreResult(api, db, guildId, cfg, outcome, approvedBy);
    return outcome;
}

type ShownModule = Exclude<SecurityModule, "backups">;
const MODULE_LABELS: Record<ShownModule, { label: string; emoji: string; description: string }> = {
    anti_nuke: { label: "Anti-Nuke & Restore", emoji: "🛡️", description: "Mass channel/role deletions: strips the attacker, auto-rebuilds from snapshots" },
    quarantine: { label: "Bot Quarantine", emoji: "🔒", description: "New bots join without permissions until approved" },
    anti_spam: { label: "Anti-Spam", emoji: "🚫", description: "Floods, mass mentions and coordinated raids" },
    anti_phishing: { label: "Anti-Phishing", emoji: "🔗", description: "Removes fake nitro / token stealer links" },
    event_log: { label: "Event Log", emoji: "📜", description: "Logs every change (channels, roles, bans, invites…)" },
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

function memberHas(interaction: APIInteraction, bits: bigint): boolean {
    if (!interaction.member) return true; // e.g. dm-installed context shouldn't happen here
    return hasPermission(BigInt(interaction.member.permissions ?? "0"), bits);
}

/**
 * Handles everything the security modules add to InteractionCreate:
 * /security (modal) and the quarantine approval buttons.
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
            const moduleOptions: APISelectMenuOption[] = (Object.keys(MODULE_LABELS) as ShownModule[]).map((module) => ({
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
                        content: `❌ Only the **server owner** or an **administrator** can turn off: ${disabling.map(m => MODULE_LABELS[m as ShownModule]?.label ?? m).join(", ")}.\n-# This protects you against a rogue moderator disabling your protection.`,
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
                backups: enabled.has("anti_nuke"),
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
            let pendingInitial = false;
            let existingSnapshotId: number | null = null;
            if (newConfig.anti_nuke || newConfig.backups) {
                const latest = await db.getLatestSecurityBackup(guildId).catch(() => null);
                if (latest) existingSnapshotId = latest.id;
                else {
                    pendingInitial = true;
                    initialBackup = await createBackup(api, db, guildId, "initial (security setup)").catch(() => null);
                    if (initialBackup) pendingInitial = false;
                }
            }

            const lines = (Object.keys(MODULE_LABELS) as ShownModule[])
                .map(m => `${newConfig[m] ? "✅" : "⚪"} ${MODULE_LABELS[m].emoji} **${MODULE_LABELS[m].label}**`);
            const notes: string[] = [];
            if (newConfig.event_log && newConfig.event_log_channel_id) notes.push(`Event log → <#${newConfig.event_log_channel_id}>`);
            if (newConfig.anti_spam || newConfig.anti_phishing) notes.push(`Spam sensitivity: **${levelCfg.label}**`);
            if (newConfig.anti_nuke) notes.push(`Anti-nuke response: **${nukeAction === "strip_ban" ? "strip roles + ban" : nukeAction}**`);
            if (newConfig.anti_phishing && !HAS_MESSAGE_INTENT) notes.push("⚠️ Anti-Phishing needs `HAS_MESSAGE_INTENT=1` (Message Content Intent) to read links.");
            if (initialBackup) notes.push(`Initial backup created: **#${initialBackup.id}** (${initialBackup.channels} channels, ${initialBackup.roles} roles).`);
            else if (existingSnapshotId !== null) notes.push(`Auto-backup active from snapshot **#${existingSnapshotId}** (refreshed every 10 min, only when something changed).`);
            else if (pendingInitial) notes.push("Auto-backup runs every **10 minutes** (first one may take up to 10 min).");

            const showRestoreButton = newConfig.anti_nuke || newConfig.backups;
            if (showRestoreButton) {
                const status = await restoreStatusLine(db, guildId).catch(() => null);
                if (status) notes.push(status);
            }

            await api.interactions.reply(interaction.id, interaction.token, {
                embeds: [{
                    title: "🛡️ Security settings saved",
                    color: 0x57f287,
                    description: lines.join("\n") + (notes.length ? `\n\n${notes.join("\n")}` : ""),
                    timestamp: new Date().toISOString(),
                    footer: { text: `configured by ${username}` },
                }],
                components: showRestoreButton ? [{
                    type: ComponentType.ActionRow,
                    components: [{
                        type: ComponentType.Button,
                        style: ButtonStyle.Secondary,
                        label: "Restore from latest snapshot",
                        emoji: { name: "♻️" },
                        custom_id: "sec_restore",
                    }],
                }] : undefined,
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
            if (pendingInitial) {
                createBackup(api, db, guildId, "initial (security setup)").then(result => {
                    if (result) console.log(styleText("dim", `[backup] ${guildId}: initial #${result.id}`));
                });
            }
            return true;
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

        // ------------------------- restore: request button -------------------------
        if (interaction.type === InteractionType.MessageComponent && interaction.data.custom_id === "sec_restore") {
            const isApprover = await isRestoreApprover(api, guildId, userId, interaction.application_id).catch(() => false);

            // an approver may run it directly - no approval round-trip needed
            if (isApprover) {
                const backup = await db.getLatestSecurityBackup(guildId).catch(() => null);
                if (!backup) {
                    await replyEphemeral(api, interaction, { content: "❌ **No snapshot available yet** - the first backup runs within 10 minutes of enabling Anti-Nuke." });
                    return true;
                }
                await replyEphemeral(api, interaction, { content: `♻️ **Restore started** from snapshot #${backup.id} - follow the progress message in this channel.` });
                await startApprovedRestore(api, db, redis, guildId, interaction.application_id, interaction.channel_id ?? null, userId, userId);
                return true;
            }

            // otherwise exactly ONE approval request goes out to an approver
            const now = Date.now();
            const pending = pendingRestores.get(guildId);
            if (pending && pending.expires > now) {
                await replyEphemeral(api, interaction, {
                    content: `⏳ A restore request from <@${pending.requester}> is already pending approval.\n-# One request at a time - no duplicate pings are sent.`,
                });
                return true;
            }
            pendingRestores.delete(guildId);

            const approvers = await getRestoreApprovers(api, guildId, interaction.application_id).catch(() => []);
            const target = approvers.find(id => id !== userId) ?? approvers[0];
            if (!target || !interaction.channel_id) {
                await replyEphemeral(api, interaction, { content: "❌ No approver could be determined for this server." });
                return true;
            }
            pendingRestores.set(guildId, { requester: userId, expires: now + RESTORE_REQUEST_TTL });

            await api.channels.createMessage(interaction.channel_id, {
                content: `♻️ **Restore approval requested**\n<@${target}> - <@${userId}> wants to restore this server from the latest snapshot.\nOnly the **server owner** or the **bot owner** can approve. *Expires in 5 minutes.*`,
                components: [{
                    type: ComponentType.ActionRow,
                    components: [
                        { type: ComponentType.Button, style: ButtonStyle.Success, label: "Approve restore", emoji: { name: "✅" }, custom_id: "restore_ok" },
                        { type: ComponentType.Button, style: ButtonStyle.Danger, label: "Cancel", emoji: { name: "✖️" }, custom_id: "restore_no" },
                    ],
                }],
                allowed_mentions: { users: [target] },
            }).catch(() => null);

            await replyEphemeral(api, interaction, {
                content: `⏳ Approval requested from <@${target}>.\n-# Expires in 5 minutes; only one request can be open at a time.`,
            });
            return true;
        }

        // ------------------------- restore: approve / cancel buttons -------------------------
        if (interaction.type === InteractionType.MessageComponent &&
            (interaction.data.custom_id === "restore_ok" || interaction.data.custom_id === "restore_no")) {
            const approve = interaction.data.custom_id === "restore_ok";
            const pending = pendingRestores.get(guildId);
            const retireButtons = () => api.channels.editMessage(interaction.message.channel_id, interaction.message.id, {
                components: [],
            }).catch(() => null);

            if (!pending || pending.expires < Date.now()) {
                pendingRestores.delete(guildId);
                await retireButtons();
                await replyEphemeral(api, interaction, { content: "⌛ This restore request has expired - ask for a new one with the Restore button." });
                return true;
            }

            const isApprover = await isRestoreApprover(api, guildId, userId, interaction.application_id).catch(() => false);

            if (!approve) {
                if (userId !== pending.requester && !isApprover) {
                    await replyEphemeral(api, interaction, { content: "❌ Only the requester or an approver can cancel this request." });
                    return true;
                }
                pendingRestores.delete(guildId);
                await retireButtons();
                await replyEphemeral(api, interaction, { content: `🗑️ Restore request by <@${pending.requester}> was cancelled.` });
                return true;
            }

            if (!isApprover) {
                await replyEphemeral(api, interaction, {
                    content: "❌ Only the **server owner** or the **bot owner** can approve a restore.\n-# This keeps a restore a deliberate, single-approval action.",
                });
                return true;
            }

            pendingRestores.delete(guildId);
            await retireButtons();

            const backup = await db.getLatestSecurityBackup(guildId).catch(() => null);
            if (!backup) {
                await replyEphemeral(api, interaction, { content: "❌ **No snapshot available yet** - the first backup runs within 10 minutes of enabling Anti-Nuke." });
                return true;
            }

            await replyEphemeral(api, interaction, {
                content: `✅ **Approved** by <@${userId}> - restoring snapshot #${backup.id}. Follow the progress message below.`,
            });
            await startApprovedRestore(api, db, redis, guildId, interaction.application_id, interaction.channel_id ?? null, pending.requester, userId);
            return true;
        }

    } catch (err) {
        console.error(`Error with security interaction (${interaction.type === InteractionType.ApplicationCommand ? `/${(interaction.data as { name?: string }).name}` : interaction.type}): ${err}`);
    }
    return false;
}
