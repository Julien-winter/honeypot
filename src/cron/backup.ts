import type { Cron } from "./crons";
import { styleText } from "node:util";
import { createBackup } from "../security/backup";

let running = false;

/** Per-server snapshot cadence: randomized between 10 and 60 minutes, newest snapshot replaces the old one (keep=1). */
const SLOT_MIN_MS = 10 * 60_000;
const SLOT_MAX_MS = 60 * 60_000;
/** guildId -> next allowed snapshot time (missing entry = due immediately). */
const nextDue = new Map<string, number>();

/**
 * Snapshot the structure of every guild with Auto-Backups OR Anti-Nuke enabled
 * (anti-nuke needs restore points without any manual step).
 * Runs at bot start and then every 10 minutes; each guild is picked up on its own
 * randomized 10-60 minute slot. Only one snapshot per server is kept - a new one
 * replaces the previous, so unchanged guilds cost zero storage and storage stays flat.
 */
const cron: Cron = {
    name: "Security Backups",
    frequency: "*/10 * * * *",
    bootRun: true,
    run: async (api, db) => {
        if (running) return;
        running = true;
        try {
            const [autoGuilds, nukeGuilds] = await Promise.all([
                db.getSecurityGuilds("backups"),
                db.getSecurityGuilds("anti_nuke"),
            ]);
            const seen = new Set<string>();
            const guilds = [...autoGuilds, ...nukeGuilds].filter((c) => {
                if (seen.has(c.guild_id)) return false;
                seen.add(c.guild_id);
                return true;
            });
            if (guilds.length === 0) return;

            const now = Date.now();
            for (const cfg of guilds) {
                const due = nextDue.get(cfg.guild_id) ?? 0;
                if (now < due) continue;
                // spread guilds over 10-60 minutes so no tick snapshots every server at once
                nextDue.set(cfg.guild_id, now + SLOT_MIN_MS + Math.floor(Math.random() * (SLOT_MAX_MS - SLOT_MIN_MS)));
                try {
                    const result = await createBackup(api, db, cfg.guild_id, "auto");
                    if (result) console.log(styleText("dim", `[backup] ${cfg.guild_id}: #${result.id} (${result.channels}ch/${result.roles}roles)`));
                } catch (err) {
                    console.error(`[backup] failed for ${cfg.guild_id}: ${err}`);
                }
                await Bun.sleep(200); // stay gentle on the rate limit
            }
        } finally {
            running = false;
        }
    },
};

export default cron;
