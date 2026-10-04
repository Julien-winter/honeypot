/**
 * Live message ringbuffer for restores.
 *
 * Snapshots only capture what is in Discord at capture time - messages typed AFTER the
 * last snapshot would be gone once the channel is deleted. This buffer keeps the most
 * recent messages per channel in memory (fired from the MESSAGE_CREATE / MESSAGE_DELETE
 * gateway events) so both the next snapshot and a restore right now can include them.
 *
 * It intentionally survives channel deletion (that is exactly when it is needed) and is
 * evicted per channel once a message is deleted, per buffer once the limits are hit.
 */

export type BufferedMessage = {
    id: string;
    c: string; // content
    a: string; // author display name
    av: string | null; // author avatar url
};

const MAX_PER_CHANNEL = 50;
const MAX_CHANNELS = 15_000;

/** channel id -> oldest first (insertion order doubles as LRU order across channels). */
const buffers = new Map<string, BufferedMessage[]>();

export function noteMessage(channelId: string, m: BufferedMessage): void {
    if (!channelId || !m.id || !m.c) return;
    const list = buffers.get(channelId);
    if (list) {
        if (list.some(x => x.id === m.id)) return;
        list.push(m);
        if (list.length > MAX_PER_CHANNEL) list.splice(0, list.length - MAX_PER_CHANNEL);
        buffers.delete(channelId);
        buffers.set(channelId, list);
    } else {
        buffers.set(channelId, [m]);
    }
    while (buffers.size > MAX_CHANNELS) {
        const oldest = buffers.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        buffers.delete(oldest);
    }
}

export function dropMessage(channelId: string, messageId: string): void {
    const list = buffers.get(channelId);
    if (!list) return;
    const i = list.findIndex(x => x.id === messageId);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) buffers.delete(channelId);
}

export function dropMessages(channelId: string, messageIds: readonly string[]): void {
    for (const id of messageIds) dropMessage(channelId, id);
}

export function getBuffered(channelId: string): BufferedMessage[] {
    return buffers.get(channelId)?.slice() ?? [];
}
