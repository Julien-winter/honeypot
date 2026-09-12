export const EMOJI = "🍯";
// Custom honeypot emoji for reactions/buttons. Must come from a server the bot is in.
export const CUSTOM_EMOJI_ID = process.env.CUSTOM_EMOJI_ID || "1548306645812121741";
export const CUSTOM_EMOJI = `<:honeypot:${CUSTOM_EMOJI_ID}>`;

export const HAS_MESSAGE_INTENT = process.env.HAS_MESSAGE_INTENT === "true" || process.env.HAS_MESSAGE_INTENT === "1";
