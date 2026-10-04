import type { SecurityConfig, SecurityModule } from "../utils/db";

export type DbModule = typeof import("../utils/db");

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: SecurityConfig | null; expires: number }>();

/** Security config with a short-lived in-process cache (it is read on every message of anti-spam guilds). */
export async function getSecurityConfigCached(db: DbModule, guildId: string): Promise<SecurityConfig | null> {
  const now = Date.now();
  const hit = cache.get(guildId);
  if (hit && hit.expires > now) return hit.value;

  let value: SecurityConfig | null = null;
  try {
    value = await db.getSecurityConfig(guildId);
  } catch (err) {
    console.error(`Error reading security config for ${guildId}: ${err}`);
  }
  cache.set(guildId, { value, expires: now + CACHE_TTL_MS });
  return value;
}

/** Write config straight into the cache (used right after a save so the change applies instantly). */
export function primeSecurityConfig(config: SecurityConfig) {
  cache.set(config.guild_id, { value: config, expires: Date.now() + CACHE_TTL_MS });
}

export function invalidateSecurityConfig(guildId: string) {
  cache.delete(guildId);
}

export const messageModulesEnabled = (cfg: SecurityConfig | null | undefined): boolean =>
  !!cfg && (cfg.anti_spam || cfg.anti_phishing);

/**
 * The sharded gateway (`discord-ws`) drops messages outside the "subscribed" honeypot channels
 * once a restriction was written. Guilds with anti-spam / anti-phishing need to see every message,
 * so remove that restriction and keep it removed (other replicas may re-write it while their
 * cached config is up to CACHE_TTL_MS old).
 */
export function keepMessagesUnrestricted(guildId: string, redis?: Bun.RedisClient | null) {
  if (!redis) return;
  const del = () => Promise.resolve(redis.hdel("discord_ws_config:guild-channels", guildId)).catch(() => { });
  del();
  for (const delay of [15_000, 45_000]) setTimeout(del, delay);
}

const ensuredUnrestricted = new Set<string>();
/** Cheap per-process guard so we only delete the restriction once per guild. */
export function ensureMessagesUnrestricted(guildId: string, redis?: Bun.RedisClient | null) {
  if (!redis || ensuredUnrestricted.has(guildId)) return;
  ensuredUnrestricted.add(guildId);
  keepMessagesUnrestricted(guildId, redis);
}

export function isModuleEnabled(cfg: SecurityConfig, module: SecurityModule): boolean {
  return cfg[module];
}

export const SECURITY_MODULES: SecurityModule[] = ['anti_nuke', 'quarantine', 'anti_spam', 'anti_phishing', 'event_log', 'backups'];

/** Modules that only the owner / an administrator may switch off (mirrors Protector's "protected modules"). */
export const CRITICAL_MODULES: SecurityModule[] = ['anti_nuke', 'quarantine', 'anti_spam'];
