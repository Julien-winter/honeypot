import type { Cron } from "./crons";
import { styleText } from "node:util";
import { createBackup } from "../security/backup";

const BACKUP_MIN_AGE_SEC = 9 * 60;
let running = false;

/** Snapshot the structure of every guild with the backups module enabled (every 10 minutes). */
const cron: Cron = {
    name: "Security Backups",
    frequency: "*/10 * * * *",
    run: async (api, db) => {
        if (running) return;
        running = true;
        try {
            const guilds = await db.getSecurityGuilds("backups");
            if (guilds.length === 0) return;

            const now = Math.floor(Date.now() / 1000);
            for (const cfg of guilds) {
                try {
                    const latest = await db.getLatestSecurityBackup(cfg.guild_id);
                    if (latest && now - latest.created_at < BACKUP_MIN_AGE_SEC) continue;
                    const result = await createBackup(api, db, cfg.guild_id, "auto (every 10 min)");
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
