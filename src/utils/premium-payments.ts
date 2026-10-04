import * as db from "./db";

const LTC_ADDRESS = process.env.DONATE_LTC || "ltc1qxkgsyff2umvhjw4j2wh0thj3fzvffr69zg5kf6";
const PRICE_EUR = 2; // premium price
const CONFIRMATIONS_REQUIRED = 2;

// in-memory rate limits: userId -> timestamps
const rlUser = new Map<string, number[]>();
const rlIp = new Map<string, number[]>();
const USED_TX_CACHE = new Set<string>();

function isRateLimited(map: Map<string, number[]>, key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
        map.set(key, arr);
        return true;
    }
    arr.push(now);
    map.set(key, arr);
    if (map.size > 5000) {
        for (const [k, v] of map) if (v.length === 0 || now - v[v.length - 1]! > windowMs) map.delete(k);
    }
    return false;
}

let priceCache: { price: number; at: number } | null = null;
async function getLtcPriceEur(): Promise<number> {
    const now = Date.now();
    if (priceCache && now - priceCache.at < 5 * 60_000) return priceCache.price;
    try {
        const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur", { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`coingecko ${res.status}`);
        const j = await res.json() as { litecoin?: { eur?: number } };
        const price = Number(j?.litecoin?.eur);
        if (!Number.isFinite(price) || price <= 0) throw new Error("bad price");
        priceCache = { price, at: now };
        return price;
    } catch (err) {
        console.error(`[premium-pay] price fetch failed: ${err}`);
        if (priceCache) return priceCache.price;
        throw new Error("price unavailable, try again later");
    }
}

type VerifyResult = { ok: true; ltcAmount: number; eurAmount: number; confirmations: number } | { ok: false; error: string };

export async function verifyLtcTxid(txid: string, userId: string, ip: string): Promise<VerifyResult> {
    const clean = txid.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) return { ok: false, error: "invalid txid format (64 hex chars)" };
    if (USED_TX_CACHE.has(clean)) return { ok: false, error: "txid already used" };
    if (await db.hasUsedTxid(clean)) return { ok: false, error: "txid already used" };
    if (isRateLimited(rlUser, userId, 5, 60_000)) return { ok: false, error: "rate limited, try again in a minute" };
    if (isRateLimited(rlIp, ip, 10, 60_000)) return { ok: false, error: "rate limited (ip), try again in a minute" };

    let price: number;
    try { price = await getLtcPriceEur(); } catch (e: any) { return { ok: false, error: e?.message || "price unavailable" }; }
    const requiredLtc = PRICE_EUR / price;

    // fetch tx from Blockchair
    let data: any;
    try {
        const res = await fetch(`https://api.blockchair.com/litecoin/dashboards/transaction/${clean}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            if (res.status === 404) return { ok: false, error: "transaction not found" };
            return { ok: false, error: `blockchair ${res.status}` };
        }
        const j = await res.json() as any;
        data = j?.data?.[clean];
        if (!data) return { ok: false, error: "transaction not found" };
    } catch (err) {
        console.error(`[premium-pay] blockchair failed: ${err}`);
        return { ok: false, error: "verification service unavailable, try again" };
    }

    const tx = data.transaction;
    const outs: { recipient?: string; value?: number }[] = data.outputs || [];
    const confirmations = Number(tx?.confirmations ?? 0);
    if (!Number.isFinite(confirmations) || confirmations < CONFIRMATIONS_REQUIRED) {
        return { ok: false, error: `need ${CONFIRMATIONS_REQUIRED} confirmations, got ${confirmations}` };
    }

    // find output to our address
    let paidLtc = 0;
    for (const o of outs) {
        if (typeof o.recipient === "string" && o.recipient.toLowerCase() === LTC_ADDRESS.toLowerCase() && typeof o.value === "number") {
            paidLtc += o.value / 1e8; // satoshis to LTC
        }
    }
    if (paidLtc <= 0) return { ok: false, error: "no output to our address found" };

    // allow 2% tolerance for fees/price movement + require at least required - 1 cent
    const minLtc = requiredLtc * 0.98;
    if (paidLtc + 1e-8 < minLtc) {
        return { ok: false, error: `paid ${paidLtc.toFixed(8)} LTC, need ~${requiredLtc.toFixed(8)} LTC (2€)` };
    }

    const eurAmount = paidLtc * price;

    // record to prevent reuse (optimistic)
    USED_TX_CACHE.add(clean);
    await db.recordPremiumPayment(clean, userId, paidLtc, eurAmount, confirmations).catch(() => null);

    return { ok: true, ltcAmount: paidLtc, eurAmount, confirmations };
}

export function ltcPriceInfo(): { address: string; priceEur: string; requiredLtc: string } | null {
    if (!priceCache) return null;
    const required = PRICE_EUR / priceCache.price;
    return { address: LTC_ADDRESS, priceEur: priceCache.price.toFixed(2), requiredLtc: required.toFixed(8) };
}
