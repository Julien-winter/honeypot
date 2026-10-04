// Self-hosted legal pages (Terms of Service + Privacy Policy).
// Served by stats-server.ts at GET /terms and /privacy.
// Needed for Discord app verification (portal links must point here).

const layout = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honeypot &ndash; ${title}</title>
<link rel="icon" href="/honeypot.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(1200px 500px at 50% -10%, #16202e 0%, #0a0a0f 60%); color: #e8e8ef; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; padding: 0 16px 64px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  nav { display: flex; justify-content: space-between; align-items: center; padding: 18px 4px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.1rem; }
  .navlinks { display: flex; gap: 10px; align-items: center; }
  .navlinks a { color: #9a9ab0; text-decoration: none; font-size: .9rem; padding: 8px 12px; border-radius: 8px; }
  .navlinks a:hover { background: #1c1c26; color: #fff; }
  h1 { font-size: 2rem; margin: 22px 0 6px; }
  h2 { font-size: 1.2rem; margin: 24px 0 8px; color: #f5a623; }
  p, li { line-height: 1.65; color: #c9c9d6; }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  li { margin-bottom: 6px; }
  .card { background: rgba(20, 20, 28, .9); border: 1px solid #23232e; border-radius: 14px; padding: 20px 22px; margin-top: 16px; }
  code { background: #1c1c26; padding: 2px 7px; border-radius: 6px; font-size: .83rem; color: #fff; }
  .muted { color: #71718a; font-size: .85rem; }
  .foot { text-align: center; color: #71718a; font-size: .8rem; margin-top: 28px; }
  .foot a { color: #9a9ab0; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="/honeypot.svg" width="26" height="26" alt="Honeypot"> Honeypot</div>
    <div class="navlinks"><a href="/">Stats</a><a href="/docs">Docs</a><a href="/dashboard">Mod Dashboard</a></div>
  </nav>
  <div class="card">
  ${body}
  </div>
  <div class="foot"><a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/">Stats</a></div>
</div>
</body>
</html>`;

export const termsHtml = layout("Terms of Service", `
<h1>Terms of Service</h1>
<p class="muted">Effective: September 12, 2026</p>
<h2>1. What this bot does</h2>
<p>Honeypot monitors a dedicated honeypot channel per server. Anyone posting there is automatically softbanned (ban + instant unban, deleting recent messages) or banned, depending on each server's configuration.</p>
<h2>2. Server admin responsibility</h2>
<ul>
<li>You decide where the honeypot channel is, what action applies, and who can trigger it by granting channel access.</li>
<li>Keep the bot's role above member roles and test with an alt account. Owners and admins are never banned by design.</li>
<li>Do not use the bot to harass users. Misuse (e.g. trapping regular discussion channels) is your responsibility.</li>
</ul>
<h2>3. Availability</h2>
<p>This is a free, best-effort service run by a private operator. No uptime, support, or data-retention guarantees. The service may change or stop at any time.</p>
<h2>4. Data</h2>
<p>What is stored and why is described in the <a href="/privacy">Privacy Policy</a>. Removing the bot deletes its per-server configuration automatically.</p>
<h2>5. Contact</h2>
<p>Operator contact: our Discord server <a href="https://discord.gg/6QzDSBXQ6E">Honeypot Support</a></p>
`);

export const privacyHtml = layout("Privacy Policy", `
<h1>Privacy Policy</h1>
<p class="muted">Effective: September 12, 2026</p>
<h2>1. Data we store</h2>
<ul>
<li><b>Server configuration:</b> server/channel/user IDs, chosen action, log channel, enabled experiments, custom messages, reinvite codes.</li>
<li><b>Moderation events:</b> server, channel and user IDs plus timestamp, action (ban/softban) and trigger reason.</li>
<li><b>What we never store:</b> message content. The bot reacts to the fact that a message was sent, not to what it says.</li>
</ul>
<h2>2. Public statistics</h2>
<p>The public stats page shows aggregate numbers only (totals, daily counts). No user IDs, names, or per-user data are published.</p>
<h2>2b. Shared spammer network (opt-in per server)</h2>
<p>Servers that enable the shared-banlist experiment contribute one-way salted SHA-256 hashes of moderated user IDs (kept max 90 days). No raw IDs, names, or message content are shared. Participating servers check new members against these hashes and may temporarily timeout known spammers.</p>
<h2>2c. Public leaderboard (opt-in per server)</h2>
<p>Servers that enable the leaderboard experiment appear by name with their ban count on the public stats page.</p>
<h2>2d. Ban-evasion detection</h2>
<p>To recognize returning spammers, the bot stores usernames, display names and avatar IDs of moderated accounts (max 180 days). Matching happens on name plus avatar only — accounts without avatar are never matched. This data is never published.</p>
<h2>3. Mod dashboard login</h2>
<p>Optional Discord login (OAuth2, scopes <code>identify</code> + <code>guilds</code>) is used to show moderators their own servers' data. We keep a temporary in-memory session (24h) and store nothing else. Per-server details are only shown to users with ban permissions there.</p>
<h2>4. Storage &amp; deletion</h2>
<p>Data lives in a local database on the bot's server. If you kick the bot, your server's data is kept for 3 days (so re-adding restores everything) and then permanently deleted to save storage. For any other deletion request contact the operator.</p>
<h2>5. Contact</h2>
<p>Operator contact: our Discord server <a href="https://discord.gg/6QzDSBXQ6E">Honeypot Support</a></p>
`);
