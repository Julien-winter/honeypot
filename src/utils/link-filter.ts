import { PermissionFlagsBits, RESTJSONErrorCodes } from "discord-api-types/v10";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";
import { DiscordAPIError } from "@discordjs/rest";
import { styleText } from "node:util";
import { hasPermission, normalizeText } from "./tools";
import { HAS_MESSAGE_INTENT } from "./constants";
import type { HoneypotConfig } from "./db";

// Default-on scam link filter (opt out per guild with the "no-link-filter"
// experiment). Only runs with the message content intent. Staff messages
// (Manage Messages permission) are never touched.

// Known-bad domains: IP loggers + obvious Discord/Steam impersonations.
const BLOCKED_DOMAINS = new Set([
    // ip loggers
    "iplogger.org", "iplogger.com", "iplogger.ru", "iplis.ru", "yip.su",
    "grabify.link", "grabify.org", "grabify.dev", "bmclicks.com",
    "bluemediafiles.com", "2no.co", "starbucksisbadforyou.com",
    // fake discord
    "disc0rd.com", "disc0rd.gg", "disc0rd.gift", "disccord.com", "dicord.com",
    "discrod.com", "discord-nitro.com", "discordnitro.com", "discordgift.com",
    "disword.com", "discorcl.com", "discord-nitro-free.com", "free-nitro.com",
    "nitro-discord.com",
    // fake steam
    "steancommunity.com", "steamcommunlty.com", "steamcommunityr.com",
    "stemcommunity.com", "steamcommiunity.com", "streamcommunity.com",
]);

// Legit Discord domains (everything else containing "discord" is suspicious).
const DISCORD_ALLOWLIST = [
    "discord.com", "discord.gg", "discord.gift", "discordapp.com",
    "discordapp.net", "discord.co", "discord.media", "discord.me",
    "discordservers.com", "discordbots.org",
];

const urlRegex = /https?:\/\/[^\s<>()[\]]+/gi;

function hostAllowedDiscord(host: string): boolean {
    return DISCORD_ALLOWLIST.some((a) => host === a || host.endsWith(`.${a}`));
}

/** Returns the matched bad domain, or null if the text looks clean. */
export function findScamLink(content: string): string | null {
    if (!content) return null;
    const urls = content.match(urlRegex);
    if (!urls) return null;
    for (let raw of urls) {
        raw = raw.replace(/[.,!?;:)\]]+$/, "");
        let host: string;
        try {
            host = new URL(raw).hostname.toLowerCase();
        } catch {
            continue;
        }
        const bare = host.replace(/^www\./, "");
        if (BLOCKED_DOMAINS.has(bare)) return bare;
        // catch obfuscations like disc0rd-nitro.gift: unicode lookalikes first,
        // then aggressive leet mapping (only "discord" lookalikes can match,
        // legit domains never normalize to containing "discord")
        const norm = normalizeText(bare)
            .replace(/0/g, "o").replace(/1/g, "i").replace(/l/g, "i")
            .replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t");
        if (norm.includes("discord") && !hostAllowedDiscord(norm) && !hostAllowedDiscord(bare)) return bare;
    }
    return null;
}

const LINK_TIMEOUT_MS = 10 * 60_000; // 10 minutes

export async function maybeFilterLink(opts: {
    api: API | API2;
    guildId: string;
    channelId: string;
    userId: string;
    messageId?: string;
    content?: string | null;
    memberPermissions?: string | null;
    config: HoneypotConfig;
}): Promise<boolean> {
    const { api, guildId, channelId, userId, messageId, content, memberPermissions, config } = opts;
    if (!HAS_MESSAGE_INTENT || !content) return false;
    if (config.experiments.includes("no-link-filter")) return false;
    // never touch staff messages
    if (memberPermissions) {
        try {
            if (hasPermission(BigInt(memberPermissions), PermissionFlagsBits.ManageMessages)) return false;
        } catch { /* fall through and filter */ }
    }
    const hit = findScamLink(content);
    if (!hit) return false;

    if (messageId) {
        try {
            await api.channels.deleteMessage(channelId, messageId, { reason: `Scam link removed (${hit})` });
        } catch (err) {
            if (err instanceof DiscordAPIError && (err.code === RESTJSONErrorCodes.MissingAccess || err.code === RESTJSONErrorCodes.MissingPermissions)) {
                console.log(styleText("dim", `Link filter: missing permissions to delete in ${channelId}: ${err}`));
            } else {
                console.log(`Link filter: failed to delete message: ${err}`);
            }
            return false;
        }
    }
    await api.guilds.editMember(
        guildId,
        userId,
        { communication_disabled_until: new Date(Date.now() + LINK_TIMEOUT_MS).toISOString() },
        { reason: `Scam link posted (${hit})` },
    ).catch((err) => console.log(styleText("dim", `Link filter: timeout failed: ${err}`)));

    if (config.log_channel_id) {
        await api.channels.createMessage(config.log_channel_id, {
            content: `🛡️ Deleted scam link (\`${hit}\`) from <@${userId}> in <#${channelId}> (10min timeout).`,
            allowed_mentions: {},
        }).catch(() => null);
    } else {
        console.log(styleText("dim", `Link filter: removed scam link (${hit}) from ${userId} in ${channelId}`));
    }
    return true;
}
