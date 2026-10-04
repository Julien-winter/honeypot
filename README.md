
<h1 align="center">
  <a href="https://discord.com/discovery/applications/1450060292716494940" target="_blank">
    <img src="https://honeypot.riskymh.dev/honeypot.png" alt="Honey Pot Emoji" width="84">
  </a>
  <br>
  Honeypot Discord Bot
</h1>

> A Discord bot to automatically catch and remove spam bots by monitoring a dedicated "#honeypot" channel.

## Usage

1. [**Invite the bot**](https://discord.com/oauth2/authorize?client_id=1450060292716494940) to your server with appropriate permissions (Ban Members, Manage Channels, etc).
2. The bot will create a `#honeypot` channel on join, or you can set it up with `/honeypot`.
3. Configure the admin log channel and action (kick or ban) using the `/honeypot` command.
4. Ensure the bot’s highest role is above any self-assignable (color/ping) roles.
5. Any user posting in the honeypot channel will be banned or removed, and the action will be logged.
> [**ⓘ**](https://honeypot.riskymh.dev/docs/setup-guide) **Note:** Kick is default and is a softban (bans & unbans) so Discord deletes their immediate messages 

<details>
<summary><strong>Extra info</strong></summary>
  
### Why use a Honeypot Bot?

Spammers and compromised accounts often target all channels at once, especially from accounts already inside your server. This bot makes it easy to automatically spot and remove these accounts. When someone posts in the honeypot channel, the bot acts immediately - removing them and deleting their messages before they can spread spam further. This saves you and your moderators time, reduces spam exposure to your community, and keeps your server running smoothly.

> *"The bot that shouldn't need to exist"* - someone, probably

### Experiments

Options you can enable to avoid the bots better [**ⓘ**](https://honeypot.riskymh.dev/docs/configuration#experiments)

1. 💡 **Forward Message:** Send the incriminating message to the log channel.
2. **Reinvite:** In DM message include a link to be able to rejoin
4. **No Warning Msg:** Don’t include a warning message in the #honeypot channel
5. **No DM:** Don’t DM the user that they triggered the honeypot
6. **Channel Warmer:** Keep the honeypot channel active (every day)
7. **Random Channel Name:** Randomize the honeypot channel name (every day)
8. **Random Channel Name (chaos):** Randomize the honeypot channel name with random characters (every day)
9. ⚙️ **Recreate Channel:** Remake the honeypot channel (every day)
10. **Timeout First:** Before banning/kicking, timeout user for 1hr (will persist when they rejoin)
11. 💡 **Only More Recent Delete:** Instead of deleting last 1hr, only do 15min
12. 💡 **Many Honeypots:** Create multiple honeypot channels to increase chances of usage
13. ⚙️ **Ensure Message Deletion:** Search & delete leftover messages from moderated users 2 min after moderation

<sub>

**Legend:** 💡 recommended features · ⚙️ advanced, only use if you're seeing issues (may need 1+ bans to see)

</sub>

### Security Modules

Configure everything with `/security` - optional protections beyond the honeypot channel [**ⓘ**](https://honeypot.riskymh.dev/docs)

1. 🛡️ **Anti-Nuke & Restore:** The first deleted channel/role only asks the server/bot owner for approval (nothing is changed yet) - so a deliberate cleanup never triggers the response by itself. **Approve** strips the attacker and rebuilds everything from the latest automatic snapshot (taken at bot start, again right after enabling, and then every 10-60 minutes per server - only one rolling snapshot per server is kept, a new one replaces the old), including member roles, server name/icon and recent message history; **Dismiss** restores the structure too, but leaves the executor untouched. If structure keeps disappearing, it intervenes **immediately** without waiting. Mass channel creation (3+ in a minute) triggers an immediate snapshot + alert. Executors with a role listed in `ANTI_NUKE_TRUSTED_ROLES` (comma separated role ids) are ignored entirely.
2. 🔒 **Bot Quarantine:** Newly added bots join without permissions until an admin approves or kicks them (avoids raid bots getting a head start).
3. 🚫 **Anti-Spam:** Removes flood messages, mass mentions and coordinated raids in every channel.
4. 🔗 **Anti-Phishing:** Deletes fake nitro / token stealer links (needs the [Message Content Intent](https://discord.com/developers/docs/topics/gateway#message-content-intent) + `HAS_MESSAGE_INTENT=1`).
5. 📜 **Event Log:** Logs every change (channels, roles, bans, invites, ...) to a channel of your choice - powered by the audit log.

> The critical modules (Anti-Nuke, Quarantine, Anti-Spam) can only be turned off by the server owner or an administrator.

### Tips to Maximize Honeypot Bot’s Effectiveness

[**ⓘ**](https://honeypot.riskymh.dev/docs/tips) For best results, position your *#honeypot* channel near the top of your server list - recent spam bots often target the first few channels available. Consider renaming the *trap channel* to something less predictable, like *#pls-dont-chat-here*, to avoid automated bots that blacklist *"honeypot"* by name. Always ensure the bot’s role is ranked above standard member roles; this ensures it has the authority to remove problematic accounts. Explore the experimental features for additional defenses against evolving bot tactics, and enjoy a cleaner, safer community - so you can say goodbye to unwanted bots! 🎉

</details>

[Learn more...](https://honeypot.riskymh.dev/docs)

## Getting Started (dev)

- [Bun](https://bun.sh/) (v1.3+)
- Discord bot token (set as `DISCORD_TOKEN` environment variable)

```bash
$ bun install
$ bun start # or `bun dev`
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Default | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | *(required)* | Bot token |
| `DATABASE_URL` | *(required)* | SQL database (sqlite/postgres/mysql) |
| `REDIS_URL` | - | Enables caching, cross-replica locks & the sharded setup |
| `HAS_MESSAGE_INTENT` | `0` | `1` = enables the Message Content Intent (anti-phishing, Forward Message) - also activate it in the [Developer Portal](https://discord.com/developers/applications) |
| `SECURITY_BOT_MESSAGES` | `0` | `1` = also scan messages from other bots/webhooks (anti-phishing) in sharded mode |
| `SECURITY_POLLER` | on | `0` disables the audit-log poller (event log / quarantine) |
| `SECURITY_POLL_SEC` | `20` | Seconds between audit-log polls |
| `SECURITY_CYCLE_SEC` | `120` | Approx. seconds per server for a full audit-log cycle |
| `OWNER_IDS` | - | Bot owners (comma separated) - dashboard access **and** who may approve restores / anti-nuke responses |
| `ANTI_NUKE_TRUSTED_ROLES` | - | Role ids (comma separated) whose holders may delete structure without triggering Anti-Nuke |
| `BACKUP_MESSAGES` | `30` | Messages per text channel captured in snapshots and re-posted on restore (`0`-`50`, `0` disables). Plain text needs the [Message Content Intent](https://discord.com/developers/docs/topics/gateway#message-content-intent) + `HAS_MESSAGE_INTENT=1` - without it only embeds/attachments are captured. |

## Run the bot yourself

* [Railway Template](https://railway.com/deploy/honeypot?referralCode=risky&utm_medium=integration&utm_source=template&utm_campaign=generic)
* `bun run start`
* `docker compose up -d` (using `ghcr.io/riskymh/honeypot`)

Or you can just use my hosted version by inviting it to your server: [Invite Link](https://discord.com/oauth2/authorize?client_id=1450060292716494940)


<sub>

---
© [RiskyMH](https://riskymh.dev) 2026

</sub>