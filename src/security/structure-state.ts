/**
 * Shared, cycle-free tracking of recent structure deletions.
 * Used by the anti-nuke handler, the auto-backup cron and the restore runner to
 * answer one question: "was structure ripped out of this guild recently?"
 *
 * Auto-snapshots must NOT run while that is true - they would replace the last
 * good restore point with the damaged state (channels gone, messages unreadable),
 * and with a single kept snapshot per server that loss is permanent.
 * No imports here on purpose: anti-nuke, restore-run and cron all depend on it.
 */

/** How long a deletion keeps auto-snapshots paused (covers request + restore + verify rounds). */
const STRUCTURE_GRACE_MS = 10 * 60_000;

const lastDeletion = new Map<string, number>();

/** Called for every channel/role deletion the bot observes. */
export function noteStructureDeletion(guildId: string): void {
    lastDeletion.set(guildId, Date.now());
    if (lastDeletion.size > 10_000) {
        const cutoff = Date.now() - STRUCTURE_GRACE_MS;
        for (const [id, at] of lastDeletion) if (at < cutoff) lastDeletion.delete(id);
    }
}

/** True while structure was deleted within the grace window (snapshotting now is unsafe). */
export function hasRecentStructureDeletion(guildId: string): boolean {
    const at = lastDeletion.get(guildId) ?? 0;
    return Date.now() - at < STRUCTURE_GRACE_MS;
}
