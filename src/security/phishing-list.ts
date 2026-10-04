import lookalikeChars from "../utils/lookalike-chars.yaml";

/** Domains that are always trusted (official Discord / Steam / Microsoft properties). */
const ALLOWED_SUFFIXES = [
    "discord.com",
    "discordapp.com",
    "discord.gg",
    "discord.media",
    "discordstatus.com",
    "discord-activities.com",
    "steamcommunity.com",
    "steampowered.com",
    "steamstatic.com",
    "steamcontent.com",
    "unrealengine.com",
    "epicgames.com",
    "microsoft.com",
    "xbox.com",
    "obsidian.md",
];

/**
 * Known phishing / scam domains (fake nitro, account stealers, token loggers).
 * Matched as an exact host or as a parent domain of the URL host.
 */
export const PHISHING_DOMAINS: string[] = [
    // fake Discord / nitro
    "discorcl.com", "discorcl.net", "discorcl.org", "discorcl.shop",
    "discord-nitro.com", "discord-nitro.net", "discord-nitro.org", "discord-nitro.gift",
    "discordairdrop.com", "discord-gifts.com", "discordgift.shop", "discord-gift.ru",
    "discordnitro.ru", "nitro-discord.com", "free-nitro.xyz", "discordfoil.com",
    "discorcl-gift.com", "discorclnitro.com", "discond.app", "discorcl.app",
    "discordevents.co", "discord-community.com", "discordbonus.ru", "discordcheck.ru",
    "discorclnitro.ru", "nitrodiscord.ru", "discordgift.ru", "discorcl-gift.ru",
    "discord-prize.com", "discorcl.site", "discordevents.ru", "discorclgift.com",
    "dicsord.app", "dlscord.com", "dlscord.ru", "dlscord-nitro.com",
    "nitro.gift", "freNitro.ru", "discorcl-auth.com", "discorcl-token.com",
    "discord-auth.com", "discord-token.ru", "discorcl-login.com", "discordlogin.ru",
    "harmonydiscrod.com", "discorb.pro", "discorcl.pro",

    // fake Steam
    "steamcommunlty.com", "steamcommunlty.ru", "steamcommunlty.net", "steamcommunlty.top",
    "steamcommunlty.it", "steamcommunlty.xyz", "steamcommunlty.org", "steemcommunity.com",
    "steamcommunty.com", "steam-communlty.com", "steamcommunlty.cc", "steamcommunity.ru",
    "steam-gift.com", "steam-gift.ru", "steambalance.ru", "steamcommunity.top",
    "steamcommunlty.co", "steamnft.ru",

    // fake Epic / giveaways / other stealers
    "epicgames.gift", "free-epicgames.com", "epicfree.ru", "fortnite-gift.com",
    "robux-shop.ru", "free-robux.ru", "freerobux.gg", "rbxplace.com",

    // token loggers / IP loggers
    "grabify.link", "iplogger.org", "iplogger.ru", "blasze.com", "ps3cfw.com",
    "webresolver.nl", "yip.su", "clickme.net", "maper.tk", "hotcoin.ru",
    "tostig.net", "nosdscord.com", "discorcl-token.site", "disctord.app",
    "discorcl.help", "discorcl.info", "support-steam.com", "help-steam.com",
    "steam-support.top", "steamlive.ru", "stearncommunlty.com",
];

/** Patterns that flag a message/URL even when the domain isn't in the list. */
export const PHISHING_PATTERNS: { re: RegExp; label: string }[] = [
    { re: /\b(?:free|claim|giveaway|win)\s+(?:\w+\s+){0,3}nitro\b/i, label: "free nitro bait" },
    { re: /\bnitro\s+(?:generator|free\s*gift|giveaway|claim|link)\b/i, label: "nitro generator scam" },
    { re: /\bdisc(?:ord|orcl|0rd|orcl|ond)[\w-]*\.(?:gift|xyz|club|info|top|ru|icu|click|fun|site|online|store|buzz|help|pro|app|shop)\b/i, label: "fake discord domain" },
    { re: /\bsteamcomm(?:un)?lty[\w-]*\.(?:com|ru|net|org|xyz|top|site|it|cc|co)\b/i, label: "fake steam domain" },
    { re: /\b(?:your\s+)?(?:account|password|token)\s+(?:will\s+be\s+)?stolen\b/i, label: "token stealer" },
    { re: /\blogin\s+(?:qr|scam|discord)\b/i, label: "fake login" },
];

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;
const BARE_HOST_RE = /(?:^|[\s(<[])((?:[a-z0-9][\w-]*\.)+[a-z]{2,24})\b/i;

function isAllowedHost(host: string): boolean {
    const h = host.toLowerCase();
    return ALLOWED_SUFFIXES.some(suffix => h === suffix || h.endsWith("." + suffix));
}

/** Reverse the homoglyph table so "dіscorcl" (Cyrillic і) collapses back to ascii. */
const reverseLookalike: Record<string, string> = {};
try {
    const data = lookalikeChars as Record<string, string[] | string>;
    for (const [canonical, value] of Object.entries(data)) {
        if (Array.isArray(value)) for (const variant of value) reverseLookalike[variant] = canonical;
        else if (typeof value === "string") reverseLookalike[value] = canonical;
    }
} catch {
    // yaml failed to load - homoglyph detection just stays off
}

export function normalizeDomain(host: string): string {
    let out = "";
    for (const char of host.toLowerCase()) out += reverseLookalike[char] || char;
    return out;
}

function hostFromUrl(raw: string): string | null {
    try {
        const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
        return url.host.toLowerCase().replace(/^www\./, "");
    } catch {
        return null;
    }
}

export type PhishingMatch = { url: string; reason: string };

function checkHost(host: string): string | null {
    if (isAllowedHost(host)) return null;

    const normalized = normalizeDomain(host);
    // a host that only *looks* like discord/steam after normalisation was homoglyph-squatting
    if (normalized !== host && /(discord|stea[ms]|nitro|epic)/.test(normalized)) {
        return "lookalike domain (homoglyphs)";
    }
    // strip an optional subdomain chain and compare against the blocklist
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join(".");
        if (PHISHING_DOMAINS.includes(candidate)) return `known scam domain (${candidate})`;
    }
    return null;
}

/** Pull every URL / bare domain-ish token out of a message. */
export function extractUrls(text: string): string[] {
    const found: string[] = [];
    for (const match of text.matchAll(URL_RE)) found.push(match[0]);
    for (const match of text.matchAll(new RegExp(BARE_HOST_RE.source, "gi"))) {
        if (match[1]) found.push(match[1]);
    }
    return [...new Set(found)];
}

/** Returns the first phishing match in a piece of text, or null. */
export function findPhishingMatch(text: string): PhishingMatch | null {
    if (!text) return null;

    for (const url of extractUrls(text)) {
        const host = hostFromUrl(url);
        if (host) {
            const reason = checkHost(host);
            if (reason) return { url, reason };
        }
        for (const { re, label } of PHISHING_PATTERNS) {
            if (re.test(url)) return { url, reason: label };
        }
    }

    for (const { re, label } of PHISHING_PATTERNS) {
        if (re.test(text)) return { url: text.slice(0, 80), reason: label };
    }
    return null;
}
