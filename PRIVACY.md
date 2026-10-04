# Privacy Policy

Effective: September 12, 2026

Mirror of `http://45.93.249.214:63927/privacy` for Discord app verification.

## 1. Data we store

- **Server configuration:** server/channel/user IDs, chosen action, log channel, enabled experiments, custom messages, reinvite codes.
- **Moderation events:** server, channel and user IDs plus timestamp, action (ban/softban) and trigger reason.
- **What we never store:** message content. The bot reacts to the fact that a message was sent, not to what it says.

## 2. Public statistics

The public stats page shows aggregate numbers only (totals, daily counts). No user IDs, names, or per-user data are published.

## 2b. Shared spammer network (opt-in per server)

Servers that enable the shared-banlist experiment contribute one-way salted SHA-256 hashes of moderated user IDs (kept max 90 days). No raw IDs, names, or message content are shared. Participating servers check new members against these hashes and may temporarily timeout known spammers.

## 2c. Public leaderboard (opt-in per server)

Servers that enable the leaderboard experiment appear by name with their ban count on the public stats page.

## 2d. Ban-evasion detection

To recognize returning spammers, the bot stores usernames, display names and avatar IDs of moderated accounts (max 180 days). Matching happens on name plus avatar only — accounts without avatar are never matched. This data is never published.

## 3. Mod dashboard login

Optional Discord login (OAuth2, scopes `identify` + `guilds`) is used to show moderators their own servers' data. We keep a temporary in-memory session (24h) and store nothing else. Per-server details are only shown to users with ban permissions there.

## 4. Storage & deletion

Data lives in a local database on the bot's server. If you kick the bot, your server's data is kept for 3 days (so re-adding restores everything) and then permanently deleted to save storage. For any other deletion request contact the operator.

## 5. Contact

Operator contact: our Discord server: https://discord.gg/6QzDSBXQ6E
