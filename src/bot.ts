import { Client } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { GatewayIntentBits, GatewayDispatchEvents, type RESTGetAPIGatewayBotResult, Routes } from "discord-api-types/v10";
import * as db from "./utils/db";
import eventHandlers from "./events/events";
import { commandsPayload } from "./utils/commands";
import { runCrons } from "./cron/crons";
import initialPresence from "./utils/initial-presence";
import { setCommandIdCache } from "./utils/cache";
import { startStatsServer } from "./stats-server";
import { startPresenceRotation } from "./utils/presence";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN environment variable not set.");
let applicationId = atob(token.split(".")[0]!); // i bet most didn’t know this fact about discord tokens

process.title = "Honeypot Bot";

await db.initDb();
const redis = process.env.REDIS_URL ? new Bun.RedisClient(process.env.REDIS_URL) : null;

process.on('uncaughtException', (err) => {
    console.error(`[uncaughtException]`, err instanceof Error ? err.stack || err.message : err);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    // ETIMEOUT / getaddrinfo are transient network blips (mchost DNS) — log without crashing, gateway will reconnect
    if (msg.includes('ETIMEOUT') || msg.includes('getaddrinfo') || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
        console.warn(`[transient network] ${msg.split('\n')[0]}`);
        return;
    }
    console.error(`[unhandledRejection]`, msg);
});

const rest = new REST({ version: "10", retries: 3 }).setToken(token);
async function fetchGatewayWithRetry(): Promise<RESTGetAPIGatewayBotResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await rest.get(Routes.gatewayBot()) as RESTGetAPIGatewayBotResult;
        } catch (e: any) {
            lastErr = e;
            const msg = e?.message || String(e);
            const transient = msg.includes('ETIMEOUT') || msg.includes('getaddrinfo') || msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || e?.code === 'UND_ERR_CONNECT_TIMEOUT';
            if (!transient || attempt === 3) throw e;
            const delay = 2000 * Math.pow(2, attempt); // 2s,4s,8s
            console.warn(`[gateway] fetch failed (attempt ${attempt+1}/4): ${msg.split('\n')[0]} — retry in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
const gateway = new WebSocketManager({
    token,
    intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.GuildMembers,
    fetchGatewayInformation: fetchGatewayWithRetry,
    shardCount: null,
    initialPresence,
});
// @ts-ignore — ws manager emits debug/error via event emitter in some versions
if (typeof (gateway as any).on === 'function') {
    (gateway as any).on('error', (e: any) => console.error('[gateway error]', e?.message || e));
    (gateway as any).on('debug', (msg: string) => { if (msg.includes('ETIMEOUT') || msg.includes('getaddrinfo')) console.warn('[gateway debug]', msg); });
}

const client = new Client({ rest, gateway });

for (const event of eventHandlers) {
    client.on(event.event, async (data: any) => {
        try {
            // @ts-expect-error - types are weird
            await event.handler({ data: data.data, api: data.api, applicationId, redis, db });
        } catch (err) {
            console.error(`Error handling event ${event.event}:`, err);
        }
    });
}

client.on(GatewayDispatchEvents.Ready, (c) => {
    console.info(`[Shard ${c.shardId}] ${c.data.user.username}#${c.data.user.discriminator} is ready!`);
    applicationId = c.data.user.id;

    c.api.applicationCommands.bulkOverwriteGlobalCommands(applicationId, commandsPayload).then((cmds) => {
        const commandIdMap = cmds.reduce((acc, cmd) => { acc[cmd.name] = cmd.id; return acc; }, {} as Record<string, string>);
        setCommandIdCache(commandIdMap, redis);
    }).catch((e: any) => console.error('[commands] bulk overwrite failed:', e?.message || e));
});

gateway.connect();
startStatsServer(client.api);
startPresenceRotation(gateway);
void import("./utils/premium-manager").then((m) => m.autostartPremiumBots());

runCrons(client.api, db, redis || undefined);
