import type { Cron } from "./crons";
import { styleText } from "node:util";

// Runs once at startup: fills in missing guild names/icons (used by the
// public leaderboard + dashboard) and refreshes stale ones.
const cron: Cron = {
    name: "Backfill Guild Names",
    frequency: "once",
    run: async (api, db) => {
        const configs = await db.getAllGuildConfigs().catch(() => []);
        if (configs.length === 0) {
            console.log(`[backfill] no guilds, nothing to do`);
            return;
        }
        let filled = 0;
        let checked = 0;
        for (const config of configs.slice(0, 50)) {
            checked++;
            try {
                const guild = await api.guilds.get(config.guild_id) as { name?: string; icon?: string | null };
                const full = await db.getConfig(config.guild_id).catch(() => null);
                if (!full) continue;
                const name = guild?.name ?? null;
                const icon = guild?.icon ?? null;
                if ((name && name !== full.name) || (icon !== undefined && icon !== full.icon)) {
                    await db.setConfig({ ...full, name: name ?? full.name, icon: icon ?? full.icon });
                    filled++;
                }
                await Bun.sleep(500);
            } catch (err) {
                console.log(styleText("dim", `Name backfill failed for ${config.guild_id}: ${err}`));
            }
        }
        console.log(`[backfill] checked ${checked} guild(s), updated ${filled}`);
    },
};

export default cron;
