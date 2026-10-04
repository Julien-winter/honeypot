// Self-hosted documentation page. Served by stats-server.ts at GET /docs.
// {{INVITE_URL}} is replaced server-side with this instance's invite link.

export const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honeypot &ndash; Documentation</title>
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
  .btn { display: inline-block; background: linear-gradient(135deg, #f5a623, #f97316); color: #111 !important; font-weight: 700; border-radius: 10px; padding: 9px 18px !important; text-decoration: none; }
  h1 { font-size: 2rem; margin: 22px 0 6px; }
  h2 { font-size: 1.3rem; margin: 30px 0 10px; color: #f5a623; }
  h3 { font-size: 1.05rem; margin: 18px 0 8px; }
  p, li { line-height: 1.65; color: #c9c9d6; }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  li { margin-bottom: 6px; }
  .card { background: rgba(20, 20, 28, .9); border: 1px solid #23232e; border-radius: 14px; padding: 20px 22px; margin-top: 16px; }
  code { background: #1c1c26; padding: 2px 7px; border-radius: 6px; font-size: .83rem; color: #fff; }
  table { width: 100%; border-collapse: collapse; font-size: .88rem; margin-top: 8px; }
  th { text-align: left; color: #9a9ab0; padding: 8px; border-bottom: 1px solid #23232e; }
  td { padding: 8px; border-bottom: 1px solid #1c1c26; color: #c9c9d6; vertical-align: top; }
  .foot { text-align: center; color: #71718a; font-size: .8rem; margin-top: 28px; }
  .foot a { color: #9a9ab0; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <div class="brand"><img src="/honeypot.svg" width="26" height="26" alt="Honeypot"> Honeypot</div>
    <div class="navlinks"><a href="/">Stats</a><a href="/dashboard">Mod Dashboard</a><a class="btn" href="{{INVITE_URL}}">Invite Bot</a></div>
  </nav>

  <h1>Documentation</h1>
  <p>A Discord bot that automatically catches and removes spam bots via a dedicated honeypot channel. Anyone posting there gets softbanned (ban + instant unban, deletes recent messages) or banned.</p>

  <div class="card">
  <h2>Quick Setup</h2>
  <ol>
    <li><a class="btn" href="{{INVITE_URL}}">Invite the bot</a> and pick your server.</li>
    <li>Move the bot's role <b>above</b> member roles and make sure it has <code>Ban Members</code> + <code>Manage Channels</code>.</li>
    <li>The bot creates a <code>#honeypot</code> channel on join. Keep it near the <b>top</b> of your channel list and consider renaming it to something less obvious.</li>
    <li>Run <code>/honeypot</code> to pick the channel, a log channel and the action (softban / ban / disabled).</li>
    <li>Test with an <b>alt account</b> &mdash; owners and admins are never banned, only warned.</li>
  </ol>
  </div>

  <div class="card">
  <h2>Permissions the bot needs</h2>
  <ul>
    <li><code>Ban Members</code> &ndash; to softban/ban spammers</li>
    <li><code>Manage Channels</code> &ndash; to create the honeypot channel</li>
    <li><code>View / Send Messages, Manage Messages, Read History</code> in honeypot + log channels</li>
    <li><code>Create Invite</code> &ndash; only for the reinvite experiment</li>
    <li><code>Timeout Members</code> &ndash; only for the timeout-first experiment</li>
  </ul>
  </div>

  <div class="card">
  <h2>Experiments (<code>/honeypot</code>)</h2>
  <table>
    <tr><th>Experiment</th><th>What it does</th></tr>
    <tr><td>Forward Message</td><td>Forwards the triggering message to the log channel (needs message intent)</td></tr>
    <tr><td>Reinvite</td><td>DM includes an invite so legit users can rejoin (recommended)</td></tr>
    <tr><td>Timeout First</td><td>Timeouts the user for 1h before banning</td></tr>
    <tr><td>Only More Recent Delete</td><td>Deletes 15 min of messages instead of 1h</td></tr>
    <tr><td>Many Honeypots</td><td>Use up to 10 honeypot channels</td></tr>
    <tr><td>Channel Warmer</td><td>Keeps the honeypot channel active daily</td></tr>
    <tr><td>Random Channel Name</td><td>Renames the channel daily (+ chaos variant: random gibberish, fancy fonts or lookalikes)</td></tr>
    <tr><td>Recreate Channel</td><td>Remakes the channel daily (advanced)</td></tr>
    <tr><td>Ensure Message Deletion</td><td>Cleans leftover messages 2 min after moderation (needs message intent)</td></tr>
    <tr><td>No Link Filter</td><td>Disables the automatic scam-link deletion (filter is on by default when the message intent is enabled)</td></tr>
    <tr><td>Alt Detection</td><td>Kicks suspicious joins (ban evaders recognized by name+avatar, accounts younger than 7 days or without avatar) + sends them a DM (opt-in, needs Server Members intent)</td></tr>
    <tr><td>Shared Banlist</td><td>Kicks known spammers on join + sends them a DM, shares hashed spammer IDs across servers (opt-in, off by default, needs Server Members intent)</td></tr>
    <tr><td>Leaderboard</td><td>Shows this server by name in the public top-protected ranking (opt-in)</td></tr>
  </table>
  <p style="margin-top:8px">The scam link filter runs by default (no setup needed) and removes known phishing/IP-logger links plus Discord impersonation domains &mdash; staff messages are never touched.</p>
  </div>

  <div class="card">
  <h2>Commands</h2>
  <ul>
    <li><code>/honeypot</code> &ndash; channel, log channel, action, experiments</li>
    <li><code>/honeypot-messages</code> &ndash; custom warning, DM and log texts (supports variables below)</li>
    <li><code>/stats</code> &ndash; this server's stats (also works in DMs for global stats)</li>
  </ul>
  <h3>Message variables</h3>
  <p><code>{{user:mention}}</code> <code>{{user:id}}</code> <code>{{user:name}}</code> <code>{{action:text}}</code> <code>{{server:name}}</code> <code>{{honeypot:channel:mention}}</code> <code>{{honeypot:moderation-count}}</code> <code>{{reinvite:link}}</code> <code>{{honeypot:channel:link}}</code> and more. The log message must contain <code>{{user:mention}}</code>.</p>
  </div>

  <div class="card">
  <h2 id="hacked-account">Hacked account?</h2>
  <p>If you were removed by the honeypot but didn't post anything yourself, someone may control your account (malware, stolen session, leaked password):</p>
  <ol>
    <li>Change your Discord password and sign out all sessions (User Settings &gt; Devices).</li>
    <li>Enable two-factor authentication (2FA).</li>
    <li>Scan your device for malware and remove unknown browser extensions/apps (User Settings &gt; Authorized Apps).</li>
    <li>Still locked out? Contact Discord support: <a href="https://support.discord.com">support.discord.com</a> and ask in our support server for a re-invite.</li>
  </ol>
  </div>

  <div class="card">
  <h2>FAQ</h2>
  <h3>Why wasn't an admin banned?</h3>
  <p>By design: owners and admins only trigger a warning so nobody can weaponize the bot against server staff. Test with an alt account.</p>
  <h3>Which data is stored?</h3>
  <p>Only IDs and timestamps (server, channel, user, action, time) in a local database. No message content. Details stay with server mods; the public stats page shows aggregates only.</p>
  <h3>How many servers can one bot handle?</h3>
  <p>One instance serves unlimited servers. Sharding is only needed beyond ~2500 servers.</p>
  <h3>What happens when I kick the bot?</h3>
  <p>Your settings are kept for 3 days (re-adding restores everything), then permanently deleted.</p>
  <h3>What happens during a spam raid?</h3>
  <p>Triggers are deduplicated per user and bans are smoothed to about one per second (burst of 5). From 3 simultaneous cases the log channel shows a live progress message with a final summary.</p>
  </div>

  <div class="foot"><a href="/">Stats</a> &middot; <a href="/dashboard">Mod Dashboard</a> &middot; <a href="/health">Health</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a></div>
</div>
</body>
</html>`;
