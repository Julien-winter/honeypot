import { type RESTPostAPIChannelMessageJSONBody, MessageFlags, ComponentType, ButtonStyle, PermissionFlagsBits, type APIUser, type APIComponentInContainer, type PartialAPIMessageInteractionGuildMember, type APIThumbnailComponent } from "discord-api-types/v10";
import type { HoneypotConfig } from "./db";
import { getDiscordDate, getDiscordDateMention } from "./tools";
import { CUSTOM_EMOJI_ID } from "./constants";

const honeypotThumbnail: APIThumbnailComponent = {
  type: ComponentType.Thumbnail,
  media: {
    url: getThumbnailUrl()
  }
}

// Use this instance's own links instead of the official bot's, so self-hosted
// copies don't advertise someone else's bot. All overridable via env.
function getOwnApplicationId(): string {
  const token = process.env.DISCORD_TOKEN || "";
  try {
    const id = atob(token.split(".")[0]!);
    if (/^\d+$/.test(id)) return id;
  } catch { /* ignore malformed tokens */ }
  return "";
}
export function getInviteUrl(): string {
  if (process.env.INVITE_URL) return process.env.INVITE_URL;
  const appId = getOwnApplicationId() || "1450060292716494940";
  return `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=${invitePermissions}&scope=bot+applications.commands`;
}
// Minimal permission set the bot needs (ban, manage channels/messages, read/send, invite, timeout).
const invitePermissions = (
  PermissionFlagsBits.CreateInstantInvite |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.ModerateMembers
).toString();
// Public base URL of this instance (e.g. http://1.2.3.4:3000), if detectable.
function getPublicBaseUrl(): string | null {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = process.env.SERVER_IP || "";
  const port = process.env.STATS_PORT || process.env.SERVER_PORT || process.env.PORT || "";
  if (host && host !== "0.0.0.0" && port) return `http://${host}:${port}`;
  return null;
}
export function getDocsUrl(): string {
  if (process.env.DOCS_URL) return process.env.DOCS_URL;
  const base = getPublicBaseUrl();
  return base ? `${base}/docs` : "https://honeypot.riskymh.dev/docs";
}
export function getStatsPageUrl(): string {
  if (process.env.STATS_PAGE_URL) return process.env.STATS_PAGE_URL;
  return getPublicBaseUrl() ?? "https://honeypot.riskymh.dev/#stats";
}
export function getSiteUrl(): string {
  return getPublicBaseUrl() ?? "https://honeypot.riskymh.dev";
}
export function getRecoveryUrl(): string {
  if (process.env.RECOVERY_URL) return process.env.RECOVERY_URL;
  const base = getPublicBaseUrl();
  return base ? `${base}/docs#hacked-account` : "https://honeypot.riskymh.dev/blog/discord-account-hacked-recovery";
}

export function getThumbnailUrl(): string {
  return process.env.THUMBNAIL_URL || "https://honeypot.riskymh.dev/honeypot.png";
}
export function getDashboardUrl(): string {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  const base = getPublicBaseUrl();
  return base ? `${base}/dashboard` : "https://honeypot.riskymh.dev/#stats";
}

export function honeypotWarningMessage(
  moderatedCount: number = 0,
  action: HoneypotConfig["action"] = 'softban',
  customText?: string | null
): RESTPostAPIChannelMessageJSONBody {
  const actionTextMap = {
    ban: { text: 'an immediate ban', label: 'Bans' },
    softban: { text: 'a softban', label: 'Kicks' },
    kick: { text: 'a softban', label: 'Kicks' },
    disabled: { text: 'no action (honeypot is disabled)', label: 'Triggers' }
  };
  const { text: actionText, label: labelText } = actionTextMap[action] || actionTextMap.ban!;
  const { text: messageText, imageUrls } = customText ? extractPossibleImages(customText) : { text: null, imageUrls: null };

  return {
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: {},
    components: [
      {
        type: ComponentType.Container,
        components: ([
          (messageText || !imageUrls) ? {
            type: ComponentType.Section,
            components: [{
              type: ComponentType.TextDisplay,
              content: messageText?.replace(/\{\{action(:text)?\}\}/g, actionText)
                || `## DO NOT SEND MESSAGES IN THIS CHANNEL\n\nThis channel is used to catch spam bots. Any messages sent here will result in **${actionText}**.`
                + (moderatedCount > 0 ? `\n\n🍯 Already caught **${moderatedCount.toLocaleString()}** spam accounts here.` : "")
            }],
            accessory: honeypotThumbnail
          } as const : null,
          (imageUrls && imageUrls.length > 0) ? {
            type: ComponentType.MediaGallery,
            items: imageUrls.map(url => ({ media: { url } }))
          } as const : null,
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: `${labelText}: ${moderatedCount.toLocaleString()}`,
                custom_id: "moderated_count_button",
                // disabled: true,
                emoji: { name: "🍯" }
              }
            ]
          }
        ] satisfies (APIComponentInContainer | null)[]).filter(e => !!e),
      },
    ]
  };
}

export const defaultHoneypotWarningMessage = "## DO NOT SEND MESSAGES IN THIS CHANNEL\n\nThis channel is used to catch spam bots. Any messages sent here will result in **{{action:text}}**.";

const pastTenseActionText = {
  ban: 'banned',
  kick: 'kicked',
  softban: 'kicked',
  disabled: '???it is disabled???'
} as const
export function honeypotUserDMMessage(userId: string, action: HoneypotConfig["action"], guildName: string, discoverableLink: string | undefined, link: string, reinviteUrl: string | null, isAdmin = false, customText?: string | null): RESTPostAPIChannelMessageJSONBody {
  const actionText = pastTenseActionText[action] || '???unknown action???';

  let containerComponents: APIComponentInContainer[] = []
  if (!customText) {
    containerComponents = [
      {
        type: ComponentType.Section,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: `## Honeypot Triggered\nHey <@${userId}>, you have been **${actionText}** from **${discoverableLink ? `[${guildName}](${discoverableLink})` : guildName}** for sending a message in the [honeypot](${link}) channel.`
              + `\n\nThis may have happened if someone gained access to your account through malware, stolen sessions or leaked passwords. Please [recover your account](${getRecoveryUrl()}), scan your device and reinstall your OS if needed.`
          },
          ...(reinviteUrl ? [{
            type: ComponentType.TextDisplay,
            content: `You can rejoin via ${reinviteUrl}`
          }] as const : []),
        ],
        accessory: honeypotThumbnail,
      },
    ]
  } else {
    const { text: messageText, imageUrls } = extractPossibleImages(customText);
    if (messageText) containerComponents.push({
      type: ComponentType.Section,
      components: [{
        type: ComponentType.TextDisplay,
        content: messageText
          .replace(/\{\{action(:text)?\}\}/g, actionText)
          .replace(/\{\{server:name:?\}\}/g, guildName)
          .replace(/\{\{server:name:linked\}\}/g, discoverableLink ? `[${guildName}](${discoverableLink})` : guildName)
          .replace(/\{\{honeypot:channel:link\}\}/g, link)
          .replace(/\{\{server:public-link\}\}/g, discoverableLink || "https://discord.com/servers")
          .replace(/\{\{reinvite:link\}\}/g, reinviteUrl || "*<invite link not available>*")
          .replace(/\{\{user:mention\}\}/g, `<@${userId}>`)
      }],
      accessory: honeypotThumbnail
    })
    if (imageUrls && imageUrls.length > 0) containerComponents.push({
      type: ComponentType.MediaGallery,
      items: imageUrls.map(url => ({ media: { url } }))
    });
  };

  return {
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: {},
    components: [
      {
        type: ComponentType.Container,
        accent_color: 0xFFD700,
        components: [
          ...containerComponents,
          {
            type: ComponentType.TextDisplay,
            content: `-# Automated message ${customText ? "customized by" : "sent on behalf of"} **${guildName}**. Replies are not monitored.`
          },
        ]
      },
      ...(isAdmin ? [{
        type: ComponentType.TextDisplay,
        content: `-# This is an example message: as an admin you can’t be ${actionText}.`
      }] as const : [])
    ]
  }
}

export function getDefaultHoneypotUserDMMessage(): string {
  return "## Honeypot Triggered\n\nHey {{user:mention}}, you have been **{{action:text}}** from **{{server:name}}** for sending a message in the [honeypot]({{honeypot:channel:link}}) channel."
    + `\n\nThis may have happened if someone gained access to your account through malware, stolen sessions or leaked passwords. Please [recover your account](${getRecoveryUrl()}), scan your device and reinstall your OS if needed.`;
}
// Kept for backwards compatibility (custom messages saved earlier equaled this text).
export const defaultHoneypotUserDMMessage = "## Honeypot Triggered\n\nHey {{user:mention}}, you have been **{{action:text}}** from **{{server:name}}** for sending a message in the [honeypot]({{honeypot:channel:link}}) channel."
  + "\n\nThis may have happened if someone gained access to your account through malware, stolen sessions or leaked passwords. Please recover your account, scan your device and reinstall your OS if needed.";
export const defaultHoneypotUserDMMessageReinvitePart = "\n\nYou can rejoin via {{reinvite:link}}";

export function logActionMessage(user: Partial<APIUser> & { id: string }, member: PartialAPIMessageInteractionGuildMember | null, honeypotChannelId: string, action: HoneypotConfig["action"], customText?: string | null, moderatedCount: number = 0): RESTPostAPIChannelMessageJSONBody {
  const actionText = pastTenseActionText[action] || '???unknown action???';
  const mention = `<@${user.id}>`;
  const channelMention = `<#${honeypotChannelId}>`;

  const replacements = {
    "user:id": user.id,
    "user": mention, "user:ping": mention, "user:mention": mention,
    "user:name": user?.username || user.id,
    "user:global-name": user?.global_name || user?.username || user.id,
    "user:created": () => getDiscordDateMention(getDiscordDate(user.id)),
    "member:name": member?.nick || "*none*",
    "member:nickname": member?.nick || "*none*",
    "member:joined": member?.joined_at ? () => getDiscordDateMention(new Date(member.joined_at!)) : "*unknown join date?*",
    "member:roles": member?.roles?.length ? () => member.roles.map(id => `<@&${id}>`).join(", ") : "*no roles*",
    "action": actionText,
    "action:text": actionText,
    "honeypot:channel": channelMention,
    "honeypot:channel:mention": channelMention,
    "honeypot:channel:ping": channelMention,
    "honeypot:moderation-count": () => moderatedCount.toLocaleString(),
  } satisfies Record<string, string | (() => string)>;
  const str = (val: string | (() => string)) => typeof val === "function" ? val() : val; 

  const text =
    customText?.replace(/\{\{([^}]+)\}\}/g, (_, key: keyof typeof replacements) => {
      const value = replacements[key];
      if (value == null) return `{{${key}}}`;
      return typeof value === "function" ? value() : value;
    }) ?? `${mention} was ${actionText} for triggering the honeypot in ${channelMention}\n` +
    `-# User ID: \`${user.id}\` • Created: ${replacements["user:created"]()} • Joined: ${str(replacements["member:joined"])}`;

  if (action !== 'ban') {
    return {
      allowed_mentions: {},
      content: text
    };
  }

  return {
    allowed_mentions: {},
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Section,
        components: [{
          type: ComponentType.TextDisplay,
          content: text
        }],
        accessory: {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "Unban",
          custom_id: `unban:${user.id}`,
        }
      }
    ]
  }
}

export const defaultLogActionMessage = "{{user:mention}} was {{action:text}} for triggering the honeypot in {{honeypot:channel:mention}}\n-# User ID: `{{user:id}}` • Created: {{user:created}} • Joined: {{member:joined}}";


const imageUrlRegex = /^https:\/\/[^\s\/]+\.[a-zA-Z]{2,}\/[^\s?#]*\.(?:png|jpg|jpeg|gif|webp|avif|mp4|mov)(?:[?#][^\s]*)?$/i;
function extractPossibleImages(text: string): { text: string | null, imageUrls: string[] | null } {
  if (!text) return { text: null, imageUrls: null };
  const lines = text.split("\n");
  const imageUrls: string[] = [];
  let consumed = 0;
  for (const raw of lines.toReversed()) {
    const line = raw.trim();
    if (!line) { consumed++; continue; }
    if (!imageUrlRegex.test(line)) break;
    imageUrls.push(line);
    consumed++;
  }
  if (imageUrls.length > 0) {
    const newText = lines.slice(0, lines.length - consumed).join("\n").trim();
    return { text: newText || null, imageUrls: imageUrls.reverse() };
  }
  return { text, imageUrls: null };
}

export function statsMessage(globalStatsText: string, serverStatsText: string | null, userStatsText: string | null): RESTPostAPIChannelMessageJSONBody {
  return {
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: {},
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "## What is a Honeypot?",
          },
          {
            type: ComponentType.TextDisplay,
            content: "A **honeypot** is a channel used to detect unwanted activity.",
          },
          {
            type: ComponentType.TextDisplay,
            content: "Honeypot watches a channel that is visible to members but not intended for normal use. Spam bots and compromised accounts may send messages to it while scanning or posting across a server.",
          },
          {
            type: ComponentType.TextDisplay,
            content: "When a message is sent to the honeypot channel, Honeypot can automatically remove the user by banning or kicking them.",
          },
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                url: getInviteUrl(),
                style: ButtonStyle.Link,
                label: "Invite Bot",
                emoji: { name: "honeypot", id: CUSTOM_EMOJI_ID }
              },
              {
                type: ComponentType.Button,
                url: getDocsUrl(),
                style: ButtonStyle.Link,
                label: "Documentation"
              },
              {
                type: ComponentType.Button,
                url: getDashboardUrl(),
                style: ButtonStyle.Link,
                label: "Dashboard"
              },
            ]
          },
        ],
      },
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.Section,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: "## Honeypot Statistics",
              },
              {
                type: ComponentType.TextDisplay,
                content: serverStatsText ? `**Server Stats:**\n${serverStatsText}`
                  : userStatsText ? `**User Stats:**\n${userStatsText}`
                    : "*No server or user stats available.*",
              },
            ],
            accessory: honeypotThumbnail,
          },
          {
            type: ComponentType.TextDisplay,
            content: "**Global Stats:**\n" + globalStatsText,
          },
          {
            type: ComponentType.Section,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `-# I wonder when this counter will stop increasing...\n-# ${[
                  "Apparently, there is still plenty of spam to catch.",
                  "That's a lot of spam messages caught so far.",
                  "There is, unfortunately, no shortage of spam.",
                  "Somehow, people are still finding the honeypot.",
                ][Math.floor(Math.random() * 4)]}`,
              }
            ],
                accessory: {
                  type: ComponentType.Button,
                  url: getStatsPageUrl(),
                  style: ButtonStyle.Link,
                  label: "Live Stats"
                }
          },
        ],
      },
    ]
  } as const
}
