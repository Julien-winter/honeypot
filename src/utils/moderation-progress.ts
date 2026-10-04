import type { API } from "@discordjs/core";
import type { API as API2 } from "@discordjs/core/http-only";

// Moderation queue + raid progress tracker (in-memory, works without Redis).
// - Deduplicates concurrent triggers for the same user (single process).
// - Smooths ban waves: from 3+ simultaneous moderations per guild it posts a
//   live progress message in the log channel and a final summary afterwards.
// - Under the threshold everything stays silent, exactly like before.

type Wave = {
    total: number;
    done: number;
    failed: number;
    bans: number;
    softbans: number;
    msgId: string | null;
    lastEdit: number;
};

const active = new Set<string>(); // `${guildId}:${userId}` currently being moderated
const waves = new Map<string, Wave>();

export const PROGRESS_THRESHOLD = 3;
const EDIT_THROTTLE_MS = 5_000;

function activeCount(guildId: string): number {
    let n = 0;
    for (const key of active) {
        if (key.startsWith(`${guildId}:`)) n++;
    }
    return n;
}

/** Returns false if this user is already being moderated (duplicate trigger). */
export function tryStartModeration(guildId: string, userId: string): boolean {
    const key = `${guildId}:${userId}`;
    if (active.has(key)) return false;
    active.add(key);
    const wave = waves.get(guildId) ?? { total: 0, done: 0, failed: 0, bans: 0, softbans: 0, msgId: null, lastEdit: 0 };
    wave.total++;
    waves.set(guildId, wave);
    return true;
}

export async function reportProgress(api: API | API2, guildId: string, logChannelId: string | null): Promise<void> {
    const wave = waves.get(guildId);
    if (!wave || !logChannelId || wave.total < PROGRESS_THRESHOLD) return;
    const now = Date.now();
    const text = `🔨 **Honeypot raid defense:** moderating ${wave.total} users… (${wave.done}/${wave.total} done)`;
    try {
        if (!wave.msgId) {
            const msg = await api.channels.createMessage(logChannelId, { content: text, allowed_mentions: {} });
            wave.msgId = msg.id;
            wave.lastEdit = now;
        } else if (now - wave.lastEdit >= EDIT_THROTTLE_MS && activeCount(guildId) > 0) {
            await api.channels.editMessage(logChannelId, wave.msgId, { content: text, allowed_mentions: {} }).catch(() => null);
            wave.lastEdit = now;
        }
    } catch {
        // progress is cosmetic, never break moderation over it
    }
}

export type ModerationResult = { action: "ban" | "softban"; failed: boolean } | null;

export async function endModeration(
    api: API | API2,
    guildId: string,
    userId: string,
    logChannelId: string | null,
    result: ModerationResult,
): Promise<void> {
    active.delete(`${guildId}:${userId}`);
    const wave = waves.get(guildId);
    if (!wave) return;
    wave.done++;
    if (result) {
        if (result.failed) wave.failed++;
        else if (result.action === "ban") wave.bans++;
        else wave.softbans++;
    }
    if (activeCount(guildId) > 0) {
        await reportProgress(api, guildId, logChannelId);
        return;
    }
    try {
        if (wave.msgId && logChannelId && wave.total >= PROGRESS_THRESHOLD) {
            const summary = wave.failed > 0
                ? `✅ **Raid defense done:** ${wave.done} users moderated (${wave.bans} bans, ${wave.softbans} softbans, ${wave.failed} failed).`
                : `✅ **Raid defense done:** ${wave.done} users moderated (${wave.bans} bans, ${wave.softbans} softbans).`;
            await api.channels.editMessage(logChannelId, wave.msgId, { content: summary, allowed_mentions: {} }).catch(() => null);
        }
    } catch {
        // ignore
    }
    waves.delete(guildId);
}
