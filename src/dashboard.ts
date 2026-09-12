import * as db from "./utils/db";

// Moderator dashboard behind Discord OAuth2 (identify + guilds).
// Public stats page stays anonymous; anything per-guild/per-user lives here
// and is only visible to users with Ban Members / Manage Guild in that guild.
//
// Required env:
//   DISCORD_CLIENT_SECRET - from Developer Portal > General Information
//   PUBLIC_URL            - public base URL, e.g. https://stats.example.com
//                         (must be https for Discord, except http://localhost)
//   The redirect URL PUBLIC_URL + "/api/auth/callback" must be registered in
//   the Developer Portal > OAuth2 > Redirects.

const BAN_MEMBERS = 4n;
const MANAGE_GUILD = 32n;

type SessionGuild = { id: string; name: string; icon: string | null; permissions: string };
type Session = {
    accessToken: string;
    user: { id: string; username: string; global_name: string | null; avatar: string | null };
    guilds: SessionGuild[];
    exp: number;
};

const sessions = new Map<string, Session>();
const pendingStates = new Map<string, number>();

function getAppId(): string {
    const token = process.env.DISCORD_TOKEN || "";
    try {
        const id = atob(token.split(".")[0]!);
        if (/^\d+$/.test(id)) return id;
    } catch { /* ignore */ }
    return "";
}

function dashboardConfigured(): boolean {
    const publicUrl = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    return !!process.env.DISCORD_CLIENT_SECRET && !!publicUrl && !!getAppId();
}

function parseCookies(req: Request): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.get("cookie") || "").split(";")) {
        const idx = part.indexOf("=");
        if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

function getSession(req: Request): (Session & { id: string }) | null {
    const id = parseCookies(req)["hp_sess"];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s || s.exp < Date.now()) {
        if (id) sessions.delete(id);
        return null;
    }
    if (sessions.size > 5000) for (const [k, v] of sessions) {
        if (v.exp < Date.now()) sessions.delete(k);
    }
    return { ...s, id };
}

function canManage(permissions: string | undefined): boolean {
    try {
        return ((BigInt(permissions ?? "0") & (BAN_MEMBERS | MANAGE_GUILD)) !== 0n);
    } catch {
        return false;
    }
}

async function discordApi(path: string, token: string, init?: RequestInit): Promise<any> {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
        signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Discord API ${res.status} on ${path}`);
    return res.json();
}

export async function handleDashboard(req: Request, url: URL): Promise<Response | null> {
    const publicUrl = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const clientId = getAppId();
    const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
        return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/api/auth/login") {
        if (!dashboardConfigured()) {
            return new Response("Dashboard not configured (DISCORD_CLIENT_SECRET / PUBLIC_URL missing).", { status: 503 });
        }
        const state = crypto.randomUUID().replace(/-/g, "");
        pendingStates.set(state, Date.now() + 5 * 60_000);
        const redirect = `${publicUrl}/api/auth/callback`;
        const authUrl = "https://discord.com/oauth2/authorize?client_id=" + clientId
            + "&redirect_uri=" + encodeURIComponent(redirect)
            + "&response_type=code&scope=" + encodeURIComponent("identify guilds")
            + "&state=" + state;
        return new Response(null, {
            status: 302,
            headers: {
                Location: authUrl,
                "Set-Cookie": `hp_state=${state}; Path=/; Max-Age=300; SameSite=Lax; HttpOnly`,
            },
        });
    }

    if (url.pathname === "/api/auth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const cookies = parseCookies(req);
        const stateExp = state ? pendingStates.get(state) : undefined;
        if (!code || !state || cookies["hp_state"] !== state || !stateExp || stateExp < Date.now()) {
            return new Response("Invalid login state, please try again.", { status: 400 });
        }
        pendingStates.delete(state);
        if (!dashboardConfigured()) return new Response("Dashboard not configured.", { status: 503 });
        try {
            const redirect = `${publicUrl}/api/auth/callback`;
            const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: redirect,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
            const tokenData = await tokenRes.json() as { access_token: string };
            const [user, guilds] = await Promise.all([
                discordApi("/users/@me", tokenData.access_token),
                discordApi("/users/@me/guilds", tokenData.access_token),
            ]);
            const id = crypto.randomUUID().replace(/-/g, "");
            sessions.set(id, {
                accessToken: tokenData.access_token,
                user: { id: user.id, username: user.username, global_name: user.global_name ?? null, avatar: user.avatar ?? null },
                guilds: (guilds as any[]).map((g) => ({ id: g.id, name: g.name, icon: g.icon ?? null, permissions: String(g.permissions ?? "0") })),
                exp: Date.now() + 24 * 60 * 60_000,
            });
            return new Response(null, {
                status: 302,
                headers: {
                    Location: "/dashboard",
                    "Set-Cookie": `hp_sess=${id}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly; ${publicUrl.startsWith("https") ? "Secure;" : ""}`,
                },
            });
        } catch (err) {
            console.error(`[dashboard] login failed: ${err}`);
            return new Response("Login failed, please try again.", { status: 500 });
        }
    }

    if (url.pathname === "/api/auth/logout") {
        const id = parseCookies(req)["hp_sess"];
        if (id) sessions.delete(id);
        return new Response(null, {
            status: 302,
            headers: { Location: "/dashboard", "Set-Cookie": "hp_sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" },
        });
    }

    if (url.pathname === "/api/me") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ user: s.user });
    }

    if (url.pathname === "/api/guilds") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        const candidates = s.guilds.filter((g) => canManage(g.permissions));
        const withBot = await Promise.all(candidates.map(async (g) => ((await db.getConfig(g.id)) ? g : null)));
        return Response.json({
            guilds: withBot.filter((g) => !!g).map((g) => ({ id: g!.id, name: g!.name, icon: g!.icon })),
        });
    }

    const guildMatch = url.pathname.match(/^\/api\/guilds\/(\d+)$/);
    if (guildMatch) {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        const guildId = guildMatch[1]!;
        const membership = s.guilds.find((g) => g.id === guildId);
        if (!membership || !canManage(membership.permissions)) {
            return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const config = await db.getConfig(guildId);
        if (!config) return Response.json({ error: "bot not configured here" }, { status: 404 });
        const [channels, total, last7d, byAction, recent] = await Promise.all([
            db.getChannels(guildId),
            db.getModeratedCount(guildId),
            db.getRecentGuildModerationCount(guildId, 7),
            db.getGuildActionCounts(guildId),
            db.getRecentEvents(guildId, 25),
        ]);
        return Response.json({
            guild: { id: guildId, name: membership.name, icon: membership.icon },
            config: { action: config.action, experiments: config.experiments, logChannelId: config.log_channel_id },
            channels: channels.map((c) => ({ channelId: c.channel_id, msgId: c.msg_id })),
            stats: { total, last7d, byAction },
            recent,
        });
    }

    return null;
}

const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honeypot &ndash; Mod Dashboard</title>
<link rel="icon" href="/honeypot.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #e8e8ef; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 32px 16px 64px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { text-align: center; font-size: 1.8rem; margin: 20px 0 6px; }
  .sub { text-align: center; color: #9a9ab0; font-size: .9rem; margin-bottom: 26px; }
  .card { background: #14141c; border: 1px solid #23232e; border-radius: 14px; padding: 20px 22px; margin-bottom: 16px; }
  .center { text-align: center; }
  .btn { display: inline-block; background: #5865F2; color: #fff; border: 0; border-radius: 10px; padding: 12px 26px; font-size: 1rem; cursor: pointer; text-decoration: none; }
  .btn.ghost { background: #23232e; }
  .guilds { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .guild { background: #14141c; border: 1px solid #23232e; border-radius: 12px; padding: 14px; cursor: pointer; display: flex; gap: 12px; align-items: center; }
  .guild:hover { border-color: #5865F2; }
  .avatar { width: 44px; height: 44px; border-radius: 50%; background: #5865F2; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.2rem; flex-shrink: 0; overflow: hidden; }
  .avatar img { width: 100%; height: 100%; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 14px 0; }
  .stat { background: #1c1c26; border-radius: 10px; padding: 12px; }
  .stat .l { font-size: .75rem; color: #9a9ab0; }
  .stat .v { font-size: 1.4rem; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th { text-align: left; color: #9a9ab0; font-weight: 600; padding: 8px; border-bottom: 1px solid #23232e; }
  td { padding: 8px; border-bottom: 1px solid #1c1c26; }
  code { background: #1c1c26; padding: 2px 6px; border-radius: 6px; font-size: .8rem; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: .75rem; font-weight: 700; }
  .badge.ban { background: #3a1620; color: #f87171; }
  .badge.softban { background: #3a2c10; color: #f5a623; }
  .topbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .topbar a { color: #9a9ab0; font-size: .85rem; text-decoration: none; }
  .muted { color: #71718a; font-size: .8rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1><img src="/honeypot.svg" width="32" height="32" alt="Honeypot" style="vertical-align:-6px"> Mod Dashboard</h1>
  <div class="sub">For mods only &ndash; shows just servers where you have ban permissions.</div>
  <div id="app"><div class="card center">Loading&hellip;</div></div>
</div>
<script>
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function fmtTime(ts) { return new Date(Number(ts) * 1000).toLocaleString('en-US'); }
function avatarUrl(u) {
  if (u && u.avatar) return 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=64';
  return null;
}
function iconUrl(g) {
  if (g && g.icon) return 'https://cdn.discordapp.com/icons/' + g.id + '/' + g.icon + '.png?size=64';
  return null;
}

async function api(path) {
  var r = await fetch(path, { cache: 'no-store' });
  if (r.status === 401) return { _unauth: true };
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

async function init() {
  var app = document.getElementById('app');
  var me;
  try { me = await api('/api/me'); } catch (e) { app.innerHTML = '<div class="card center">Failed to load.</div>'; return; }
  if (me._unauth || !me.user) {
    app.innerHTML = '<div class="card center"><p style="margin-bottom:16px">Sign in with Discord to see your servers.</p>'
      + '<a class="btn" href="/api/auth/login">Sign in with Discord</a></div>';
    return;
  }
  showGuilds(app, me.user);
}

async function showGuilds(app, user) {
  var av = avatarUrl(user);
  var head = '<div class="topbar"><div style="display:flex;gap:10px;align-items:center">'
    + (av ? '<div class="avatar"><img src="' + av + '" alt=""></div>' : '')
    + '<div><b>' + esc(user.global_name || user.username) + '</b><br><span class="muted">signed in</span></div></div>'
    + '<a href="/api/auth/logout">Logout</a></div>';
  var data;
  try { data = await api('/api/guilds'); } catch (e) { app.innerHTML = head + '<div class="card center">Failed to load servers.</div>'; return; }
  if (!data.guilds || !data.guilds.length) {
    app.innerHTML = head + '<div class="card center">No servers found where you moderate and the bot is set up.</div>';
    return;
  }
  var h = head + '<div class="guilds">';
  for (var i = 0; i < data.guilds.length; i++) {
    var g = data.guilds[i];
    var ic = iconUrl(g);
    h += '<div class="guild" data-id="' + esc(g.id) + '">'
      + (ic ? '<div class="avatar"><img src="' + ic + '" alt="" loading="lazy"></div>' : '<div class="avatar">' + esc((g.name || '?').slice(0, 1)) + '</div>')
      + '<div><b>' + esc(g.name) + '</b><br><span class="muted">' + esc(g.id) + '</span></div></div>';
  }
  app.innerHTML = h + '</div>';
  var els = app.querySelectorAll('.guild');
  for (var j = 0; j < els.length; j++) {
    (function (el) {
      el.addEventListener('click', function () { showDetail(app, user, el.getAttribute('data-id')); });
    })(els[j]);
  }
}

async function showDetail(app, user, guildId) {
  app.innerHTML = '<div class="card center">Loading&hellip;</div>';
  var d;
  try { d = await api('/api/guilds/' + encodeURIComponent(guildId)); } catch (e) { app.innerHTML = '<div class="card center">Failed to load.</div>'; return; }
  var h = '<div class="topbar"><a href="#" id="back">&larr; Back</a><a href="/api/auth/logout">Logout</a></div>';
  h += '<div class="card"><h2 style="font-size:1.2rem">' + esc(d.guild.name) + '</h2>'
    + '<div class="muted">Action: <b>' + esc(d.config.action) + '</b> &middot; Honeypot channels: ' + d.channels.length
    + (d.config.logChannelId ? ' &middot; Log channel set' : ' &middot; no log channel') + '</div>'
    + '<div class="stats">'
    + '<div class="stat"><div class="l">Total</div><div class="v">' + fmt(d.stats.total) + '</div></div>'
    + '<div class="stat"><div class="l">Last 7 days</div><div class="v">' + fmt(d.stats.last7d) + '</div></div>'
    + '<div class="stat"><div class="l">Bans</div><div class="v" style="color:#f87171">' + fmt(d.stats.byAction.ban) + '</div></div>'
    + '<div class="stat"><div class="l">Softbans</div><div class="v" style="color:#f5a623">' + fmt(d.stats.byAction.softban) + '</div></div>'
    + '</div></div>';
  h += '<div class="card"><h2 style="font-size:1.1rem;margin-bottom:10px">Recent events</h2>';
  if (!d.recent || !d.recent.length) {
    h += '<div class="muted">No events yet.</div>';
  } else {
    h += '<div style="overflow-x:auto"><table><tr><th>Time</th><th>User ID</th><th>Action</th><th>Channel ID</th><th>Reason</th></tr>';
    for (var i = 0; i < d.recent.length; i++) {
      var e = d.recent[i];
      var badge = e.action === 'ban' ? '<span class="badge ban">ban</span>' : '<span class="badge softban">softban</span>';
      h += '<tr><td>' + esc(fmtTime(e.timestamp)) + '</td><td><code>' + esc(e.user_id) + '</code></td><td>' + badge + '</td>'
        + '<td><code>' + esc(e.channel_id || '-') + '</code></td><td>' + esc(e.reason || '-') + '</td></tr>';
    }
    h += '</table></div>';
  }
  h += '</div>';
  app.innerHTML = h;
  document.getElementById('back').addEventListener('click', function (ev) { ev.preventDefault(); showGuilds(app, user); });
}

init();
</script>
</body>
</html>`;
