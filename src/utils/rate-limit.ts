// In-memory token-bucket rate limiter.
// Discord's own 429 handling in @discordjs/rest stays the backstop;
// this smooths bursts *before* they hit the API.

export class TokenBucket {
    private tokens: number;
    private lastRefill: number;

    constructor(private capacity: number, private refillPerSec: number) {
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const add = ((now - this.lastRefill) / 1000) * this.refillPerSec;
        if (add > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + add);
            this.lastRefill = now;
        }
    }

    async take(count = 1): Promise<void> {
        while (true) {
            this.refill();
            if (this.tokens >= count) {
                this.tokens -= count;
                return;
            }
            const need = count - this.tokens;
            const waitMs = Math.ceil((need / this.refillPerSec) * 1000);
            await Bun.sleep(Math.min(Math.max(waitMs, 10), 30_000));
        }
    }

    get available(): number {
        this.refill();
        return this.tokens;
    }
}

// Shared bucket for moderation write calls (ban/unban/timeout).
// Burst of 5 for isolated incidents, then ~1 action/sec sustained in raids.
export const moderationBucket = new TokenBucket(5, 1);

// Restore re-posts (webhook messages): burst of 5, then ~2 per second. Smooths the
// message phase so it does not slam into the per-webhook / per-channel rate limits
// (Discord's own 429 queueing in @discordjs/rest stays the backstop).
export const restoreMessageBucket = new TokenBucket(5, 2);
