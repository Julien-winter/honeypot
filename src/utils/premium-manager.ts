import { styleText } from "node:util";

type ManagedBot = { proc: ReturnType<typeof Bun.spawn> | null; startedAt: number | null };

const bots = new Map<string, ManagedBot>();

function dbPath(userId: string): string {
    return `${process.cwd()}/premium_${userId}.sqlite`;
}

function envFor(userId: string, token: string, secret: string | null, publicUrl: string | null, donateLtc: string | null): Record<string, string> {
    const env: Record<string, string> = {
        DISCORD_TOKEN: token,
        DATABASE_URL: `sqlite://${dbPath(userId)}`,
        HAS_MESSAGE_INTENT: process.env.HAS_MESSAGE_INTENT || "1",
        CUSTOM_EMOJI_ID: process.env.CUSTOM_EMOJI_ID || "1548306645812121741",
        PORT: String(3000 + (Number(userId.slice(-4)) % 20000)),
    };
    if (secret) env.DISCORD_CLIENT_SECRET = secret;
    if (publicUrl) {
        env.PUBLIC_URL = publicUrl;
        env.SITE_URL = publicUrl;
        env.STATS_PAGE_URL = publicUrl;
        env.DASHBOARD_URL = `${publicUrl.replace(/\/$/, "")}/dashboard`;
    }
    if (donateLtc) env.DONATE_LTC = donateLtc;
    return env;
}

export function isPremiumRunning(userId: string): boolean {
    const b = bots.get(userId);
    return !!b?.proc && b.proc.exitCode === null;
}

export function premiumUptimeSec(userId: string): number | null {
    const b = bots.get(userId);
    if (!b?.startedAt || !isPremiumRunning(userId)) return null;
    return Math.floor((Date.now() - b.startedAt) / 1000);
}

export async function startPremiumBot(userId: string): Promise<{ ok: boolean; error?: string; pid?: number }> {
    const mod = await import("./db");
    const row = await mod.getPremiumUser(userId);
    if (!row || !row.discord_token) return { ok: false, error: "no token saved" };
    if (!(await mod.isPremiumActive(userId))) return { ok: false, error: "premium expired" };
    if (isPremiumRunning(userId)) return { ok: true, pid: bots.get(userId)?.proc?.pid };

    const existing = bots.get(userId);
    if (existing?.proc) {
        try { existing.proc.kill(); } catch { /* ignore */ }
    }

    const env = envFor(userId, row.discord_token, row.client_secret, row.public_url, row.donate_ltc);
    const proc = Bun.spawn(["bun", "src/bot.ts"], {
        cwd: process.cwd(),
        env: { ...process.env as Record<string, string>, ...env },
        stdout: "ignore",
        stderr: "pipe",
    });

    bots.set(userId, { proc, startedAt: Date.now() });
    // bump run counter (best effort)
    mod.upsertPremiumUser(userId, {}).catch(() => null);

    // watch for early crash
    setTimeout(async () => {
        if (proc.exitCode !== null) {
            try {
                const err = await new Response(proc.stderr as any).text().catch(() => "");
                console.log(styleText("dim", `[premium:${userId}] exited early ${proc.exitCode}: ${err.slice(0, 400)}`));
            } catch { /* ignore */ }
        }
    }, 3000);

    return { ok: true, pid: proc.pid };
}

export function stopPremiumBot(userId: string): { ok: boolean } {
    const b = bots.get(userId);
    if (!b?.proc) return { ok: false };
    try { b.proc.kill(); } catch { /* ignore */ }
    bots.set(userId, { proc: null, startedAt: null });
    return { ok: true };
}

export async function autostartPremiumBots(): Promise<void> {
    try {
        const mod = await import("./db");
        const all = await mod.listPremiumUsers().catch(() => []);
        for (const u of all) {
            if (u.status === "active" && u.discord_token && await mod.isPremiumActive(u.user_id)) {
                const res = await startPremiumBot(u.user_id);
                if (res.ok) console.log(`[premium] autostarted bot for ${u.user_id} (pid ${res.pid})`);
                await Bun.sleep(1500);
            }
        }
    } catch (err) {
        console.log(styleText("dim", `[premium] autostart failed: ${err}`));
    }
}

export function listPremiumRunning(): { userId: string; pid: number | null; uptimeSec: number | null }[] {
    return [...bots.entries()].map(([userId, b]) => ({
        userId,
        pid: b.proc?.pid ?? null,
        uptimeSec: premiumUptimeSec(userId),
    }));
}

export async function getPremiumBotStats(userId: string): Promise<{ uptimeSec: number | null; running: boolean; guilds: number; bans: number; dbKB: number | null }> {
    const running = isPremiumRunning(userId);
    const uptimeSec = premiumUptimeSec(userId);
    let guilds = 0, bans = 0, dbKB: number | null = null;
    try {
        const { SQL } = await import("bun");
        const pdb = new SQL(`sqlite://${dbPath(userId)}`);
        const [gRow] = await pdb`SELECT COUNT(*) as c FROM honeypot_config`.catch(() => [{ c: 0 }]) as any;
        const [bRow] = await pdb`SELECT COUNT(*) as c FROM honeypot_events`.catch(() => [{ c: 0 }]) as any;
        guilds = Number(gRow?.c ?? 0);
        bans = Number(bRow?.c ?? 0);
    } catch { /* ignore */ }
    try {
        const f = Bun.file(dbPath(userId));
        if (await f.exists()) dbKB = Math.round((await f.arrayBuffer()).byteLength / 1024);
    } catch { /* ignore */ }
    return { uptimeSec, running, guilds, bans, dbKB };
}
