import type { Cron } from "./crons";
import { styleText } from "node:util";
import { createBackup } from "../security/backup";

let running = false;

/**
 * Snapshot the structure of every guild with Auto-Backups OR Anti-Nuke enabled
 * (anti-nuke needs restore points without any manual step).
 * Runs every 10 minutes, but a new row is only stored when the structure actually
 * changed - unchanged guilds cost zero storage.
 */
const cron: Cron = {
    name: "Security Backups",
    frequency: "*/10 * * * *",
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

            for (const cfg of guilds) {
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
