import { ActivityType, GatewayOpcodes, PresenceUpdateStatus, type GatewayPresenceUpdateData } from "discord-api-types/v10";
import type { WebSocketManager } from "@discordjs/ws";
import { getStats, getTotalHoneypotChannels } from "./db";

// Rotating bot activities, e.g. "Watching 12 servers".
// Discord rate-limits presence updates, so we rotate slowly (every 10 min).

function buildPresences(servers: number, bans: number, channels: number): GatewayPresenceUpdateData[] {
    const s = servers.toLocaleString("en-US");
    const b = bans.toLocaleString("en-US");
    const c = channels.toLocaleString("en-US");
    const online = (activities: GatewayPresenceUpdateData["activities"]): GatewayPresenceUpdateData => ({
        since: null,
        activities,
        status: PresenceUpdateStatus.Online,
        afk: false,
    });
    return [
        online([{ name: "#honeypot", state: "Watching #honeypot for bots", type: ActivityType.Custom }]),
        online([{ name: `${s} servers`, type: ActivityType.Watching }]),
        online([{ name: "honeypot", state: `Caught ${b} spam bots`, type: ActivityType.Custom }]),
        online([{ name: `${c} honeypots`, type: ActivityType.Watching }]),
        online([{ name: "for spam 24/7", type: ActivityType.Watching }]),
        online([{ name: "honeypot", state: `Protecting ${s} servers`, type: ActivityType.Custom }]),
    ];
}

let idx = 0;
let started = false;

async function tick(gateway: WebSocketManager): Promise<void> {
    try {
        const [{ totalGuilds, totalModerated }, totalChannels] = await Promise.all([
            getStats().catch(() => ({ totalGuilds: 0, totalModerated: 0 })),
            getTotalHoneypotChannels().catch(() => 0),
        ]);
        const list = buildPresences(totalGuilds, totalModerated, totalChannels);
        const presence = list[idx % list.length]!;
        idx++;
        const shards = await gateway.getShardIds().catch(() => [] as number[]);
        for (const id of shards) {
            await gateway.send(id, { op: GatewayOpcodes.PresenceUpdate, d: presence }).catch(() => null);
        }
    } catch {
        // presence is cosmetic, never crash the bot over it
    }
}

export function startPresenceRotation(gateway: WebSocketManager): void {
    if (started) return;
    started = true;
    setTimeout(() => void tick(gateway), 60_000);
    setInterval(() => void tick(gateway), 10 * 60_000);
}
