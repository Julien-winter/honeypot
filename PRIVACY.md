# Privacy Policy

Effective: September 12, 2026

Mirror of `http://45.93.249.214:63927/privacy` for Discord app verification.

## 1. Data we store

- **Server configuration:** server/channel/user IDs, chosen action, log channel, enabled experiments, custom messages, reinvite codes.
- **Moderation events:** server, channel and user IDs plus timestamp, action (ban/softban) and trigger reason.
- **What we never store:** message content. The bot reacts to the fact that a message was sent, not to what it says.

## 2. Public statistics

The public stats page shows aggregate numbers only (totals, daily counts). No user IDs, names, or per-user data are published.

## 3. Mod dashboard login

Optional Discord login (OAuth2, scopes `identify` + `guilds`) is used to show moderators their own servers' data. We keep a temporary in-memory session (24h) and store nothing else. Per-server details are only shown to users with ban permissions there.

## 4. Storage & deletion

Data lives in a local database on the bot's server. Kicking the bot deletes its configuration for that server automatically. For any other deletion request contact the operator.

## 5. Contact

Operator contact: our Discord server (ID `1546167772831285271`).
