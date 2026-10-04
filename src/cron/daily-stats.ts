import type { Cron } from "./crons";
import { styleText } from "node:util";

// Runs once a day: stores a stats snapshot (90-day growth chart) and purges
// expired shared-banlist entries.
const cron: Cron = {
    name: "Daily Stats Snapshot",
    frequency: "15 0 * * *",
    run: async (_api, db) => {
        try {
            await db.saveDailySnapshot();
        } catch (err) {
            console.log(`Daily snapshot failed: ${err}`);
        }
        try {
            await db.purgeSharedBanlist();
        } catch (err) {
            console.log(styleText("dim", `Shared banlist purge failed: ${err}`));
        }
        try {
            await db.purgeFingerprints();
        } catch (err) {
            console.log(styleText("dim", `Fingerprint purge failed: ${err}`));
        }
        try {
            const purged = await db.purgeLeftGuilds();
            if (purged > 0) console.log(`[purge] deleted data of ${purged} guild(s) left over ${db.LEFT_GRACE_DAYS} days ago`);
        } catch (err) {
            console.log(`Left-guild purge failed: ${err}`);
        }
        try {
            const n = await db.purgeExpiredPremium();
            if (n > 0) console.log(`[premium] purged ${n} expired account(s)`);
        } catch (err) {
            console.log(styleText("dim", `Premium purge failed: ${err}`));
        }
    },
};

export default cron;
