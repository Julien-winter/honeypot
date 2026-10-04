import * as db from "./utils/db";
import { pageHtml } from "./stats-page";
import { handleDashboard } from "./dashboard";
import { docsHtml } from "./docs-page";
import { arcadeHtml } from "./arcade-page";
import { termsHtml, privacyHtml } from "./legal";
import { getInviteUrl } from "./utils/messages";
import iconSvg from "./honeypot.svg" with { type: "text" };
import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";

let botApi: API | API2 | null = null;
/** Gives the dashboard access to Discord (for owner actions). Optional. */
export function setBotApi(api: API | API2): void {
    botApi = api;
}

// Public aggregate stats only (no user IDs, no guild IDs, no message content).
export type PublicStats = {
    bans7d: number;
    totalBans: number;
    byAction: { ban: number; softban: number };
    triggeredServers7d: number;
    totalServers: number;
    totalChannels: number;
    inviteUrl: string;
    daily: { date: string; bans: number; servers: number }[];
    uptimeSec: number;
    startedAt: string;
    donateLtc: string;
    leaderboard: { name: string; icon: string | null; moderations: number }[];
    history: { date: string; guilds: number; moderations: number }[];
    community: {
        name: string;
        online: number;
        total: number | null;
        icon: string | null;
        invite: string | null;
        members: { name: string; status: string; avatar: string | null }[];
    } | null;
    updatedAt: string;
};

let cache: { at: number; data: PublicStats } | null = null;
const CACHE_MS = 60_000;

let communityCache: { at: number; data: PublicStats["community"] } | null = null;
const COMMUNITY_CACHE_MS = 5 * 60_000;
const COMMUNITY_GUILD_ID = process.env.COMMUNITY_GUILD_ID || "1546167772831285271";

async function getCommunity(): Promise<PublicStats["community"]> {
    const now = Date.now();
    if (communityCache && now - communityCache.at < COMMUNITY_CACHE_MS) return communityCache.data;
    try {
        const res = await fetch(`https://discord.com/api/guilds/${COMMUNITY_GUILD_ID}/widget.json`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`widget ${res.status}`);
        const w = await res.json() as {
            name?: string; presence_count?: number; instant_invite?: string;
            members?: { username?: string; status?: string; avatar_url?: string }[];
        };
        const members = Array.isArray(w.members) ? w.members.slice(0, 14).map((m) => ({
            name: String(m.username ?? "?").slice(0, 32),
            status: String(m.status ?? "online"),
            avatar: typeof m.avatar_url === "string" ? m.avatar_url : null,
        })) : [];
        const invite: string | null = typeof w.instant_invite === "string" ? w.instant_invite : null;
        // Total member count + server icon come from the public invite endpoint.
        let total: number | null = null;
        let icon: string | null = null;
        try {
            const code = (invite ? invite.split("/").pop() : "") || "6QzDSBXQ6E";
            const ir = await fetch(`https://discord.com/api/v10/invites/${code}?with_counts=true`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (ir.ok) {
                const inv = await ir.json() as {
                    approximate_member_count?: number;
                    guild?: { id?: string; icon?: string | null };
                };
                if (Number.isFinite(Number(inv.approximate_member_count))) total = Number(inv.approximate_member_count);
                if (inv.guild?.id && inv.guild?.icon) {
                    icon = `https://cdn.discordapp.com/icons/${inv.guild.id}/${inv.guild.icon}.png?size=128`;
                }
            }
        } catch {
            // optional enrichment, ignore failures
        }
        const data: PublicStats["community"] = {
            name: String(w.name ?? "Discord"),
            online: Number(w.presence_count ?? members.length),
            total,
            icon,
            invite,
            members,
        };
        communityCache = { at: now, data };
        return data;
    } catch (err) {
        console.error(`[stats] community widget failed: ${err}`);
        return communityCache?.data ?? null;
    }
}

export async function getPublicStats(): Promise<PublicStats> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) return cache.data;

    const full = await db.getFullStats();
    const uptimeSec = Math.floor(process.uptime());
    const totalChannels = await db.getTotalHoneypotChannels().catch(() => 0);
    const community = await getCommunity();
    const [leaderboard, history] = await Promise.all([
        db.getLeaderboard(10).catch(() => []),
        db.getHistory90().catch(() => []),
    ]);
    const data: PublicStats = {
        bans7d: full.last7dModerations,
        totalBans: full.moderations,
        byAction: full.moderationsByAction,
        triggeredServers7d: full.last7dEngagedGuilds,
        totalServers: full.guilds,
        totalChannels,
        inviteUrl: getInviteUrl(),
        daily: full.dailyStats.map((d) => ({ date: d.date, bans: d.moderations, servers: d.engagedGuilds })),
        uptimeSec,
        startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
        donateLtc: process.env.DONATE_LTC || "ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6",
        community,
        leaderboard,
        history,
        updatedAt: new Date().toISOString(),
    };
    cache = { at: now, data };
    return data;
}

export function startStatsServer(api?: API | API2 | null): number {
    if (api) botApi = api;
    // Pterodactyl exposes the primary allocation port as SERVER_PORT.
    const port = Number(process.env.STATS_PORT || process.env.SERVER_PORT || process.env.PORT || 3000);
    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);
            const dashboardRes = await handleDashboard(req, url, botApi);
            if (dashboardRes) return dashboardRes;
            if (url.pathname === "/health" || url.pathname === "/live") {
                try {
                    await db.pingDb();
                    return Response.json({
                        ok: true,
                        uptimeSec: Math.floor(process.uptime()),
                        db: "ok",
                        time: new Date().toISOString(),
                    });
                } catch (err) {
                    console.error(`[stats] health check failed: ${err}`);
                    return Response.json({ ok: false, db: "error" }, { status: 503 });
                }
            }
            if (url.pathname === "/api/stats") {
                try {
                    const data = await getPublicStats();
                    return Response.json(data, {
                        headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Cache-Control": "public, max-age=60",
                        },
                    });
                } catch (err) {
                    console.error(`[stats] failed to build stats: ${err}`);
                    return Response.json({ error: "stats unavailable" }, { status: 500 });
                }
            }
            if (url.pathname === "/" || url.pathname === "/index.html") {
                return new Response(pageHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
                });
            }
            if (url.pathname === "/honeypot.svg" || url.pathname === "/favicon.svg") {
                return new Response(iconSvg, {
                    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
                });
            }
            if (url.pathname === "/terms" || url.pathname === "/terms/") {
                return new Response(termsHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
                });
            }
            if (url.pathname === "/privacy" || url.pathname === "/privacy/") {
                return new Response(privacyHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
                });
            }
            if (url.pathname === "/docs" || url.pathname === "/docs/") {
                const html = docsHtml.split("{{INVITE_URL}}").join(getInviteUrl());
                return new Response(html, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
                });
            }
            if (url.pathname === "/arcade" || url.pathname === "/arcade/") {
                return new Response(arcadeHtml, {
                    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
                });
            }
            return new Response("Not found", { status: 404 });
        },
    });
    console.log(`[stats] dashboard listening on :${port}`);
    return port;
}

// Allow running standalone for testing: `bun src/stats-server.ts`
if (import.meta.main) {
    await db.initDb();
    startStatsServer();
}
