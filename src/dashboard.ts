import * as db from "./utils/db";
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";

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
const OWNER_IDS = new Set(
    (process.env.OWNER_IDS || "1062884939093246045").split(",").map((s) => s.trim()).filter(Boolean),
);

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

function requireOwner(req: Request): (Session & { id: string }) | null {
    const s = getSession(req);
    if (!s || !OWNER_IDS.has(s.user.id)) return null;
    return s;
}

/** Mod rights for one guild: session + (owner bypass or guild permission bit). */
function requireMod(req: Request, guildId: string, perm: bigint): (Session & { id: string }) | null {    const s = getSession(req);
    if (!s) return null;
    if (OWNER_IDS.has(s.user.id)) return s;
    const m = s.guilds.find((g) => g.id === guildId);
    if (!m) return null;
    try {
        if ((BigInt(m.permissions ?? "0") & perm) !== 0n) return s;
    } catch { /* deny */ }
    return null;
}

const MODERATE_MEMBERS = 1099511627776n;

/** Real container memory (cgroup, like the panel shows), fallback to process RSS. */
async function getMemoryMiB(): Promise<number | null> {
    for (const p of ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]) {
        try {
            const raw = (await Bun.file(p).text()).trim();
            if (/^\d+$/.test(raw)) return Number(raw) / 1024 / 1024;
        } catch { /* not in a container / unreadable */ }
    }
    try {
        return process.memoryUsage().rss / 1024 / 1024;
    } catch {
        return null;
    }
}

function getSqlitePath(): string | null {
    const raw = process.env.DATABASE_URL || "sqlite://honeypot.sqlite";
    if (!raw.startsWith("sqlite://")) return null;
    const p = raw.slice("sqlite://".length);
    if (!p) return null;
    if (/^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\\\")) return p;
    return `${process.cwd()}/${p}`;
}

const KNOWN_EXPERIMENTS = [
    "no-warning-msg", "no-dm", "random-channel-name", "random-channel-name-chaos",
    "channel-warmer", "recreate-channel", "forward-message", "reinvite",
    "timeout-first", "only-recent-delete", "many-honeypots", "ensure-msg-delete",
    "alt-detection", "shared-banlist", "no-link-filter", "leaderboard",
];

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

export async function handleDashboard(req: Request, url: URL, api?: API | API2 | null): Promise<Response | null> {
    const publicUrl = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const clientId = getAppId();
    const clientSecret = process.env.DISCORD_CLIENT_SECRET || "";

    if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
        return new Response(dashboardHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // premium self-service (any logged-in user)
    if (url.pathname === "/api/premium/me") {        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        const row = await db.getPremiumUser(s.user.id).catch(() => null);
        if (!row) {
            return Response.json({
                userId: s.user.id,
                status: "none",
                expiresAt: 0,
                running: false,
                uptimeSec: null,
                premium: false,
                donateLtc: process.env.DONATE_LTC || "ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6",
                price: "2€ / month",
            });
        }
        const active = await db.isPremiumActive(s.user.id).catch(() => false);
        let running = false;
        let uptimeSec: number | null = null;
        try {
            const pm = await import("./utils/premium-manager");
            running = pm.isPremiumRunning(s.user.id);
            uptimeSec = pm.premiumUptimeSec(s.user.id);
        } catch { /* ignore */ }
        return Response.json({
            userId: row.user_id,
            username: row.username,
            status: row.status,
            expiresAt: row.expires_at,
            running,
            uptimeSec,
            premium: active,
            publicUrl: row.public_url,
            donateLtc: row.donate_ltc || process.env.DONATE_LTC || null,
            hasToken: !!row.discord_token,
            hasSecret: !!row.client_secret,
            price: "2€ / month",
        });
    }

    if (url.pathname === "/api/premium/setup" && req.method === "POST") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        const active = await db.isPremiumActive(s.user.id).catch(() => false);
        if (!active && !OWNER_IDS.has(s.user.id)) {
            return Response.json({ error: "premium required (2€/month)" }, { status: 403 });
        }
        let body: any = {};
        try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
        const token = typeof body.token === "string" ? body.token.trim() : "";
        const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
        const publicUrlIn = typeof body.publicUrl === "string" ? body.publicUrl.trim().replace(/\/$/, "") : "";
        const donateLtc = typeof body.donateLtc === "string" ? body.donateLtc.trim() : "";
        if (token && !/^[A-Za-z0-9._-]{50,}$/.test(token)) {
            return Response.json({ error: "invalid token format" }, { status: 400 });
        }
        // basic token shape: three base64 parts
        if (token && token.split(".").length !== 3) {
            return Response.json({ error: "token must have three parts" }, { status: 400 });
        }
        const patch: any = {};
        if (token) patch.discord_token = token;
        if (secret || body.clientSecret === "") patch.client_secret = secret || null;
        if (publicUrlIn || body.publicUrl === "") patch.public_url = publicUrlIn || null;
        if (donateLtc || body.donateLtc === "") patch.donate_ltc = donateLtc || null;
        patch.username = s.user.username;
        await db.upsertPremiumUser(s.user.id, patch);
        return Response.json({ ok: true });
    }

    if (url.pathname === "/api/premium/start" && req.method === "POST") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!(await db.isPremiumActive(s.user.id).catch(() => false)) && !OWNER_IDS.has(s.user.id)) {
            return Response.json({ error: "premium required" }, { status: 403 });
        }
        const pm = await import("./utils/premium-manager");
        const res = await pm.startPremiumBot(s.user.id);
        if (!res.ok) return Response.json({ error: res.error || "start failed" }, { status: 400 });
        return Response.json({ ok: true, pid: res.pid });
    }

    if (url.pathname === "/api/premium/stop" && req.method === "POST") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!(await db.isPremiumActive(s.user.id).catch(() => false)) && !OWNER_IDS.has(s.user.id)) {
            return Response.json({ error: "premium required" }, { status: 403 });
        }
        const pm = await import("./utils/premium-manager");
        const res = pm.stopPremiumBot(s.user.id);
        return Response.json(res);
    }

    if (url.pathname === "/api/premium/restart" && req.method === "POST") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!(await db.isPremiumActive(s.user.id).catch(() => false)) && !OWNER_IDS.has(s.user.id)) {
            return Response.json({ error: "premium required" }, { status: 403 });
        }
        const pm = await import("./utils/premium-manager");
        pm.stopPremiumBot(s.user.id);
        await Bun.sleep(500);
        const res = await pm.startPremiumBot(s.user.id);
        if (!res.ok) return Response.json({ error: res.error || "restart failed" }, { status: 400 });
        return Response.json({ ok: true, pid: res.pid });
    }

    if (url.pathname === "/api/premium/stats" && req.method === "GET") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (!(await db.isPremiumActive(s.user.id).catch(() => false)) && !OWNER_IDS.has(s.user.id)) {
            return Response.json({ error: "premium required" }, { status: 403 });
        }
        const pm = await import("./utils/premium-manager");
        const stats = await pm.getPremiumBotStats(s.user.id);
        return Response.json(stats);
    }

    if (url.pathname === "/api/premium/price" && req.method === "GET") {
        try {
            const mod = await import("./utils/premium-payments");
            const info = mod.ltcPriceInfo();
            if (!info) {
                // trigger fetch
                await mod.verifyLtcTxid("0".repeat(64), "price-check", "127.0.0.1").catch(() => null);
            }
            const info2 = (await import("./utils/premium-payments")).ltcPriceInfo();
            return Response.json(info2 || { address: process.env.DONATE_LTC || "ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6", priceEur: "?", requiredLtc: "?" });
        } catch {
            return Response.json({ address: process.env.DONATE_LTC || "ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6", priceEur: "?", requiredLtc: "?" });
        }
    }

    if (url.pathname === "/api/premium/verify" && req.method === "POST") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        let txid = "";
        try { txid = String((await req.json() as { txid?: string }).txid ?? "").trim(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
        try {
            const mod = await import("./utils/premium-payments");
            const res = await mod.verifyLtcTxid(txid, s.user.id, ip);
            if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
            // activate 30 days from now (or extend if already active)
            const existing = await db.getPremiumUser(s.user.id);
            const now = Math.floor(Date.now() / 1000);
            const base = existing?.expires_at && existing.expires_at > now ? existing.expires_at : now;
            const expiresAt = base + 30 * 86400;
            await db.upsertPremiumUser(s.user.id, { status: "active", expires_at: expiresAt, username: s.user.username });
            return Response.json({ ...res, ok: true, expiresAt });
        } catch (err: any) {
            return Response.json({ error: err?.message || "verify failed" }, { status: 500 });
        }
    }

    if (url.pathname === "/api/premium/test-activate" && req.method === "POST") {
        const s = getSession(req);
        if (!s || !OWNER_IDS.has(s.user.id)) return Response.json({ error: "forbidden" }, { status: 403 });
        const now = Math.floor(Date.now() / 1000);
        const existing = await db.getPremiumUser(s.user.id);
        const base = existing?.expires_at && existing.expires_at > now ? existing.expires_at : now;
        const expiresAt = base + 7 * 86400;
        await db.upsertPremiumUser(s.user.id, { status: "active", expires_at: expiresAt, username: s.user.username });
        return Response.json({ ok: true, expiresAt, note: "Test premium 7 days (owner only, no payment)" });
    }

    // owner premium admin
    if (url.pathname === "/api/owner/premium" && req.method === "GET") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        const rows = await db.listPremiumUsers().catch(() => []);
        const pm = await import("./utils/premium-manager");
        const safe = await Promise.all(rows.map(async (r) => {
            let stats=null;
            try{ stats=await pm.getPremiumBotStats(r.user_id); }catch{}
            return {
                userId: r.user_id,
                username: r.username,
                status: r.status,
                expiresAt: r.expires_at,
                createdAt: r.created_at,
                hasToken: !!r.discord_token,
                hasSecret: !!r.client_secret,
                running: stats?.running ?? false,
                uptimeSec: stats?.uptimeSec ?? null,
                guilds: stats?.guilds ?? 0,
                bans: stats?.bans ?? 0,
                dbKB: stats?.dbKB ?? null,
            };
        }));
        return Response.json({ users: safe });
    }

    if (url.pathname === "/api/owner/premium/activate" && req.method === "POST") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        let userId = "", days = 30;
        try {
            const b = await req.json() as { userId?: string; days?: number };
            userId = String(b.userId ?? "");
            if (Number.isFinite(Number(b.days))) days = Math.min(Math.max(Math.floor(Number(b.days)), 1), 365);
        } catch { /* ignore */ }
        if (!/^\d+$/.test(userId)) return Response.json({ error: "bad userId" }, { status: 400 });
        const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
        await db.upsertPremiumUser(userId, { status: "active", expires_at: expiresAt });
        return Response.json({ ok: true, expiresAt });
    }

    if (url.pathname === "/api/owner/premium/revoke" && req.method === "POST") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        let userId = "";
        try { userId = String((await req.json() as { userId?: string }).userId ?? ""); } catch { /* ignore */ }
        if (!/^\d+$/.test(userId)) return Response.json({ error: "bad userId" }, { status: 400 });
        try {
            const pm = await import("./utils/premium-manager");
            pm.stopPremiumBot(userId);
        } catch { /* ignore */ }
        await db.upsertPremiumUser(userId, { status: "expired", expires_at: Math.floor(Date.now() / 1000) });
        return Response.json({ ok: true });
    }

    if (url.pathname === "/api/owner/premium/control" && req.method === "POST") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        let userId = "", action = "";
        try {
            const b = await req.json() as { userId?: string; action?: string };
            userId = String(b.userId ?? "");
            action = String(b.action ?? "");
        } catch { /* ignore */ }
        if (!/^\d+$/.test(userId) || !["start", "stop", "restart"].includes(action)) return Response.json({ error: "bad request" }, { status: 400 });
        const pm = await import("./utils/premium-manager");
        if (action === "stop") {
            const res = pm.stopPremiumBot(userId);
            return Response.json(res);
        }
        if (action === "start") {
            const res = await pm.startPremiumBot(userId);
            if (!res.ok) return Response.json({ error: res.error || "start failed" }, { status: 400 });
            return Response.json(res);
        }
        // restart
        pm.stopPremiumBot(userId);
        await Bun.sleep(500);
        const res = await pm.startPremiumBot(userId);
        if (!res.ok) return Response.json({ error: res.error || "restart failed" }, { status: 400 });
        return Response.json(res);
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
        return Response.json({ user: s.user, isOwner: OWNER_IDS.has(s.user.id) });
    }

    if (url.pathname === "/api/guilds") {
        const s = getSession(req);
        if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
        if (OWNER_IDS.has(s.user.id)) {
            const all = await db.getAllGuildConfigs().catch(() => []);
            return Response.json({
                guilds: all.map((g) => ({ id: g.guild_id, name: g.name || "Unknown server", icon: g.icon })),
                ownerView: true,
            });
        }
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
        const isOwner = OWNER_IDS.has(s.user.id);
        const membership = s.guilds.find((g) => g.id === guildId);
        if (!isOwner && (!membership || !canManage(membership.permissions))) {
            return Response.json({ error: "forbidden" }, { status: 403 });
        }
        const config = await db.getConfig(guildId);
        if (!config) return Response.json({ error: "bot not configured here" }, { status: 404 });
        const displayName = membership?.name ?? config.name ?? guildId;
        // raw icon hash in both paths; the frontend builds the CDN URL
        const displayIcon = membership?.icon ?? config.icon ?? null;
        const [channels, total, last7d, byAction, recent, channelStats] = await Promise.all([
            db.getChannels(guildId),
            db.getModeratedCount(guildId),
            db.getRecentGuildModerationCount(guildId, 7),
            db.getGuildActionCounts(guildId),
            db.getRecentEvents(guildId, 25),
            db.getGuildStats(guildId).catch(() => []),
        ]);
        const statByChannel = new Map((channelStats as { channel_id: string | null; moderatedCount: number }[]).map((s) => [s.channel_id, s.moderatedCount]));
        const channelsWithNames = await Promise.all(channels.map(async (c) => {
            let name: string | null = null;
            try {
                const ch = await api?.channels.get(c.channel_id) as { name?: string } | null;
                name = ch?.name ?? null;
            } catch { /* deleted channel */ }
            return { channelId: c.channel_id, name, msgId: c.msg_id, moderated: statByChannel.get(c.channel_id) ?? 0 };
        }));
        let logChannel: { id: string; name: string | null } | null = null;
        if (config.log_channel_id) {
            let logName: string | null = null;
            try {
                const lc = await api?.channels.get(config.log_channel_id) as { name?: string } | null;
                logName = lc?.name ?? null;
            } catch { /* deleted channel */ }
            logChannel = { id: config.log_channel_id, name: logName };
        }
        return Response.json({
            guild: { id: guildId, name: displayName, icon: displayIcon },
            config: { action: config.action, experiments: config.experiments, logChannel },
            channels: channelsWithNames,
            stats: { total, last7d, byAction },
            recent,
        });
    }

    // ---- owner console (bot owner only) ----
    if (url.pathname === "/api/owner/overview") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        const [stats, feed, usage, migration, expStates, counts] = await Promise.all([
            db.getStats().catch(() => ({ totalGuilds: 0, totalModerated: 0 })),
            db.getGlobalRecentEvents(25).catch(() => []),
            db.getExperimentUsage().catch(() => ({} as Record<string, number>)),
            db.getMigrationVersion().catch(() => 0),
            db.getExperimentStates().catch(() => ({} as Record<string, string[]>)),
            db.getGlobalOverviewStats().catch(() => ({ today: 0, last7d: 0, last30d: 0, shared: 0, prints: 0 })),
        ]);
        let dbKB: number | null = null;
        try {
            const p = getSqlitePath();
            if (p) dbKB = Math.round((await Bun.file(p).arrayBuffer()).byteLength / 1024);
        } catch { /* ignore */ }
        const mem = Math.round(((await getMemoryMiB().catch(() => null)) ?? 0) * 100) / 100;
        return Response.json({
            system: {
                uptimeSec: Math.floor(process.uptime()),
                memoryMB: mem > 0 ? mem : null,
                dbKB,
                guilds: stats.totalGuilds,
                moderations: stats.totalModerated,
                migration,
                bun: Bun.version,
                time: new Date().toISOString(),
            },
            feed,
            usage,
            expStates,
            counts,
        });
    }

    if (url.pathname === "/api/owner/broadcast" && req.method === "POST") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!api) return Response.json({ error: "bot api unavailable" }, { status: 503 });
        let message = "";
        try {
            message = String((await req.json() as { message?: string }).message ?? "").slice(0, 2000);
        } catch { /* ignore */ }
        if (!message.trim()) return Response.json({ error: "empty message" }, { status: 400 });
        const targets = await db.getLogChannels().catch(() => []);
        let sent = 0, failed = 0;
        for (const t of targets) {
            try {
                await api.channels.createMessage(t.log_channel_id, { content: message, allowed_mentions: {} });
                sent++;
            } catch {
                failed++;
            }
            await Bun.sleep(350);
        }
        return Response.json({ sent, failed, total: targets.length });
    }

    if (url.pathname === "/api/owner/experiment" && req.method === "POST") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        let experiment = "", enable = false, guildIds: string[] = [];
        try {
            const body = await req.json() as { experiment?: string; enable?: boolean; guildIds?: string[] };
            experiment = String(body.experiment ?? "");
            enable = body.enable === true;
            if (Array.isArray(body.guildIds)) guildIds = body.guildIds.filter((id) => typeof id === "string" && /^\d+$/.test(id)).slice(0, 200);
        } catch { /* ignore */ }
        if (!KNOWN_EXPERIMENTS.includes(experiment)) {
            return Response.json({ error: "unknown experiment" }, { status: 400 });
        }
        const res = guildIds.length > 0
            ? await db.setExperimentForGuilds(experiment, enable, guildIds)
            : await db.setExperimentForAll(experiment, enable);
        return Response.json(res);
    }

    // ---- moderation actions for mods (scoped to guilds they moderate) ----
    if (url.pathname === "/api/mod/action" && req.method === "POST") {
        let guildId = "", action = "";
        try {
            const body = await req.json() as { guildId?: string; action?: string };
            guildId = String(body.guildId ?? "");
            action = String(body.action ?? "");
        } catch { /* ignore */ }
        if (!/^\d+$/.test(guildId)) return Response.json({ error: "bad guild" }, { status: 400 });
        if (!["softban", "ban", "disabled"].includes(action)) return Response.json({ error: "bad action" }, { status: 400 });
        if (!requireMod(req, guildId, BAN_MEMBERS)) return Response.json({ error: "forbidden" }, { status: 403 });
        const config = await db.getConfig(guildId);
        if (!config) return Response.json({ error: "bot not configured here" }, { status: 404 });
        await db.setConfig({ ...config, action: action as "softban" | "ban" | "disabled" });
        return Response.json({ ok: true, action });
    }

    if (url.pathname === "/api/mod/unban" && req.method === "POST") {
        let guildId = "", userId = "";
        try {
            const body = await req.json() as { guildId?: string; userId?: string };
            guildId = String(body.guildId ?? "");
            userId = String(body.userId ?? "");
        } catch { /* ignore */ }
        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(userId)) return Response.json({ error: "bad id" }, { status: 400 });
        if (!requireMod(req, guildId, BAN_MEMBERS)) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!api) return Response.json({ error: "bot api unavailable" }, { status: 503 });
        try {
            await api.guilds.unbanUser(guildId, userId, { reason: "Unbanned via mod dashboard" });
            return Response.json({ ok: true });
        } catch (err: any) {
            const code = err?.code ?? err?.status;
            if (code === 10026) return Response.json({ error: "user is not banned" }, { status: 400 });
            return Response.json({ error: "unban failed" }, { status: 502 });
        }
    }

    if (url.pathname === "/api/mod/timeout" && req.method === "POST") {
        let guildId = "", userId = "", minutes = 60;
        try {
            const body = await req.json() as { guildId?: string; userId?: string; minutes?: number };
            guildId = String(body.guildId ?? "");
            userId = String(body.userId ?? "");
            if (Number.isFinite(Number(body.minutes))) minutes = Math.min(Math.max(Math.floor(Number(body.minutes)), 1), 40320);
        } catch { /* ignore */ }
        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(userId)) return Response.json({ error: "bad id" }, { status: 400 });
        if (!requireMod(req, guildId, MODERATE_MEMBERS)) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!api) return Response.json({ error: "bot api unavailable" }, { status: 503 });
        try {
            await api.guilds.editMember(
                guildId,
                userId,
                { communication_disabled_until: new Date(Date.now() + minutes * 60_000).toISOString() },
                { reason: `Timed out via mod dashboard (${minutes}m)` },
            );
            return Response.json({ ok: true, minutes });
        } catch {
            return Response.json({ error: "timeout failed (missing permissions?)" }, { status: 502 });
        }
    }

    if (url.pathname === "/api/mod/run" && req.method === "POST") {
        let guildId = "", channelId = "", task = "";
        try {
            const body = await req.json() as { guildId?: string; channelId?: string; task?: string };
            guildId = String(body.guildId ?? "");
            channelId = String(body.channelId ?? "");
            task = String(body.task ?? "");
        } catch { /* ignore */ }
        if (!/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) return Response.json({ error: "bad id" }, { status: 400 });
        if (!["warmer", "rename"].includes(task)) return Response.json({ error: "bad task" }, { status: 400 });
        if (!requireMod(req, guildId, BAN_MEMBERS)) return Response.json({ error: "forbidden" }, { status: 403 });
        if (!api) return Response.json({ error: "bot api unavailable" }, { status: 503 });
        const config = await db.getConfig(guildId);
        if (!config) return Response.json({ error: "bot not configured here" }, { status: 404 });
        const channels = await db.getChannels(guildId);
        if (!channels.some((c) => c.channel_id === channelId)) {
            return Response.json({ error: "not a honeypot channel" }, { status: 400 });
        }
        try {
            if (task === "warmer") {
                const { channelWarmerExperiment } = await import("./cron/experiments");
                await channelWarmerExperiment(api, guildId, channelId);
            } else {
                const { randomChannelNameExperiment } = await import("./cron/experiments");
                const chaos = config.experiments.includes("random-channel-name-chaos");
                await randomChannelNameExperiment(api, guildId, channelId, chaos);
            }
            return Response.json({ ok: true, task });
        } catch {
            return Response.json({ error: "task failed (missing permissions?)" }, { status: 502 });
        }
    }

    if (url.pathname === "/api/owner/backup") {
        if (!requireOwner(req)) return Response.json({ error: "forbidden" }, { status: 403 });
        const p = getSqlitePath();
        if (!p) return Response.json({ error: "not a sqlite database" }, { status: 400 });
        const file = Bun.file(p);
        if (!(await file.exists())) return Response.json({ error: "database file missing" }, { status: 404 });
        const day = new Date().toISOString().split("T")[0];
        return new Response(file, {
            headers: {
                "Content-Type": "application/x-sqlite3",
                "Content-Disposition": `attachment; filename="honeypot-backup-${day}.sqlite"`,
            },
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
  .otab { background: #1c1c26; color: #9a9ab0; border: 1px solid #34343f; border-radius: 8px; padding: 7px 16px; font-size: .85rem; cursor: pointer; }
  .otab.active { background: #5865F2; color: #fff; border-color: #5865F2; }
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
function fmtTime(ts) { return new Date(Number(ts) * 1000).toLocaleString('de-DE'); }
function copyText(t, btn) {
  function done(ok) {
    var old = btn.textContent;
    btn.textContent = ok ? 'copied!' : 'failed';
    setTimeout(function () { btn.textContent = old; }, 1500);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(function () { done(true); }, function () { done(false); });
  } else {
    var ta = document.createElement('textarea');
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { done(document.execCommand('copy')); } catch (e) { done(false); }
    document.body.removeChild(ta);
  }
}
var EXPERIMENT_LABELS = {
  'forward-message': 'Forward Message', 'reinvite': 'Reinvite', 'timeout-first': 'Timeout First',
  'channel-warmer': 'Channel Warmer', 'random-channel-name': 'Random Name', 'random-channel-name-chaos': 'Chaos Name',
  'only-recent-delete': 'Recent Delete', 'no-warning-msg': 'No Warning', 'no-dm': 'No DM',
  'recreate-channel': 'Recreate', 'many-honeypots': 'Many Honeypots', 'ensure-msg-delete': 'Ensure Delete',
  'alt-detection': 'Alt Detection', 'shared-banlist': 'Shared Banlist', 'no-link-filter': 'No Link Filter',
  'leaderboard': 'Leaderboard'
};
function prettyExperiment(v) { return EXPERIMENT_LABELS[v] || v; }
function avatarUrl(u) {
  if (u && u.avatar) return 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=64';
  return null;
}
function iconUrl(g) {
  if (!g || !g.icon) return null;
  if (g.icon.startsWith('http')) return g.icon;
  // handle animated icons (a_ prefix) -> use gif, else png
  var ext = g.icon.startsWith('a_') ? 'gif' : 'png';
  return 'https://cdn.discordapp.com/icons/' + g.id + '/' + g.icon + '.' + ext + '?size=64';
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
    app.innerHTML = '<div class="card center"><div style="font-size:2.2rem;margin-bottom:10px">🛡️</div>'
      + '<h2 style="font-size:1.2rem;margin-bottom:8px">Mod Dashboard</h2>'
      + '<p class="muted" style="margin-bottom:6px">Sign in to see servers where you moderate.</p>'
      + '<p class="muted" style="margin-bottom:18px">We only read your ID, name and server list &ndash; nothing is stored except a 24h login session.</p>'
      + '<a class="btn" href="/api/auth/login">Sign in with Discord</a></div>';
    return;
  }
  try {
    var prem = await api('/api/premium/me');
    if (!prem._unauth) {
      var wrap = document.createElement('div');
      wrap.id = 'premiumTop';
      var ex = document.getElementById('premiumTop');
      if (ex) ex.remove();
      var active = !!prem.premium;
      var running = !!prem.running;
      var uptime = prem.uptimeSec != null ? fmtUptime(prem.uptimeSec) : '-';
      var expires = prem.expiresAt ? new Date(prem.expiresAt * 1000).toLocaleDateString('en-US') : '-';
      var html = '<div class="card" style="border-color:' + (active ? '#1c3a2a' : '#3a2c10') + '">'
        + '<div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">'
        + '<div><div style="font-weight:800">🤖 My Bot &middot; <span class="muted">' + (active ? 'Premium active' : 'Free') + '</span></div>'
        + '<div class="muted" style="margin-top:4px">' + (active ? 'Uptime: ' + esc(uptime) + ' &middot; Expires: ' + esc(expires) + ' &middot; 3-day grace' : 'Pay 2€/month to host your own bot.') + '</div></div>'
        + '<div style="display:flex;gap:8px;align-items:center">'
        + (active ? '<button type="button" id="premStart" style="background:#1c3a2a;color:#34d399;border:1px solid #234434;border-radius:8px;padding:7px 14px;cursor:pointer">' + (running ? 'Restart' : 'Start') + '</button><button type="button" id="premStop" style="background:#3a1c1c;color:#f87171;border:1px solid #442323;border-radius:8px;padding:7px 14px;cursor:pointer">Stop</button>' : '')
        + '<button type="button" id="premEdit" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:7px 14px;cursor:pointer">' + (active ? 'Edit' : 'Get Premium') + '</button></div></div>';
      if (!active) html += '<div style="margin-top:10px;font-size:.85rem">Send <b>2€</b> in LTC to <code>' + esc(prem.donateLtc || 'ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6') + '</code> then paste txid below. Auto-verified after 2 confirmations. Ships with: txid single-use, amount & address check (Blockchair), price via CoinGecko, rate-limited.</div>'
        + '<div style="display:flex;gap:8px;margin-top:8px"><input id="premTxid" placeholder="64-char txid (hex)" maxlength="64" style="flex:1;background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:8px"><button type="button" id="premVerify" class="btn" style="padding:7px 16px;font-size:.9rem">Verify</button><button type="button" id="premTest" style="display:none;background:#23232e;color:#9a9ab0;border:1px solid #34343f;border-radius:8px;padding:7px 12px;font-size:.8rem">Test 7d</button></div><div class="muted" id="premVerifyMsg" style="margin-top:4px"></div>';
      html += '<div id="premForm" style="display:none;margin-top:12px;padding:12px;background:#1c1c26;border-radius:10px"><div style="display:grid;gap:8px"><input id="premToken" type="password" placeholder="DISCORD_TOKEN" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:8px"><input id="premSecret" type="password" placeholder="CLIENT_SECRET (optional)" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:8px"><input id="premUrl" placeholder="PUBLIC_URL (optional)" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:8px"><input id="premLtc" placeholder="DONATE_LTC (optional)" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:8px"><div style="display:flex;gap:8px"><button type="button" id="premSave" class="btn" style="padding:7px 16px;font-size:.9rem">Save</button><span class="muted" id="premMsg"></span></div></div></div></div>';
      if(isOwner){ setTimeout(function(){ var b=document.getElementById('premTest'); if(b) b.style.display='inline-block'; }, 100); }
      if (active) html +='<div id="premConsole" style="margin-top:12px;background:#0a0a0f;border:1px solid #34343f;border-radius:8px;overflow:hidden">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#1c1c26;border-bottom:1px solid #34343f">'
        + '<span style="font-weight:700">Honeypot</span><span style="display:flex;gap:6px">'
        + '<button type="button" id="premStart2" style="background:#5865F2;color:#fff;border:0;border-radius:6px;padding:4px 10px;font-size:.75rem;cursor:pointer">Start</button>'
        + '<button type="button" id="premRestart2" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:6px;padding:4px 10px;font-size:.75rem;cursor:pointer">Restart</button>'
        + '<button type="button" id="premStop2" style="background:#ef4444;color:#fff;border:0;border-radius:6px;padding:4px 10px;font-size:.75rem;cursor:pointer">Stop</button>'
        + '</span></div><div id="premStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;padding:12px"><div class="muted">Loading bot stats…</div></div></div>';
      wrap.innerHTML = html;
      var appEl = document.getElementById('app');
      if (appEl) appEl.prepend(wrap);
      var mapRunning = function(ok, msg){ var m=document.getElementById('premMsg'); if(m){m.textContent=msg; m.style.color=ok?'#34d399':'#f87171';}};
      var editBtn=document.getElementById('premEdit'); if(editBtn) editBtn.addEventListener('click', function(){ var f=document.getElementById('premForm'); if(f) f.style.display=f.style.display==='none'?'block':'none';});
      var saveBtn=document.getElementById('premSave'); if(saveBtn) saveBtn.addEventListener('click', async function(){ var t=(document.getElementById('premToken')).value||''; var s=(document.getElementById('premSecret')).value||''; var u=(document.getElementById('premUrl')).value||''; var l=(document.getElementById('premLtc')).value||''; try{ var r=await fetch('/api/premium/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,clientSecret:s,publicUrl:u,donateLtc:l})}); var j=await r.json(); if(!r.ok) mapRunning(false,j.error||'save failed'); else {mapRunning(true,'saved'); setTimeout(function(){location.reload();},800);} }catch(e){mapRunning(false,'failed');}});
      var startBtn=document.getElementById('premStart'); if(startBtn) startBtn.addEventListener('click', async function(){ startBtn.textContent='starting…'; try{ var r=await fetch('/api/premium/start',{method:'POST'}); var j=await r.json(); mapRunning(r.ok,r.ok?'started (pid '+(j.pid||'?')+')':(j.error||'start failed')); if(r.ok) setTimeout(function(){location.reload();},1000);}catch(e){mapRunning(false,'failed');} startBtn.textContent=running?'Restart':'Start';});
      var startBtn2=document.getElementById('premStart2'); if(startBtn2) startBtn2.addEventListener('click', async function(){ startBtn2.textContent='...'; try{ var r=await fetch('/api/premium/start',{method:'POST'}); var j=await r.json(); mapRunning(r.ok,r.ok?'started':(j.error||'failed')); if(r.ok) setTimeout(function(){location.reload();},800);}catch(e){} });
      var restartBtn2=document.getElementById('premRestart2'); if(restartBtn2) restartBtn2.addEventListener('click', async function(){ if(!confirm('Restart your bot?')) return; try{ var r=await fetch('/api/premium/restart',{method:'POST'}); var j=await r.json(); mapRunning(r.ok,r.ok?'restarted':(j.error||'failed')); if(r.ok) setTimeout(function(){location.reload();},800);}catch(e){} });
      var stopBtn2=document.getElementById('premStop2'); if(stopBtn2) stopBtn2.addEventListener('click', async function(){ if(!confirm('Stop your bot?')) return; try{ var r=await fetch('/api/premium/stop',{method:'POST'}); var j=await r.json(); mapRunning(r.ok,r.ok?'stopped':(j.error||'failed')); if(r.ok) setTimeout(function(){location.reload();},800);}catch(e){} });
      var stopBtn=document.getElementById('premStop'); if(stopBtn) stopBtn.addEventListener('click', async function(){ if(!window.confirm('Stop your bot?')) return; try{ var r=await fetch('/api/premium/stop',{method:'POST'}); var j=await r.json(); mapRunning(r.ok,r.ok?'stopped':(j.error||'stop failed')); if(r.ok) setTimeout(function(){location.reload();},800);}catch(e){mapRunning(false,'failed');}});
      var verifyBtn=document.getElementById('premVerify'); if(verifyBtn) verifyBtn.addEventListener('click', async function(){ var tx=(document.getElementById('premTxid')).value||''; var msgEl=document.getElementById('premVerifyMsg'); if(msgEl) msgEl.textContent='verifying…'; try{ var r=await fetch('/api/premium/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({txid:tx})}); var j=await r.json(); if(msgEl){ msgEl.textContent=r.ok?('verified! paid '+j.ltcAmount+' LTC ('+j.eurAmount.toFixed(2)+'€), '+j.confirmations+' conf. Premium until '+new Date(j.expiresAt*1000).toLocaleDateString()):(j.error||'verify failed'); msgEl.style.color=r.ok?'#34d399':'#f87171'; } if(r.ok) setTimeout(function(){location.reload();},1200);}catch(e){ if(msgEl){msgEl.textContent='failed'; msgEl.style.color='#f87171';}}});
      var testBtn=document.getElementById('premTest'); if(testBtn) testBtn.addEventListener('click', async function(){ if(!confirm('Activate TEST premium for 7 days (owner only)?')) return; try{ var r=await fetch('/api/premium/test-activate',{method:'POST'}); var j=await r.json(); alert(r.ok?'Test premium until '+new Date(j.expiresAt*1000).toLocaleDateString():(j.error||'failed')); if(r.ok) location.reload(); }catch(e){ alert('failed'); }});
      if(active){ fetch('/api/premium/stats').then(function(r){return r.json();}).then(function(s){ var el=document.getElementById('premStats'); if(!el) return; el.innerHTML='<div style="background:#1c1c26;border-radius:8px;padding:10px"><div class="muted">Uptime</div><div style="font-weight:700">'+(s.uptimeSec!=null?fmtUptime(s.uptimeSec):'-')+'</div></div><div style="background:#1c1c26;border-radius:8px;padding:10px"><div class="muted">Guilds</div><div style="font-weight:700">'+(s.guilds??0)+'</div></div><div style="background:#1c1c26;border-radius:8px;padding:10px"><div class="muted">Bans</div><div style="font-weight:700">'+(s.bans??0)+'</div></div><div style="background:#1c1c26;border-radius:8px;padding:10px"><div class="muted">DB</div><div style="font-weight:700">'+(s.dbKB!=null?s.dbKB+' KB':'-')+'</div></div><div style="background:#1c1c26;border-radius:8px;padding:10px"><div class="muted">Status</div><div style="font-weight:700;color:'+(s.running?'#34d399':'#f87171')+'">'+(s.running?'Running':'Stopped')+'</div></div>';}).catch(function(){}); }
    }
  } catch (e) {}
  showGuilds(app, me.user, !!me.isOwner);
}

async function showGuilds(app, user, isOwner) {
  var av = avatarUrl(user);
  var head = '<div class="topbar"><div style="display:flex;gap:10px;align-items:center">'
    + (av ? '<div class="avatar"><img src="' + av + '" alt=""></div>' : '')
    + '<div><b>' + esc(user.global_name || user.username) + '</b>' + (isOwner ? ' 👑' : '') + '<br><span class="muted">signed in' + (isOwner ? ' &middot; owner view: all servers' : '') + '</span></div></div>'
    + '<a href="/api/auth/logout">Logout</a></div>';
  var data;
  try { data = await api('/api/guilds'); } catch (e) { app.innerHTML = head + '<div class="card center">Failed to load servers.</div>'; return; }
  if (!data.guilds || !data.guilds.length) {
    app.innerHTML = head + '<div class="card center">No servers found where you moderate and the bot is set up.</div>';
    return;
  }
  var h = head;
  if (isOwner) h += '<div class="card" id="ownerConsole"><div class="center muted">Loading owner console&hellip;</div></div>';
  h += '<div class="guilds">';
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
      el.addEventListener('click', function () { showDetail(app, user, el.getAttribute('data-id'), isOwner); });
    })(els[j]);
  }
  if (isOwner) loadOwnerConsole();
}

var OWNER_EXPERIMENTS = ['reinvite', 'timeout-first', 'channel-warmer', 'random-channel-name', 'random-channel-name-chaos', 'only-recent-delete', 'no-warning-msg', 'no-dm', 'recreate-channel', 'forward-message', 'many-honeypots', 'ensure-msg-delete', 'alt-detection', 'shared-banlist', 'no-link-filter', 'leaderboard'];

async function loadOwnerConsole() {
  var el = document.getElementById('ownerConsole');
  if (!el) return;
  var d;
  try { d = await api('/api/owner/overview'); } catch (e) { el.innerHTML = '<div class="center muted">Owner console failed to load.</div>'; return; }
  var listed = [];
  try { listed = (await api('/api/guilds')).guilds || []; } catch (e) { /* guild list optional */ }
  var s = d.system || {};
  var counts = d.counts || {};
  var h = '<h2 style="font-size:1.1rem;margin-bottom:10px">👑 Owner Console</h2>'
    + '<div style="display:flex;gap:8px;margin-bottom:14px">'
    + '<button type="button" data-otab="ov" class="otab active">Overview</button>'
    + '<button type="button" data-otab="exp" class="otab">Experiments</button>'
    + '<button type="button" data-otab="bc" class="otab">Broadcast</button>'
    + '<button type="button" data-otab="prem" class="otab">Premium</button></div>'
    + '<div id="otab-ov">'
    + '<div class="stats">'
    + '<div class="stat"><div class="l">Uptime</div><div class="v" style="font-size:1.1rem">' + esc(fmtUptime(s.uptimeSec)) + '</div></div>'
    + '<div class="stat"><div class="l">Bans today</div><div class="v" style="font-size:1.1rem">' + fmt(counts.today) + '</div></div>'
    + '<div class="stat"><div class="l">Bans 30d</div><div class="v" style="font-size:1.1rem">' + fmt(counts.last30d) + '</div></div>'
    + '<div class="stat"><div class="l">Memory</div><div class="v" style="font-size:1.1rem">' + (s.memoryMB == null ? '?' : Number(s.memoryMB).toFixed(2) + ' MiB') + '</div></div>'
    + '<div class="stat"><div class="l">Database</div><div class="v" style="font-size:1.1rem">' + (s.dbKB == null ? '?' : fmt(s.dbKB) + ' KB') + '</div></div>'
    + '<div class="stat"><div class="l">Migration</div><div class="v" style="font-size:1.1rem">v' + esc(String(s.migration)) + '</div></div>'
    + '<div class="stat"><div class="l">Servers</div><div class="v" style="font-size:1.1rem">' + fmt(s.guilds) + '</div></div>'
    + '<div class="stat"><div class="l">Shared list</div><div class="v" style="font-size:1.1rem">' + fmt(counts.shared) + '</div></div>'
    + '<div class="stat"><div class="l">Fingerprints</div><div class="v" style="font-size:1.1rem">' + fmt(counts.prints) + '</div></div>'
    + '<div class="stat"><div class="l">Bun</div><div class="v" style="font-size:1.1rem">' + esc(s.bun || '?') + '</div></div>'
    + '</div>'
    + '<div style="font-weight:700;margin:16px 0 8px">Global feed (latest 25)</div><div id="ownerFeed"></div>'
    + '<div style="margin-top:14px"><a class="btn ghost" href="/api/owner/backup">Download database backup</a></div>'
    + '</div>'
    + '<div id="otab-exp" style="display:none"><div style="font-weight:700;margin:4px 0 8px">Experiments per server</div><div id="ownerExp"></div></div>'
    + '<div id="otab-prem" style="display:none"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="font-weight:700;margin:4px 0 8px">Premium users</div><button type="button" id="premTestOwner" onclick="testPremiumForMe(); return false;" style="background:#1c233a;color:#60a5fa;border:1px solid #2a3444;border-radius:8px;padding:5px 12px;font-size:.8rem;cursor:pointer">Test 7d for me</button></div><div id="premList" class="muted">Loading…</div></div>'
    + '<div id="otab-bc" style="display:none">'
    + '<div style="font-weight:700;margin:4px 0 8px">Broadcast to all log channels</div>'
    + '<textarea id="bcText" rows="3" maxlength="2000" placeholder="Announcement to every server with a log channel&hellip;" style="width:100%;background:#1c1c26;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:10px;font:inherit"></textarea>'
    + '<div style="display:flex;gap:10px;align-items:center;margin-top:8px"><button class="btn" id="bcSend" type="button">Send broadcast</button><span class="muted" id="bcResult"></span></div>'
    + '</div>';
  el.innerHTML = h;
  var otabs = el.querySelectorAll('.otab');
  for (var t = 0; t < otabs.length; t++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        for (var u = 0; u < otabs.length; u++) otabs[u].classList.remove('active');
        btn.classList.add('active');
        var want = btn.getAttribute('data-otab');
        var tabs=['ov','exp','prem','bc'];
        for (var k = 0; k < tabs.length; k++) {
          var pane = document.getElementById('otab-' + tabs[k]);
          if (pane) pane.style.display = (tabs[k] === want) ? 'block' : 'none';
        }
      });
    })(otabs[t]);
  }
  document.getElementById('bcSend').addEventListener('click', async function () {
    var text = document.getElementById('bcText').value || '';
    if (!text.trim()) return;
    if (!window.confirm('Send this to ALL servers with a log channel?')) return;
    document.getElementById('bcResult').textContent = 'sending…';
    try {
      var r = await fetch('/api/owner/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
      var j = await r.json();
      document.getElementById('bcResult').textContent = r.ok ? ('sent to ' + j.sent + '/' + j.total + ' channels') : ('failed: ' + (j.error || r.status));
    } catch (e) { document.getElementById('bcResult').textContent = 'failed'; }
  });
  renderOwnerExperiments(d.usage || {}, d.system ? d.system.guilds : 0, d.expStates || {}, listed);
  renderOwnerFeed(d.feed || []);
  loadOwnerPremium();
}

async function toggleExperiment(exp, enable, guildIds) {
  if (guildIds && guildIds.length) {
    if (!window.confirm((enable ? 'Enable "' : 'Disable "') + exp + '" on ' + guildIds.length + ' selected server(s)?')) return false;
  } else if (!window.confirm((enable ? 'Enable "' : 'Disable "') + exp + '" on ALL servers?')) return false;
  try {
    var body = guildIds && guildIds.length ? { experiment: exp, enable: enable, guildIds: guildIds } : { experiment: exp, enable: enable };
    var r = await fetch('/api/owner/experiment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok) window.alert('failed: ' + (j.error || r.status));
    return r.ok;
  } catch (e) { window.alert('failed'); return false; }
}


async function testPremiumForMe(){
  try{
    var r=await fetch('/api/premium/test-activate',{method:'POST'});
    var j=await r.json();
    if(r.ok) { alert('Test premium until '+new Date(j.expiresAt*1000).toLocaleString()); location.reload(); }
    else alert(j.error||'failed');
  } catch(e){ alert('failed'); }
}
async function loadOwnerPremium(){
  var box=document.getElementById('premList');
  if(!box) return;
  try{
    var r=await fetch('/api/owner/premium');
    var j=await r.json();
    if(!r.ok){ box.textContent='failed: '+(j.error||r.status); return; }
    if(!j.users.length){ box.textContent='No premium users yet.'; return; }
    var h='<div style="display:grid;gap:8px">';
    for(var i=0;i<j.users.length;i++){
      var u=j.users[i];
      var exp=u.expiresAt? new Date(u.expiresAt*1000).toLocaleDateString('en-US'):'-';
      var runBadge = u.running ? '<span style="color:#34d399">● Running</span>' : '<span style="color:#f87171">● Stopped</span>';
      var uptime = u.uptimeSec!=null ? (function(s){ var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60); if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m+'m'; })(u.uptimeSec) : '-';
      h+='<div style="padding:10px;background:#1c1c26;border-radius:10px;border:1px solid #2a2a3a">'
        +'<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap">'
        +'<div><b>'+esc(u.username||u.userId)+'</b> <span class="muted">'+esc(u.userId)+'</span><br><span class="muted">'+esc(u.status)+' &middot; expires '+esc(exp)+' &middot; token '+(u.hasToken?'yes':'no')+' &middot; '+runBadge+'</span>'
        +'<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap"><span class="muted">Uptime: <b style="color:#e8e8ef">'+uptime+'</b></span><span class="muted">Guilds: <b style="color:#e8e8ef">'+(u.guilds??0)+'</b></span><span class="muted">Bans: <b style="color:#e8e8ef">'+(u.bans??0)+'</b></span><span class="muted">DB: <b style="color:#e8e8ef">'+(u.dbKB!=null?u.dbKB+' KB':'-')+'</b></span></div></div>'
        +'<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><button type="button" data-act="activate" data-uid="'+esc(u.userId)+'" style="background:#1c3a2a;color:#34d399;border:1px solid #234434;border-radius:6px;padding:4px 10px;cursor:pointer">+30d</button><button type="button" data-act="start" data-uid="'+esc(u.userId)+'" style="background:#1c233a;color:#60a5fa;border:1px solid #2a3444;border-radius:6px;padding:4px 10px;cursor:pointer">start</button><button type="button" data-act="restart" data-uid="'+esc(u.userId)+'" style="background:#2a2a1c;color:#f5a623;border:1px solid #443422;border-radius:6px;padding:4px 10px;cursor:pointer">restart</button><button type="button" data-act="stop" data-uid="'+esc(u.userId)+'" style="background:#3a2a10;color:#f5a623;border:1px solid #443422;border-radius:6px;padding:4px 10px;cursor:pointer">stop</button><button type="button" data-act="revoke" data-uid="'+esc(u.userId)+'" style="background:#3a1c1c;color:#f87171;border:1px solid #442323;border-radius:6px;padding:4px 10px;cursor:pointer">revoke</button></div></div></div>';
    }
    box.innerHTML=h+'</div>';
    var testBtn=document.getElementById('premTestOwner'); if(testBtn) testBtn.addEventListener('click', testPremiumForMe);
    var btns=box.querySelectorAll('button[data-act]');
    for(var b=0;b<btns.length;b++)(function(btn){
      btn.addEventListener('click', async function(){
        var act=btn.getAttribute('data-act'); var uid=btn.getAttribute('data-uid');
        if(act==='activate'){
          var days=parseInt(prompt('Days to add?','30')||'30',10)||30;
          var r=await fetch('/api/owner/premium/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:uid,days:days})});
          var j=await r.json(); if(!r.ok) alert(j.error||'failed'); else loadOwnerPremium();
        } else if(act==='start' || act==='restart' || act==='stop'){
          var r=await fetch('/api/owner/premium/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:uid,action:act})});
          var j=await r.json(); if(!r.ok) alert(j.error||'failed'); else { alert(act+' ok'+(j.pid?(' pid '+j.pid):'')); loadOwnerPremium(); }
        } else {
          if(!confirm('Revoke premium for '+uid+'?')) return;
          var r=await fetch('/api/owner/premium/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:uid})});
          var j=await r.json(); if(!r.ok) alert(j.error||'failed'); else loadOwnerPremium();
        }
      });
    })(btns[b]);
  }catch(e){ box.textContent='failed'; }
}
function renderOwnerExperiments(usage, totalGuilds, expStates, allGuilds) {
  var box = document.getElementById('ownerExp');
  if (!box) return;
  var h = '';
  for (var i = 0; i < OWNER_EXPERIMENTS.length; i++) {
    var v = OWNER_EXPERIMENTS[i];
    var on = usage[v] || 0;
    h += '<div style="border-bottom:1px solid #1c1c26;padding:6px 0">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
      + '<span>' + esc(prettyExperiment(v)) + ' <span class="muted">' + on + '/' + totalGuilds + '</span></span>'
      + '<span><button type="button" data-exp-toggle="' + esc(v) + '" style="background:none;border:0;color:#9a9ab0;font-size:.78rem;cursor:pointer">servers &#9662;</button> '
      + '<button type="button" data-exp="' + esc(v) + '" data-on="1" style="background:#1c3a2a;color:#34d399;border:1px solid #234434;border-radius:6px;padding:2px 10px;font-size:.75rem;cursor:pointer">all on</button> '
      + '<button type="button" data-exp="' + esc(v) + '" data-on="0" style="background:#3a1c1c;color:#f87171;border:1px solid #442323;border-radius:6px;padding:2px 10px;font-size:.75rem;cursor:pointer">all off</button></span></div>'
      + '<div data-exp-servers="' + esc(v) + '" style="display:none;margin:8px 0 4px;padding:10px;background:#1c1c26;border-radius:8px;max-height:220px;overflow:auto">'
      + '<div style="margin-bottom:8px"><a href="#" data-select="all" style="color:#9a9ab0;font-size:.78rem">select all</a> &middot; <a href="#" data-select="none" style="color:#9a9ab0;font-size:.78rem">none</a></div>';
    var enabledHere = expStates[v] || [];
    for (var gi = 0; gi < allGuilds.length; gi++) {
      var gg = allGuilds[gi];
      var checked = enabledHere.indexOf(gg.id) >= 0 ? ' checked' : '';
      h += '<label style="display:flex;gap:8px;align-items:center;padding:3px 0;font-size:.85rem;cursor:pointer">'
        + '<input type="checkbox" data-guild="' + esc(gg.id) + '"' + checked + '> ' + esc(gg.name) + '</label>';
    }
    h += '<div style="margin-top:8px;display:flex;gap:8px"><button type="button" data-apply="1" style="background:#1c3a2a;color:#34d399;border:1px solid #234434;border-radius:6px;padding:4px 12px;font-size:.78rem;cursor:pointer">enable selected</button>'
      + '<button type="button" data-apply="0" style="background:#3a1c1c;color:#f87171;border:1px solid #442323;border-radius:6px;padding:4px 12px;font-size:.78rem;cursor:pointer">disable selected</button></div>'
      + '</div></div>';
  }
  box.innerHTML = h;
  var toggles = box.querySelectorAll('button[data-exp-toggle]');
  for (var t = 0; t < toggles.length; t++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var panel = box.querySelector('div[data-exp-servers="' + btn.getAttribute('data-exp-toggle') + '"]');
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    })(toggles[t]);
  }
  var links = box.querySelectorAll('a[data-select]');
  for (var l = 0; l < links.length; l++) {
    (function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var panel = a.closest('div[data-exp-servers]');
        if (!panel) return;
        var cbs = panel.querySelectorAll('input[data-guild]');
        var check = a.getAttribute('data-select') === 'all';
        for (var c = 0; c < cbs.length; c++) cbs[c].checked = check;
      });
    })(links[l]);
  }
  var appliers = box.querySelectorAll('button[data-apply]');
  for (var ap = 0; ap < appliers.length; ap++) {
    (function (btn) {
      btn.addEventListener('click', async function () {
        var panel = btn.closest('div[data-exp-servers]');
        if (!panel) return;
        var exp = panel.getAttribute('data-exp-servers') || '';
        var enable = btn.getAttribute('data-apply') === '1';
        var ids = [];
        var cbs = panel.querySelectorAll('input[data-guild]:checked');
        for (var c = 0; c < cbs.length; c++) { var v = cbs[c].getAttribute('data-guild') || ''; if (v) ids.push(v); }
        if (!ids.length) { window.alert('Select at least one server.'); return; }
        if (await toggleExperiment(exp, enable, ids)) loadOwnerConsole();
      });
    })(appliers[ap]);
  }
  var btns = box.querySelectorAll('button[data-exp]');
  for (var b = 0; b < btns.length; b++) {
    (function (btn) {
      btn.addEventListener('click', async function () {
        var exp = btn.getAttribute('data-exp') || '';
        var enable = btn.getAttribute('data-on') === '1';
        if (!window.confirm((enable ? 'Enable "' : 'Disable "') + exp + '" on ALL servers?')) return;
        try {
          var r = await fetch('/api/owner/experiment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experiment: exp, enable: enable }) });
          var j = await r.json();
          if (r.ok) loadOwnerConsole();
          else window.alert('failed: ' + (j.error || r.status));
        } catch (e) { window.alert('failed'); }
      });
    })(btns[b]);
  }
}

function renderOwnerFeed(feed) {
  var box = document.getElementById('ownerFeed');
  if (!box) return;
  if (!feed.length) { box.innerHTML = '<div class="muted">No events yet.</div>'; return; }
  var h = '<div style="overflow-x:auto"><table><tr><th>Time</th><th>Server</th><th>User</th><th>Action</th><th>Reason</th></tr>';
  for (var i = 0; i < feed.length; i++) {
    var e = feed[i];
    var badge = e.action === 'ban' ? '<span class="badge ban">ban</span>' : '<span class="badge softban">softban</span>';
    h += '<tr><td style="white-space:nowrap">' + esc(fmtTime(e.timestamp)) + '</td>'
      + '<td>' + esc(e.guild_name || e.guild_id) + '</td>'
      + '<td><code>' + esc(e.user_id) + '</code> <a href="https://discord.com/users/' + esc(e.user_id) + '" target="_blank" rel="noopener" style="text-decoration:none">↗</a></td>'
      + '<td>' + badge + '</td><td>' + esc(e.reason || '-') + '</td></tr>';
  }
  box.innerHTML = h + '</table></div>';
}

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

async function showDetail(app, user, guildId, isOwner) {
  app.innerHTML = '<div class="card center">Loading&hellip;</div>';
  var d;
  try { d = await api('/api/guilds/' + encodeURIComponent(guildId)); } catch (e) { app.innerHTML = '<div class="card center">Failed to load.</div>'; return; }
  var h = '<div class="topbar"><a href="#" id="back">&larr; Back</a><a href="/api/auth/logout">Logout</a></div>';
  var gicon = d.guild.icon
    ? '<img src="https://cdn.discordapp.com/icons/' + esc(d.guild.id) + '/' + esc(d.guild.icon) + '.png?size=64" width="44" height="44" alt="" style="border-radius:50%" onerror="this.remove()">'
    : '';
  h += '<div class="card"><div style="display:flex;gap:12px;align-items:center;margin-bottom:6px">'
    + (gicon ? '<span style="display:inline-flex;width:44px;height:44px;border-radius:50%;background:#5865F2;align-items:center;justify-content:center;font-weight:800;font-size:1.2rem;overflow:hidden;flex-shrink:0">' + esc((d.guild.name || '?').slice(0, 1)) + gicon + '</span>' : '')
    + '<div><h2 style="font-size:1.2rem">' + esc(d.guild.name) + '</h2>'
    + '<div class="muted">Action: <b>' + esc(d.config.action) + '</b> &middot; Log: ' + (d.config.logChannel ? '#' + esc(d.config.logChannel.name || d.config.logChannel.id) : 'not set') + '</div></div></div>';
  if (d.config.experiments && d.config.experiments.length) {
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 2px">';
    for (var x = 0; x < d.config.experiments.length; x++) {
      h += '<span style="background:#1c1c26;border:1px solid #34343f;border-radius:20px;padding:3px 12px;font-size:.78rem">' + esc(prettyExperiment(d.config.experiments[x])) + '</span>';
    }
    h += '</div>';
  }
  h += '<div class="stats">'
    + '<div class="stat"><div class="l">Total</div><div class="v">' + fmt(d.stats.total) + '</div></div>'
    + '<div class="stat"><div class="l">Last 7 days</div><div class="v">' + fmt(d.stats.last7d) + '</div></div>'
    + '<div class="stat"><div class="l">Bans</div><div class="v" style="color:#f87171">' + fmt(d.stats.byAction.ban) + '</div></div>'
    + '<div class="stat"><div class="l">Softbans</div><div class="v" style="color:#f5a623">' + fmt(d.stats.byAction.softban) + '</div></div>'
    + '</div>';
  if (d.channels && d.channels.length) {
    h += '<div style="font-weight:700;margin:14px 0 8px">Moderation</div>'
      + '<div style="display:grid;gap:10px;background:#1c1c26;border-radius:10px;padding:12px 14px;margin-bottom:6px">'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted">Action:</span>'
      + '<select id="modAction" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 10px">'
      + '<option value="softban">Softban (kick)</option><option value="ban">Ban</option><option value="disabled">Disabled</option></select>'
      + '<button type="button" id="modActionSave" style="background:#5865F2;color:#fff;border:0;border-radius:8px;padding:6px 14px;cursor:pointer">Save</button></div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted">Unban:</span>'
      + '<input id="unbanId" inputmode="numeric" placeholder="user id" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 10px;width:170px">'
      + '<button type="button" id="unbanBtn" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 14px;cursor:pointer">Unban</button></div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="muted">Timeout:</span>'
      + '<input id="timeoutId" inputmode="numeric" placeholder="user id" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 10px;width:170px">'
      + '<input id="timeoutMin" inputmode="numeric" placeholder="60" value="60" style="background:#14141c;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 10px;width:70px">'
      + '<span class="muted">min</span>'
      + '<button type="button" id="timeoutBtn" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:8px;padding:6px 14px;cursor:pointer">Timeout</button></div>'
      + '<div class="muted" id="modResult"></div></div>';
  }
  if (d.channels && d.channels.length) {
    h += '<div style="font-weight:700;margin:6px 0 8px">Honeypot channels</div><div style="display:grid;gap:8px">';
    for (var ci = 0; ci < d.channels.length; ci++) {
      var ch = d.channels[ci];
      h += '<div style="display:flex;justify-content:space-between;align-items:center;background:#1c1c26;border-radius:10px;padding:9px 14px;gap:8px;flex-wrap:wrap">'
        + '<span># ' + esc(ch.name || ch.channelId) + '</span>'
        + '<span><span class="muted" style="margin-right:8px">' + fmt(ch.moderated) + ' caught</span>'
        + '<button type="button" data-run="warmer" data-channel="' + esc(ch.channelId) + '" title="Send + delete warmer message now" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:6px;padding:2px 10px;font-size:.75rem;cursor:pointer">warm</button> '
        + '<button type="button" data-run="rename" data-channel="' + esc(ch.channelId) + '" title="Rename now" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:6px;padding:2px 10px;font-size:.75rem;cursor:pointer">rename</button></span></div>';
    }
    h += '</div>';
  }
  h += '</div>';
  h += '<div class="card"><h2 style="font-size:1.1rem;margin-bottom:10px">Recent events</h2>';
  if (!d.recent || !d.recent.length) {
    h += '<div class="muted">No events yet.</div>';
  } else {
    h += '<div style="overflow-x:auto"><table><tr><th>Time</th><th>User</th><th>Action</th><th>Channel</th><th>Reason</th></tr>';
    for (var i = 0; i < d.recent.length; i++) {
      var e = d.recent[i];
      var badge = e.action === 'ban' ? '<span class="badge ban">ban</span>' : '<span class="badge softban">softban</span>';
      var chName = null;
      for (var cj = 0; cj < (d.channels || []).length; cj++) {
        if (d.channels[cj].channelId === e.channel_id) chName = d.channels[cj].name;
      }
      h += '<tr><td style="white-space:nowrap">' + esc(fmtTime(e.timestamp)) + '</td>'
        + '<td><code>' + esc(e.user_id) + '</code> <a href="https://discord.com/users/' + esc(e.user_id) + '" target="_blank" rel="noopener" title="Open profile" style="text-decoration:none">↗</a> <button type="button" data-copy="' + esc(e.user_id) + '" title="Copy ID" style="background:#23232e;color:#e8e8ef;border:1px solid #34343f;border-radius:6px;padding:1px 7px;font-size:.72rem;cursor:pointer">copy</button></td>'
        + '<td>' + badge + '</td>'
        + '<td>' + (chName ? '# ' + esc(chName) : '<code>' + esc(e.channel_id || '-') + '</code>') + '</td>'
        + '<td>' + esc(e.reason || '-') + '</td></tr>';
    }
    h += '</table></div>';
  }
  h += '</div>';
  app.innerHTML = h;
  document.getElementById('back').addEventListener('click', function (ev) { ev.preventDefault(); showGuilds(app, user, isOwner); });
  var cps = app.querySelectorAll('button[data-copy]');
  for (var cp = 0; cp < cps.length; cp++) {
    (function (btn) {
      btn.addEventListener('click', function () { copyText(btn.getAttribute('data-copy') || '', btn); });
    })(cps[cp]);
  }
  function modResult(text, ok) {
    var r = document.getElementById('modResult');
    if (r) {
      r.textContent = text;
      r.style.color = ok ? '#34d399' : '#f87171';
    }
  }
  async function modPost(path, body) {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = null;
    try { j = await r.json(); } catch (e) { /* ignore */ }
    return { ok: r.ok, body: j || {} };
  }
  var actionSel = document.getElementById('modAction');
  if (actionSel && d.config) actionSel.value = d.config.action || 'softban';
  var actionSave = document.getElementById('modActionSave');
  if (actionSave) actionSave.addEventListener('click', async function () {
    var sel = document.getElementById('modAction');
    var res = await modPost('/api/mod/action', { guildId: guildId, action: sel ? sel.value : 'softban' });
    modResult(res.ok ? 'Action saved.' : ('Failed: ' + (res.body.error || 'error')), res.ok);
  });
  var unbanBtn = document.getElementById('unbanBtn');
  if (unbanBtn) unbanBtn.addEventListener('click', async function () {
    var idEl = document.getElementById('unbanId');
    var id = idEl ? (idEl.value || '').trim() : '';
    if (!/^\d+$/.test(id)) { modResult('Enter a user ID.', false); return; }
    if (!window.confirm('Unban ' + id + '?')) return;
    var res = await modPost('/api/mod/unban', { guildId: guildId, userId: id });
    modResult(res.ok ? 'User unbanned.' : ('Failed: ' + (res.body.error || 'error')), res.ok);
  });
  var timeoutBtn = document.getElementById('timeoutBtn');
  if (timeoutBtn) timeoutBtn.addEventListener('click', async function () {
    var idEl = document.getElementById('timeoutId');
    var minEl = document.getElementById('timeoutMin');
    var id = idEl ? (idEl.value || '').trim() : '';
    var mins = minEl ? Math.min(Math.max(parseInt(minEl.value || '60', 10) || 60, 1), 40320) : 60;
    if (!/^\d+$/.test(id)) { modResult('Enter a user ID.', false); return; }
    if (!window.confirm('Timeout ' + id + ' for ' + mins + ' min?')) return;
    var res = await modPost('/api/mod/timeout', { guildId: guildId, userId: id, minutes: mins });
    modResult(res.ok ? 'User timed out.' : ('Failed: ' + (res.body.error || 'error')), res.ok);
  });
  var runners = app.querySelectorAll('button[data-run]');
  for (var rn = 0; rn < runners.length; rn++) {
    (function (btn) {
      btn.addEventListener('click', async function () {
        var res = await modPost('/api/mod/run', { guildId: guildId, channelId: btn.getAttribute('data-channel') || '', task: btn.getAttribute('data-run') || '' });
        modResult(res.ok ? 'Done.' : ('Failed: ' + (res.body.error || 'error')), res.ok);
        if (res.ok) showDetail(app, user, guildId, isOwner);
      });
    })(runners[rn]);
  }
}

init().catch(function (e) {
  var app = document.getElementById('app');
  if (app) app.innerHTML = '<div class="card center">Something broke: ' + esc(String((e && e.message) || e)) + '</div>';
});
</script>
</body>
</html>`;
