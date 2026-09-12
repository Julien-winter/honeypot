import * as db from "./utils/db";
import { pageHtml } from "./stats-page";
import { handleDashboard } from "./dashboard";
import { docsHtml } from "./docs-page";
import { termsHtml, privacyHtml } from "./legal";
import { getInviteUrl } from "./utils/messages";
import iconSvg from "./honeypot.svg" with { type: "text" };

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
    updatedAt: string;
};

let cache: { at: number; data: PublicStats } | null = null;
const CACHE_MS = 60_000;

export async function getPublicStats(): Promise<PublicStats> {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) return cache.data;

    const full = await db.getFullStats();
    const uptimeSec = Math.floor(process.uptime());
    const totalChannels = await db.getTotalHoneypotChannels().catch(() => 0);
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
        updatedAt: new Date().toISOString(),
    };
    cache = { at: now, data };
    return data;
}

export function startStatsServer(): number {
    // Pterodactyl exposes the primary allocation port as SERVER_PORT.
    const port = Number(process.env.STATS_PORT || process.env.SERVER_PORT || process.env.PORT || 3000);
    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);
            const dashboardRes = await handleDashboard(req, url);
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
