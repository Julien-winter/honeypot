import { SQL } from "bun";

export type HoneypotConfig = {
  guild_id: string;
  name: string | null;
  icon: string | null;
  log_channel_id: string | null;
  action: 'softban' | 'ban' | 'disabled';
  experiments: (
    "no-warning-msg" |
    "no-dm" |
    "random-channel-name" |
    "random-channel-name-chaos" |
    "channel-warmer" |
    "recreate-channel" |
    "forward-message" |
    "reinvite" |
    "timeout-first" |
    "only-recent-delete" |
    "many-honeypots" |
    "ensure-msg-delete" |
    "alt-detection" |
    "shared-banlist" |
    "no-link-filter" |
    "leaderboard"
  )[]
};

export type HoneypotChannel = {
  guild_id: string;
  channel_id: string;
  msg_id: string | null;
};

export type ConfigWithChannels = {
  config: HoneypotConfig;
  channels: HoneypotChannel[];
};

export type SecurityModule = 'anti_nuke' | 'quarantine' | 'anti_spam' | 'anti_phishing' | 'event_log' | 'backups';

export type SecurityConfig = {
  guild_id: string;
  anti_nuke: boolean;
  quarantine: boolean;
  anti_spam: boolean;
  anti_phishing: boolean;
  event_log: boolean;
  backups: boolean;
  event_log_channel_id: string | null;
  spam_threshold: number;
  spam_window_sec: number;
  mention_threshold: number;
  anti_nuke_action: 'strip' | 'strip_ban' | 'alert';
};

export type SecurityEventType = 'anti_nuke' | 'quarantine' | 'spam' | 'phishing' | 'backup' | 'restore';

export type SecurityBackupRow = {
  id: number;
  guild_id: string;
  created_at: number;
  reason: string | null;
  meta: { channels: number; roles: number } | null;
  data: string;
};

export type QuarantineRow = {
  guild_id: string;
  bot_user_id: string;
  added_by: string | null;
  roles: string[];
  created_at: number;
  approved_by: string | null;
  approved_at: number | null;
};

export const db = new SQL(process.env.DATABASE_URL || "sqlite://honeypot.sqlite", {
  readonly: process.env.DATABASE_READONLY === "1" ? true : undefined,
});

interface Migration {
  version: number;
  name: string;
  up: (tx: SQL) => Promise<void>;
}

const autoincrementSyntax = db.options.adapter === "sqlite" ? db`AUTOINCREMENT` : db.options.adapter === "postgres" ? db`GENERATED ALWAYS AS IDENTITY` : db`AUTO_INCREMENT`

const migrations: Migration[] = [
  {
    version: 3,
    name: "initial",
    up: async (tx) => {
      await tx`
CREATE TABLE IF NOT EXISTS honeypot_config (
  guild_id BIGINT PRIMARY KEY,
  log_channel_id BIGINT,
  action TEXT NOT NULL DEFAULT 'softban',
  experiments VARCHAR(255) DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS honeypot_channels (
  channel_id BIGINT PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  msg_id BIGINT,
  FOREIGN KEY (guild_id) REFERENCES honeypot_config(guild_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS honeypot_events (
  id INTEGER PRIMARY KEY ${autoincrementSyntax},
  guild_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  channel_id BIGINT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, -- (unix number in later migrations)
  FOREIGN KEY (guild_id) REFERENCES honeypot_config(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES honeypot_channels(channel_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS honeypot_messages (
  guild_id BIGINT PRIMARY KEY,
  warning_message TEXT,
  dm_message TEXT,
  log_message TEXT,
  FOREIGN KEY (guild_id) REFERENCES honeypot_config(guild_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS honeypot_reinvite (
  guild_id BIGINT PRIMARY KEY,
  invite TEXT,
  FOREIGN KEY (guild_id) REFERENCES honeypot_config(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_honeypot_channels_guild_id ON honeypot_channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_honeypot_events_user_id ON honeypot_events(user_id);
CREATE INDEX IF NOT EXISTS idx_honeypot_events_channel_id ON honeypot_events(guild_id, channel_id);
CREATE INDEX IF NOT EXISTS idx_honeypot_events_stats ON honeypot_events(timestamp, guild_id);
`;
    },
  },
  {
    version: 4,
    name: "unix timestamps",
    up: async (tx) => {
      await tx`DROP INDEX IF EXISTS idx_honeypot_events_stats`;
      if (db.options.adapter === "sqlite") {
        await tx`ALTER TABLE honeypot_events ADD COLUMN timestamp_new BIGINT DEFAULT 0`;
        await tx`UPDATE honeypot_events SET timestamp_new = CAST(strftime('%s', timestamp) AS BIGINT)`;
        await tx`ALTER TABLE honeypot_events DROP COLUMN timestamp`;
        await tx`ALTER TABLE honeypot_events RENAME COLUMN timestamp_new TO timestamp`;
      } else if (db.options.adapter === "postgres") {
        await tx`ALTER TABLE honeypot_events ALTER COLUMN timestamp TYPE BIGINT USING (EXTRACT(EPOCH FROM timestamp))::bigint`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`ALTER TABLE honeypot_events ADD COLUMN timestamp_new BIGINT DEFAULT 0`;
        await tx`UPDATE honeypot_events SET timestamp_new = UNIX_TIMESTAMP(timestamp)`;
        await tx`ALTER TABLE honeypot_events DROP COLUMN timestamp`;
        await tx`ALTER TABLE honeypot_events CHANGE COLUMN timestamp_new timestamp BIGINT DEFAULT (UNIX_TIMESTAMP())`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_honeypot_events_global_timeline ON honeypot_events(timestamp, guild_id)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_honeypot_events_guild_stats ON honeypot_events(guild_id, timestamp)`;
    }
  },
  {
    version: 5,
    name: "moderation details",
    up: async (tx) => {
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`ALTER TABLE honeypot_events ADD COLUMN action TEXT DEFAULT 'softban'`;
        await tx`ALTER TABLE honeypot_events ADD COLUMN reason TEXT`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`ALTER TABLE honeypot_events ADD COLUMN action VARCHAR(20) DEFAULT 'softban'`;
        await tx`ALTER TABLE honeypot_events ADD COLUMN reason TEXT`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_honeypot_events_guild_action ON honeypot_events(guild_id, action)`;
    }
  },
  {
    version: 6,
    name: "shared banlist",
    up: async (tx) => {
      // Opt-in network: participating guilds share hashed spammer IDs (90d expiry).
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`CREATE TABLE IF NOT EXISTS shared_banlist (
          user_hash TEXT PRIMARY KEY,
          action TEXT DEFAULT 'softban',
          created_at BIGINT DEFAULT 0,
          expires_at BIGINT DEFAULT 0
        )`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`CREATE TABLE IF NOT EXISTS shared_banlist (
          user_hash VARCHAR(64) PRIMARY KEY,
          action VARCHAR(20) DEFAULT 'softban',
          created_at BIGINT DEFAULT 0,
          expires_at BIGINT DEFAULT 0
        )`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_shared_banlist_expires ON shared_banlist(expires_at)`;
    }
  },
  {
    version: 7,
    name: "guild names",
    up: async (tx) => {
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN name TEXT`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN name VARCHAR(100)`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
    }
  },
  {
    version: 8,
    name: "stats snapshots",
    up: async (tx) => {      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`CREATE TABLE IF NOT EXISTS stats_snapshots (
          day TEXT PRIMARY KEY,
          guilds INTEGER DEFAULT 0,
          moderations INTEGER DEFAULT 0
        )`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`CREATE TABLE IF NOT EXISTS stats_snapshots (
          day VARCHAR(10) PRIMARY KEY,
          guilds INTEGER DEFAULT 0,
          moderations INTEGER DEFAULT 0
        )`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
    }
  },
  {
    version: 9,
    name: "evasion fingerprints",
    up: async (tx) => {      // Fingerprints of moderated accounts for ban-evasion detection.
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`CREATE TABLE IF NOT EXISTS evasion_fingerprints (
          user_id TEXT PRIMARY KEY,
          username TEXT,
          global_name TEXT,
          avatar TEXT,
          last_seen BIGINT DEFAULT 0
        )`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`CREATE TABLE IF NOT EXISTS evasion_fingerprints (
          user_id VARCHAR(20) PRIMARY KEY,
          username VARCHAR(64),
          global_name VARCHAR(64),
          avatar VARCHAR(64),
          last_seen BIGINT DEFAULT 0
        )`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_evasion_lookup ON evasion_fingerprints(avatar, username)`;
    }
  },
  {
    version: 10,
    name: "guild icons",
    up: async (tx) => {
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN icon TEXT`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN icon VARCHAR(64)`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
    }
  },
  {
    version: 11,
    name: "graceful leave",
    up: async (tx) => {
      // Kicked guilds are only marked (left_at); a cron purges them after 3 days.
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN left_at BIGINT DEFAULT 0`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`ALTER TABLE honeypot_config ADD COLUMN left_at BIGINT DEFAULT 0`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_honeypot_config_left ON honeypot_config(left_at)`;
    }
  },
  {
    version: 12,
    name: "premium users",
    up: async (tx) => {
      // Each paying customer gets their own bot instance.
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`CREATE TABLE IF NOT EXISTS premium_users (
          user_id TEXT PRIMARY KEY,
          username TEXT,
          discord_token TEXT,
          client_secret TEXT,
          public_url TEXT,
          donate_ltc TEXT,
          status TEXT DEFAULT 'pending',
          plan TEXT DEFAULT 'premium',
          expires_at BIGINT DEFAULT 0,
          created_at BIGINT DEFAULT 0,
          runs INTEGER DEFAULT 0
        )`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`CREATE TABLE IF NOT EXISTS premium_users (
          user_id VARCHAR(20) PRIMARY KEY,
          username VARCHAR(32),
          discord_token VARCHAR(100),
          client_secret VARCHAR(64),
          public_url VARCHAR(128),
          donate_ltc VARCHAR(64),
          status VARCHAR(16) DEFAULT 'pending',
          plan VARCHAR(16) DEFAULT 'premium',
          expires_at BIGINT DEFAULT 0,
          created_at BIGINT DEFAULT 0,
          runs INTEGER DEFAULT 0
        )`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_premium_expires ON premium_users(expires_at)`;
      await tx`CREATE INDEX IF NOT EXISTS idx_premium_status ON premium_users(status)`;
    }
  },
  {
    version: 13,
    name: "premium payments",
    up: async (tx) => {
      if (db.options.adapter === "sqlite" || db.options.adapter === "postgres") {
        await tx`CREATE TABLE IF NOT EXISTS premium_payments (
          txid TEXT PRIMARY KEY,
          user_id TEXT,
          ltc_amount REAL,
          eur_amount REAL,
          confirmations INTEGER,
          verified_at BIGINT
        )`;
      } else if (db.options.adapter === "mysql" || db.options.adapter === "mariadb") {
        await tx`CREATE TABLE IF NOT EXISTS premium_payments (
          txid VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(20),
          ltc_amount DOUBLE,
          eur_amount DOUBLE,
          confirmations INT,
          verified_at BIGINT
        )`;
      } else {
        throw new Error(`Unsupported database adapter: ${db.options.adapter}`);
      }
      await tx`CREATE INDEX IF NOT EXISTS idx_premium_payments_user ON premium_payments(user_id)`;
    }
  },
  {
    version: 14,
    name: "security modules",
    up: async (tx) => {
      await tx`
CREATE TABLE IF NOT EXISTS security_config (
  guild_id BIGINT PRIMARY KEY,
  anti_nuke INTEGER NOT NULL DEFAULT 0,
  quarantine INTEGER NOT NULL DEFAULT 0,
  anti_spam INTEGER NOT NULL DEFAULT 0,
  anti_phishing INTEGER NOT NULL DEFAULT 0,
  event_log INTEGER NOT NULL DEFAULT 0,
  backups INTEGER NOT NULL DEFAULT 0,
  event_log_channel_id BIGINT,
  spam_threshold INTEGER NOT NULL DEFAULT 5,
  spam_window_sec INTEGER NOT NULL DEFAULT 10,
  mention_threshold INTEGER NOT NULL DEFAULT 5,
  anti_nuke_action TEXT NOT NULL DEFAULT 'strip'
);

CREATE TABLE IF NOT EXISTS security_backups (
  id INTEGER PRIMARY KEY ${autoincrementSyntax},
  guild_id BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  reason TEXT,
  meta TEXT,
  data TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES security_config(guild_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quarantine_bots (
  guild_id BIGINT NOT NULL,
  bot_user_id BIGINT NOT NULL,
  added_by BIGINT,
  roles TEXT DEFAULT '[]',
  created_at BIGINT NOT NULL,
  approved_by BIGINT,
  approved_at BIGINT,
  PRIMARY KEY (guild_id, bot_user_id),
  FOREIGN KEY (guild_id) REFERENCES security_config(guild_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY ${autoincrementSyntax},
  guild_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  user_id BIGINT,
  channel_id BIGINT,
  meta TEXT,
  timestamp BIGINT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES security_config(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_security_backups_guild ON security_backups(guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_stats ON security_events(timestamp, guild_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(type, timestamp);
`;
    }
  }
];
export async function initDb() {
  if (db.options.adapter === "sqlite") {
    try {
      await db`PRAGMA foreign_keys = ON;`;
      await db`PRAGMA journal_mode = WAL;`;
      await db`PRAGMA busy_timeout = 5000;`;
      await db`PRAGMA wal_autocheckpoint = 500;`;
      await db`PRAGMA synchronous = NORMAL;`;
    } catch (err) {
      console.error("Failed to set PRAGMA settings:", err);
    }
  }

  // it'll fail in migrating anyway
  if (process.env.DATABASE_READONLY === "1") return;

  await db`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`;

  const applied: { version: number }[] = await db`SELECT version FROM _migrations ORDER BY version ASC`.catch(() => [])
  const appliedSet = new Set(applied.map(r => Number(r.version)));

  for (const m of migrations) {
    if (appliedSet.has(m.version)) continue;
    try {
      await db.begin(async (tx) => {
        await m.up(tx);
        await tx`INSERT INTO _migrations (version, name) VALUES (${m.version}, ${m.name})`;
      });
      appliedSet.add(m.version);
      if (applied.length > 0) {
        console.log(`[db migrate] ${m.version}: ${m.name} applied`);
      }
    } catch (err) {
      console.error(`[db migrate] ${m.version}: ${m.name} failed:`, err);
      throw err;
    }
  }
  if (appliedSet.size > 0) {
    console.log(`[db] ready at migration v${Math.max(...appliedSet)}`);
  }

  const latestMigration = migrations[migrations.length - 1];
  const latestAppliedMigration = appliedSet.size > 0 ? Math.max(...applied.map(r => Number(r.version))) : null;
  if (appliedSet.size > 0 && latestAppliedMigration! < (latestMigration?.version || 0)) {
    if (db.options.adapter === "sqlite") await db`VACUUM;`.catch(() => { });
    console.log(`[db migrate] All migrations applied successfully`);
  }
}

function parseConfigRow(row: any): HoneypotConfig {
  return {
    guild_id: row.guild_id,
    name: row.name ?? null,
    icon: row.icon ?? null,
    log_channel_id: row.log_channel_id ?? null,
    action: ['softban', 'ban', 'disabled'].includes(row.action) ? row.action : 'softban',
    experiments: JSON.parse(row.experiments || '[]'),
  };
}

export async function getConfig(guild_id: string): Promise<HoneypotConfig | null> {
  const [row] = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, name, icon, CAST(log_channel_id AS VARCHAR(20)) AS log_channel_id, action, experiments FROM honeypot_config WHERE guild_id = ${guild_id}`;
  if (!row) return null;
  return parseConfigRow(row);
}

export async function getChannels(guild_id: string): Promise<Omit<HoneypotChannel, 'guild_id'>[]> {
  const rows = await db`SELECT CAST(channel_id AS VARCHAR(20)) AS channel_id, CAST(msg_id AS VARCHAR(20)) AS msg_id FROM honeypot_channels WHERE guild_id = ${guild_id} ORDER BY channel_id`;
  return rows.map((r: any) => ({ channel_id: r.channel_id.toString(), msg_id: r.msg_id?.toString() ?? null }));
}

export async function getConfigWithChannels(guild_id: string): Promise<ConfigWithChannels | null> {
  const rows = await db`
    SELECT 
      CAST(cfg.guild_id AS VARCHAR(20)) AS guild_id, 
      cfg.name AS name,
      cfg.icon AS icon,
      CAST(cfg.log_channel_id AS VARCHAR(20)) AS log_channel_id, 
      cfg.action, 
      cfg.experiments,
      CAST(ch.channel_id AS VARCHAR(20)) AS ch_channel_id, 
      CAST(ch.msg_id AS VARCHAR(20)) AS ch_msg_id
    FROM honeypot_config cfg
    LEFT JOIN honeypot_channels ch ON ch.guild_id = cfg.guild_id
    WHERE cfg.guild_id = ${guild_id}
  `;
  if (rows.length === 0) return null;
  const config = parseConfigRow(rows[0]);
  const channels: HoneypotChannel[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const ch_channel_id = r.ch_channel_id?.toString() ?? null;
    if (r.ch_channel_id && !seen.has(ch_channel_id)) {
      seen.add(ch_channel_id);
      channels.push({ guild_id, channel_id: ch_channel_id, msg_id: r.ch_msg_id?.toString() ?? null });
    }
  }
  return { config, channels };
}

export async function setConfig(config: HoneypotConfig) {
  await db`
    INSERT INTO honeypot_config (guild_id, name, icon, log_channel_id, action, experiments, left_at)
    VALUES (${config.guild_id}, ${config.name ?? null}, ${config.icon ?? null}, ${config.log_channel_id}, ${config.action}, ${JSON.stringify(config.experiments || [])}, 0)
    ON CONFLICT(guild_id) DO UPDATE SET
      name=excluded.name,
      icon=excluded.icon,
      log_channel_id=excluded.log_channel_id,
      action=excluded.action,
      experiments=excluded.experiments,
      left_at=0
  `;
}

export const LEFT_GRACE_DAYS = 3;

/** Marks a guild as left (data is purged after the grace period). */
export async function markGuildLeft(guild_id: string): Promise<void> {
  await db`UPDATE honeypot_config SET left_at = ${Math.floor(Date.now() / 1000)} WHERE guild_id = ${guild_id}`.catch(() => null);
}

/** Clears the left mark (rejoin during grace period keeps everything). */
export async function clearGuildLeft(guild_id: string): Promise<void> {
  await db`UPDATE honeypot_config SET left_at = 0 WHERE guild_id = ${guild_id} AND COALESCE(left_at, 0) != 0`.catch(() => null);
}

/** Permanently deletes guilds (and their cascading data) left longer than `days` ago. */
export async function purgeLeftGuilds(days: number = LEFT_GRACE_DAYS): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(days * 86400);
  const doomed = await db`SELECT COUNT(*) as count FROM honeypot_config WHERE left_at > 0 AND left_at < ${cutoff}`.catch(() => [{ count: 0 }]);
  await db`DELETE FROM honeypot_config WHERE left_at > 0 AND left_at < ${cutoff}`.catch(() => null);
  return Number((doomed as any[])[0]?.count ?? 0);
}

export async function deleteConfig(guild_id: string) {
  await db`DELETE FROM honeypot_config WHERE guild_id = ${guild_id}`;
}

// ------------------------- security modules -------------------------

function parseSecurityRow(row: any): SecurityConfig {
  return {
    guild_id: row.guild_id.toString(),
    anti_nuke: !!Number(row.anti_nuke),
    quarantine: !!Number(row.quarantine),
    anti_spam: !!Number(row.anti_spam),
    anti_phishing: !!Number(row.anti_phishing),
    event_log: !!Number(row.event_log),
    backups: !!Number(row.backups),
    event_log_channel_id: row.event_log_channel_id != null ? row.event_log_channel_id.toString() : null,
    spam_threshold: Number(row.spam_threshold) || 5,
    spam_window_sec: Number(row.spam_window_sec) || 10,
    mention_threshold: Number(row.mention_threshold) || 5,
    anti_nuke_action: ['strip', 'strip_ban', 'alert'].includes(row.anti_nuke_action) ? row.anti_nuke_action : 'strip',
  };
}

const securitySelectCols = `
  CAST(guild_id AS VARCHAR(20)) AS guild_id,
  anti_nuke, quarantine, anti_spam, anti_phishing, event_log, backups,
  CAST(event_log_channel_id AS VARCHAR(20)) AS event_log_channel_id,
  spam_threshold, spam_window_sec, mention_threshold, anti_nuke_action`;

export async function getSecurityConfig(guild_id: string): Promise<SecurityConfig | null> {
  const [row] = await db`SELECT ${db.unsafe(securitySelectCols)} FROM security_config WHERE guild_id = ${guild_id}`;
  if (!row) return null;
  return parseSecurityRow(row);
}

/** Insert a default row if missing, then return it (safe to call repeatedly). */
export async function ensureSecurityConfig(guild_id: string): Promise<SecurityConfig> {
  const existing = await getSecurityConfig(guild_id);
  if (existing) return existing;
  await db`INSERT INTO security_config (guild_id) VALUES (${guild_id})`;
  return (await getSecurityConfig(guild_id))!;
}

export async function setSecurityConfig(config: SecurityConfig) {
  await db`
    INSERT INTO security_config (guild_id, anti_nuke, quarantine, anti_spam, anti_phishing, event_log, backups, event_log_channel_id, spam_threshold, spam_window_sec, mention_threshold, anti_nuke_action)
    VALUES (${config.guild_id}, ${config.anti_nuke ? 1 : 0}, ${config.quarantine ? 1 : 0}, ${config.anti_spam ? 1 : 0}, ${config.anti_phishing ? 1 : 0}, ${config.event_log ? 1 : 0}, ${config.backups ? 1 : 0}, ${config.event_log_channel_id}, ${config.spam_threshold}, ${config.spam_window_sec}, ${config.mention_threshold}, ${config.anti_nuke_action})
    ON CONFLICT(guild_id) DO UPDATE SET
      anti_nuke=excluded.anti_nuke,
      quarantine=excluded.quarantine,
      anti_spam=excluded.anti_spam,
      anti_phishing=excluded.anti_phishing,
      event_log=excluded.event_log,
      backups=excluded.backups,
      event_log_channel_id=excluded.event_log_channel_id,
      spam_threshold=excluded.spam_threshold,
      spam_window_sec=excluded.spam_window_sec,
      mention_threshold=excluded.mention_threshold,
      anti_nuke_action=excluded.anti_nuke_action
  `;
}

/** All security data for a guild - called when the bot leaves a server. */
export async function deleteSecurityData(guild_id: string) {
  await db`DELETE FROM security_config WHERE guild_id = ${guild_id}`;
}

/** Guilds with a given security module enabled (for pollers/crons). */
export async function getSecurityGuilds(module: SecurityModule): Promise<SecurityConfig[]> {
  const columns: SecurityModule[] = ['anti_nuke', 'quarantine', 'anti_spam', 'anti_phishing', 'event_log', 'backups'];
  const col = columns.find(c => c === module);
  if (!col) return [];
  const rows = await db.unsafe(`SELECT ${securitySelectCols} FROM security_config WHERE ${col} = 1`);
  return rows.map(parseSecurityRow);
}

export async function unsetSecurityLogChannel(guild_id: string) {
  await db`UPDATE security_config SET event_log_channel_id = NULL, event_log = 0 WHERE guild_id = ${guild_id}`;
}

// --- backups ---

export async function addSecurityBackup(
  guild_id: string,
  data: string,
  meta: { channels: number; roles: number },
  reason: string | null,
  keep: number = 4,
): Promise<number> {
  const createdAt = Math.floor(Date.now() / 1000);
  await db`
    INSERT INTO security_backups (guild_id, created_at, reason, meta, data)
    VALUES (${guild_id}, ${createdAt}, ${reason}, ${JSON.stringify(meta)}, ${data})`;
  const [row] = await db`SELECT MAX(id) AS id FROM security_backups WHERE guild_id = ${guild_id}`;
  // keep only the newest `keep` backups per guild
  await db`
    DELETE FROM security_backups WHERE guild_id = ${guild_id} AND id NOT IN (
      SELECT id FROM security_backups WHERE guild_id = ${guild_id} ORDER BY id DESC LIMIT ${keep}
    )`;
  return Number(row?.id ?? 0);
}

export async function getSecurityBackups(guild_id: string, limit: number = 10): Promise<Omit<SecurityBackupRow, 'data'>[]> {
  const rows = await db`
    SELECT id, CAST(guild_id AS VARCHAR(20)) AS guild_id, created_at, reason, meta
    FROM security_backups WHERE guild_id = ${guild_id} ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r: any) => ({
    id: Number(r.id),
    guild_id: r.guild_id.toString(),
    created_at: Number(r.created_at),
    reason: r.reason ?? null,
    meta: r.meta ? JSON.parse(r.meta) : null,
  }));
}

export async function getSecurityBackup(guild_id: string, id: number): Promise<SecurityBackupRow | null> {
  const [row] = await db`
    SELECT id, CAST(guild_id AS VARCHAR(20)) AS guild_id, created_at, reason, meta, data
    FROM security_backups WHERE guild_id = ${guild_id} AND id = ${id}`;
  if (!row) return null;
  return {
    id: Number(row.id),
    guild_id: row.guild_id.toString(),
    created_at: Number(row.created_at),
    reason: row.reason ?? null,
    meta: row.meta ? JSON.parse(row.meta) : null,
    data: row.data,
  };
}

export async function getLatestSecurityBackup(guild_id: string): Promise<SecurityBackupRow | null> {
  const [row] = await db`
    SELECT id, CAST(guild_id AS VARCHAR(20)) AS guild_id, created_at, reason, meta, data
    FROM security_backups WHERE guild_id = ${guild_id} ORDER BY id DESC LIMIT 1`;
  if (!row) return null;
  return {
    id: Number(row.id),
    guild_id: row.guild_id.toString(),
    created_at: Number(row.created_at),
    reason: row.reason ?? null,
    meta: row.meta ? JSON.parse(row.meta) : null,
    data: row.data,
  };
}

// --- bot quarantine ---

export async function addQuarantinedBot(guild_id: string, bot_user_id: string, added_by: string | null, roles: string[]) {
  await db`
    INSERT INTO quarantine_bots (guild_id, bot_user_id, added_by, roles, created_at)
    VALUES (${guild_id}, ${bot_user_id}, ${added_by}, ${JSON.stringify(roles)}, ${Math.floor(Date.now() / 1000)})
    ON CONFLICT(guild_id, bot_user_id) DO UPDATE SET
      added_by=excluded.added_by,
      roles=excluded.roles,
      created_at=excluded.created_at,
      approved_by=NULL,
      approved_at=NULL`;
}

export async function getQuarantinedBot(guild_id: string, bot_user_id: string): Promise<QuarantineRow | null> {
  const [row] = await db`
    SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, CAST(bot_user_id AS VARCHAR(20)) AS bot_user_id,
      CAST(added_by AS VARCHAR(20)) AS added_by, roles, created_at,
      CAST(approved_by AS VARCHAR(20)) AS approved_by, approved_at
    FROM quarantine_bots WHERE guild_id = ${guild_id} AND bot_user_id = ${bot_user_id}`;
  if (!row) return null;
  return {
    guild_id: row.guild_id.toString(),
    bot_user_id: row.bot_user_id.toString(),
    added_by: row.added_by?.toString() ?? null,
    roles: JSON.parse(row.roles || "[]"),
    created_at: Number(row.created_at),
    approved_by: row.approved_by?.toString() ?? null,
    approved_at: row.approved_at != null ? Number(row.approved_at) : null,
  };
}

export async function approveQuarantinedBot(guild_id: string, bot_user_id: string, approved_by: string) {
  await db`UPDATE quarantine_bots SET approved_by = ${approved_by}, approved_at = ${Math.floor(Date.now() / 1000)} WHERE guild_id = ${guild_id} AND bot_user_id = ${bot_user_id}`;
}

export async function removeQuarantinedBot(guild_id: string, bot_user_id: string) {
  await db`DELETE FROM quarantine_bots WHERE guild_id = ${guild_id} AND bot_user_id = ${bot_user_id}`;
}

// --- security event log (used for stats & /stats command) ---

export async function logSecurityEvent(guild_id: string, type: SecurityEventType, user_id?: string | null, channel_id?: string | null, meta?: Record<string, unknown> | null) {
  await db`INSERT INTO security_events (guild_id, type, user_id, channel_id, meta, timestamp)
    VALUES (${guild_id}, ${type}, ${user_id ?? null}, ${channel_id ?? null}, ${meta ? JSON.stringify(meta) : null}, ${Math.floor(Date.now() / 1000)})`;
}

export async function getSecurityEventTotals(): Promise<Record<SecurityEventType, number>> {
  const rows = await db`SELECT type, COUNT(*) as count FROM security_events GROUP BY type`;
  const totals = { anti_nuke: 0, quarantine: 0, spam: 0, phishing: 0, backup: 0, restore: 0 } as Record<string, number>;
  for (const row of rows) totals[row.type] = Number(row.count);
  return totals as Record<SecurityEventType, number>;
}

export async function getGuildSecurityCounts(guild_id: string): Promise<Record<SecurityEventType, number>> {
  const rows = await db`SELECT type, COUNT(*) as count FROM security_events WHERE guild_id = ${guild_id} GROUP BY type`;
  const totals = { anti_nuke: 0, quarantine: 0, spam: 0, phishing: 0, backup: 0, restore: 0 } as Record<string, number>;
  for (const row of rows) totals[row.type] = Number(row.count);
  return totals as Record<SecurityEventType, number>;
}

export async function pingDb(): Promise<void> {
  await db`SELECT 1`;
}

export async function logModerateEvent(guild_id: string, user_id: string, channel_id?: string, action: 'ban' | 'softban' = 'softban', reason?: string | null) {
  await db`INSERT INTO honeypot_events (guild_id, user_id, channel_id, timestamp, action, reason) VALUES (${guild_id}, ${user_id}, ${channel_id ?? null}, ${Math.floor(Date.now() / 1000)}, ${action}, ${reason ?? null})`;
}

export async function getRecentEvents(guild_id: string, limit: number = 25): Promise<{ id: number; user_id: string; channel_id: string | null; timestamp: number; action: string | null; reason: string | null }[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
  const rows = await db`SELECT id, CAST(user_id AS VARCHAR(20)) AS user_id, CAST(channel_id AS VARCHAR(20)) AS channel_id, timestamp, action, reason FROM honeypot_events WHERE guild_id = ${guild_id} ORDER BY id DESC LIMIT ${safeLimit}`;
  return rows.map((r: any) => ({
    id: Number(r.id),
    user_id: r.user_id?.toString() ?? "",
    channel_id: r.channel_id?.toString() ?? null,
    timestamp: Number(r.timestamp),
    action: r.action ?? null,
    reason: r.reason ?? null,
  }));
}

export async function getGuildActionCounts(guild_id: string): Promise<{ ban: number; softban: number }> {  const rows = await db`SELECT action, COUNT(*) as count FROM honeypot_events WHERE guild_id = ${guild_id} GROUP BY action`;
  let ban = 0, softban = 0;
  for (const r of rows as any[]) {
    if (r.action === 'ban') ban = Number(r.count);
    else softban += Number(r.count);
  }
  return { ban, softban };
}

export async function getTotalHoneypotChannels(): Promise<number> {
  const [row] = await db`SELECT COUNT(*) as count FROM honeypot_channels`;
  return Number(row.count);
}

export function hashUserId(user_id: string): string {
  // One-way hash so the shared list never contains raw user IDs.
  return new Bun.CryptoHasher("sha256").update(`honeypot:${user_id}`).digest("hex");
}

export async function addToSharedBanlist(user_id: string, action: 'ban' | 'softban' = 'softban', ttlDays: number = 90): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db`INSERT INTO shared_banlist (user_hash, action, created_at, expires_at)
    VALUES (${hashUserId(user_id)}, ${action}, ${now}, ${now + Math.floor(ttlDays * 86400)})
    ON CONFLICT(user_hash) DO UPDATE SET action=excluded.action, created_at=excluded.created_at, expires_at=excluded.expires_at`;
}

export async function isSharedBanned(user_id: string): Promise<{ action: string } | null> {
  const [row] = await db`SELECT action, expires_at FROM shared_banlist WHERE user_hash = ${hashUserId(user_id)}`;
  if (!row) return null;
  if (Number(row.expires_at) < Date.now() / 1000) {
    await db`DELETE FROM shared_banlist WHERE user_hash = ${hashUserId(user_id)}`.catch(() => null);
    return null;
  }
  return { action: String(row.action || "softban") };
}

export async function purgeSharedBanlist(): Promise<void> {
  await db`DELETE FROM shared_banlist WHERE expires_at < ${Math.floor(Date.now() / 1000)}`.catch(() => null);
}

export type EvasionFingerprint = { username: string | null; global_name: string | null; avatar: string | null };

export async function upsertFingerprint(user_id: string, fp: EvasionFingerprint): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db`INSERT INTO evasion_fingerprints (user_id, username, global_name, avatar, last_seen)
    VALUES (${user_id}, ${fp.username ?? null}, ${fp.global_name ?? null}, ${fp.avatar ?? null}, ${now})
    ON CONFLICT(user_id) DO UPDATE SET
      username=excluded.username, global_name=excluded.global_name,
      avatar=excluded.avatar, last_seen=excluded.last_seen`;
}

/** Finds a previously moderated account with same avatar+name (ban evasion). */
export async function findEvasionMatch(
  user_id: string,
  fp: EvasionFingerprint,
  maxAgeDays: number = 180,
): Promise<{ user_id: string; username: string | null } | null> {
  if (!fp.avatar) return null; // avatar-less accounts match everyone, too weak
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeDays * 86400);
  const rows = await db`SELECT CAST(user_id AS VARCHAR(20)) AS user_id, username FROM evasion_fingerprints
    WHERE user_id != ${user_id} AND avatar = ${fp.avatar} AND last_seen >= ${cutoff}
    AND (username = ${fp.username ?? null} OR global_name = ${fp.global_name ?? null}) LIMIT 1`;
  const row = (rows as any[])[0];
  if (!row) return null;
  return { user_id: row.user_id?.toString() ?? "", username: row.username ?? null };
}

export async function purgeFingerprints(maxAgeDays: number = 180): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeDays * 86400);
  await db`DELETE FROM evasion_fingerprints WHERE last_seen < ${cutoff}`.catch(() => null);
}

/** Live usage counts per experiment across all guilds (for smart sorting). */
export async function getExperimentUsage(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const rows = await db`SELECT experiments FROM honeypot_config WHERE COALESCE(left_at, 0) = 0`.catch(() => []);
  for (const r of rows as any[]) {
    try {
      const list = JSON.parse(r.experiments || "[]");
      if (Array.isArray(list)) {
        for (const e of list) {
          if (typeof e === "string" && e) counts[e] = (counts[e] ?? 0) + 1;
        }
      }
    } catch {
      // ignore malformed rows
    }
  }
  return counts;
}

export async function saveDailySnapshot(): Promise<void> {
  const day = new Date().toISOString().split("T")[0]!;
  const [meta] = await db`
    SELECT
      (SELECT COUNT(*) FROM honeypot_config) AS guilds,
      (SELECT COUNT(*) FROM honeypot_events) AS moderations
  ` as any[];
  await db`INSERT INTO stats_snapshots (day, guilds, moderations)
    VALUES (${day}, ${Number((meta as any)?.guilds ?? 0)}, ${Number((meta as any)?.moderations ?? 0)})
    ON CONFLICT(day) DO UPDATE SET guilds=excluded.guilds, moderations=excluded.moderations`;
}

export async function getHistory90(): Promise<{ date: string; guilds: number; moderations: number }[]> {
  const rows = await db`SELECT day AS date, guilds, moderations FROM stats_snapshots ORDER BY day DESC LIMIT 90`;
  return (rows as any[]).reverse().map((r) => ({
    date: String(r.date),
    guilds: Number(r.guilds),
    moderations: Number(r.moderations),
  }));
}
export async function getAllGuildConfigs(): Promise<{ guild_id: string; name: string | null; icon: string | null }[]> {
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, name, icon FROM honeypot_config WHERE COALESCE(left_at, 0) = 0 ORDER BY name`;
  return (rows as any[]).map((r) => ({
    guild_id: r.guild_id?.toString() ?? "",
    name: r.name ? String(r.name) : null,
    icon: r.icon ? String(r.icon) : null,
  }));
}

export async function getLogChannels(): Promise<{ guild_id: string; log_channel_id: string }[]> {
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, CAST(log_channel_id AS VARCHAR(20)) AS log_channel_id FROM honeypot_config WHERE COALESCE(left_at, 0) = 0 AND log_channel_id IS NOT NULL`;
  return (rows as any[]).map((r) => ({
    guild_id: r.guild_id?.toString() ?? "",
    log_channel_id: r.log_channel_id?.toString() ?? "",
  }));
}

export async function getMigrationVersion(): Promise<number> {
  const rows = await db`SELECT MAX(version) AS v FROM _migrations`.catch(() => [{ v: 0 }]);
  return Number((rows as any[])[0]?.v ?? 0);
}

export async function getGlobalRecentEvents(limit: number = 25): Promise<{ id: number; guild_id: string; guild_name: string | null; user_id: string; channel_id: string | null; timestamp: number; action: string | null; reason: string | null }[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
  const rows = await db`SELECT e.id, CAST(e.guild_id AS VARCHAR(20)) AS guild_id, c.name AS guild_name,
      CAST(e.user_id AS VARCHAR(20)) AS user_id, CAST(e.channel_id AS VARCHAR(20)) AS channel_id,
      e.timestamp, e.action, e.reason
    FROM honeypot_events e LEFT JOIN honeypot_config c ON c.guild_id = e.guild_id
    ORDER BY e.id DESC LIMIT ${safeLimit}`;
  return (rows as any[]).map((r) => ({
    id: Number(r.id),
    guild_id: r.guild_id?.toString() ?? "",
    guild_name: r.guild_name ? String(r.guild_name) : null,
    user_id: r.user_id?.toString() ?? "",
    channel_id: r.channel_id?.toString() ?? null,
    timestamp: Number(r.timestamp),
    action: r.action ?? null,
    reason: r.reason ?? null,
  }));
}
export async function setExperimentForAll(experiment: string, enable: boolean): Promise<{ updated: number; total: number }> {
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, experiments FROM honeypot_config WHERE COALESCE(left_at, 0) = 0`;
  let updated = 0;
  for (const r of rows as any[]) {
    let list: string[] = [];
    try {
      const parsed = JSON.parse(r.experiments || "[]");
      if (Array.isArray(parsed)) list = parsed.filter((e) => typeof e === "string");
    } catch { /* treat as empty */ }
    const has = list.includes(experiment);
    if (has === enable) continue;
    const next = enable ? [...list, experiment] : list.filter((e) => e !== experiment);
    await db`UPDATE honeypot_config SET experiments = ${JSON.stringify(next)} WHERE guild_id = ${r.guild_id?.toString()}`;
    updated++;
  }
  return { updated, total: (rows as any[]).length };
}

/** Per-experiment guild lists (which guilds have it enabled). */
export async function getExperimentStates(): Promise<Record<string, string[]>> {
  const states: Record<string, string[]> = {};
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, experiments FROM honeypot_config WHERE COALESCE(left_at, 0) = 0`.catch(() => []);
  for (const r of rows as any[]) {
    try {
      const list = JSON.parse((r as any).experiments || "[]");
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (typeof e !== "string" || !e) continue;
        (states[e] ??= []).push((r as any).guild_id?.toString() ?? "");
      }
    } catch { /* ignore malformed */ }
  }
  return states;
}

export async function setExperimentForGuilds(experiment: string, enable: boolean, guildIds: string[]): Promise<{ updated: number; total: number }> {
  const ids = [...new Set(guildIds.filter(Boolean))].slice(0, 200);
  let updated = 0;
  for (const id of ids) {
    const [row] = await db`SELECT experiments FROM honeypot_config WHERE guild_id = ${id}`.catch(() => [null]);
    if (!row) continue;
    let list: string[] = [];
    try {
      const parsed = JSON.parse((row as any).experiments || "[]");
      if (Array.isArray(parsed)) list = parsed.filter((e) => typeof e === "string");
    } catch { /* treat as empty */ }
    const has = list.includes(experiment);
    if (has === enable) continue;
    const next = enable ? [...list, experiment] : list.filter((e) => e !== experiment);
    await db`UPDATE honeypot_config SET experiments = ${JSON.stringify(next)} WHERE guild_id = ${id}`.catch(() => null);
    updated++;
  }
  return { updated, total: ids.length };
}

export async function getGlobalOverviewStats(): Promise<{ today: number; last7d: number; last30d: number; shared: number; prints: number }> {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = Math.floor(new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime() / 1000);
  const [row] = await db`SELECT
      (SELECT COUNT(*) FROM honeypot_events WHERE timestamp >= ${dayStart}) AS today,
      (SELECT COUNT(*) FROM honeypot_events WHERE timestamp >= ${now - 7 * 86400}) AS last7d,
      (SELECT COUNT(*) FROM honeypot_events WHERE timestamp >= ${now - 30 * 86400}) AS last30d,
      (SELECT COUNT(*) FROM shared_banlist) AS shared,
      (SELECT COUNT(*) FROM evasion_fingerprints) AS prints`.catch(() => [{ today: 0, last7d: 0, last30d: 0, shared: 0, prints: 0 }]);
  const r = (Array.isArray(row) ? row[0] : row) as any;
  return {
    today: Number(r?.today ?? 0),
    last7d: Number(r?.last7d ?? 0),
    last30d: Number(r?.last30d ?? 0),
    shared: Number(r?.shared ?? 0),
    prints: Number(r?.prints ?? 0),
  };
}

export async function getConfigsMissingNames(limit: number = 50): Promise<HoneypotConfig[]> {  const safeLimit = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, name, icon, CAST(log_channel_id AS VARCHAR(20)) AS log_channel_id, action, experiments FROM honeypot_config WHERE (name IS NULL OR icon IS NULL) AND COALESCE(left_at, 0) = 0 LIMIT ${safeLimit}`;
  return (rows as any[]).map(parseConfigRow);
}
export async function getLeaderboard(limit: number = 10): Promise<{ name: string; icon: string | null; moderations: number }[]> {
  // Opt-in only: just guilds with the leaderboard experiment.
  // Names are filtered against the blocklist (no spotlight for trolls).
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 10, 1), 10);
  const rows = await db`SELECT c.name AS name, c.icon AS icon, CAST(c.guild_id AS VARCHAR(20)) AS guild_id, COUNT(e.id) AS count
    FROM honeypot_config c LEFT JOIN honeypot_events e ON e.guild_id = c.guild_id
    WHERE c.experiments LIKE '%leaderboard%' AND COALESCE(c.left_at, 0) = 0
    GROUP BY c.guild_id ORDER BY count DESC LIMIT 25`;
  const all = (rows as any[]).map((r) => {
    const gid = r.guild_id?.toString() ?? "";
    const hash = r.icon ? String(r.icon) : null;
    return {
      name: r.name ? String(r.name) : "Unknown server",
      icon: hash && gid ? `https://cdn.discordapp.com/icons/${gid}/${hash}.png?size=64` : null,
      moderations: Number(r.count),
    };
  });
  const clean: typeof all = [];
  for (const entry of all) {
    if (clean.length >= safeLimit) break;
    if (await isCleanName(entry.name)) clean.push(entry);
  }
  return clean;
}

let badWordsCache: string[] | null = null;
async function getBadWordsCached(): Promise<string[]> {
  if (!badWordsCache) {
    const getBadWords = (await import("./bad-words.macro")).default;
    badWordsCache = await getBadWords();
  }
  return badWordsCache;
}

/** True when a server name is safe to show publicly. */
export type PremiumUser = {
  user_id: string; username: string | null; discord_token: string | null; client_secret: string | null;
  public_url: string | null; donate_ltc: string | null; status: string; plan: string;
  expires_at: number; created_at: number; runs: number;
};

const PREMIUM_GRACE_SEC = 3 * 86400;

function encToken(raw: string | null): string | null {
  if (!raw) return null;
  const key = process.env.PREMIUM_SECRET || process.env.DISCORD_TOKEN || "dev-key-change-me";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Node/Bun: aes-256-gcm with Web Crypto would be async; keep it simple via Bun.hash for now and store obfuscated:
  // actually store as base64 of xor with key hash — good enough for at-rest obfuscation, not a substitute for env isolation
  const k = new Bun.CryptoHasher("sha256").update(key).digest();
  let out = new Uint8Array(iv.length + raw.length);
  out.set(iv);
  for (let i = 0; i < raw.length; i++) out[iv.length + i] = raw.charCodeAt(i) ^ k[i % k.length]!;
  return btoa(String.fromCharCode(...out));
}

function decToken(enc: string | null): string | null {
  if (!enc) return null;
  try {
    const key = process.env.PREMIUM_SECRET || process.env.DISCORD_TOKEN || "dev-key-change-me";
    const k = new Bun.CryptoHasher("sha256").update(key).digest();
    const bytes = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
    const ivLen = 12;
    let raw = "";
    for (let i = 0; i < bytes.length - ivLen; i++) raw += String.fromCharCode(bytes[ivLen + i]! ^ k[i % k.length]!);
    return raw;
  } catch { return null; }
}

export async function getPremiumUser(user_id: string): Promise<PremiumUser | null> {
  const [row] = await db`SELECT CAST(user_id AS VARCHAR(20)) AS user_id, username, discord_token, client_secret, public_url, donate_ltc, status, plan, expires_at, created_at, runs FROM premium_users WHERE user_id = ${user_id}`;
  if (!row) return null;
  return {
    user_id: (row as any).user_id?.toString() ?? user_id,
    username: (row as any).username ?? null,
    discord_token: decToken((row as any).discord_token),
    client_secret: decToken((row as any).client_secret),
    public_url: (row as any).public_url ?? null,
    donate_ltc: (row as any).donate_ltc ?? null,
    status: (row as any).status ?? "pending",
    plan: (row as any).plan ?? "premium",
    expires_at: Number((row as any).expires_at ?? 0),
    created_at: Number((row as any).created_at ?? 0),
    runs: Number((row as any).runs ?? 0),
  };
}

export async function upsertPremiumUser(user_id: string, patch: Partial<Pick<PremiumUser, "username" | "discord_token" | "client_secret" | "public_url" | "donate_ltc" | "status" | "plan" | "expires_at">>): Promise<PremiumUser> {
  const existing = await getPremiumUser(user_id);
  const now = Math.floor(Date.now() / 1000);
  const next: PremiumUser = {
    user_id,
    username: patch.username ?? existing?.username ?? null,
    discord_token: patch.discord_token !== undefined ? patch.discord_token : existing?.discord_token ?? null,
    client_secret: patch.client_secret !== undefined ? patch.client_secret : existing?.client_secret ?? null,
    public_url: patch.public_url !== undefined ? patch.public_url : existing?.public_url ?? null,
    donate_ltc: patch.donate_ltc !== undefined ? patch.donate_ltc : existing?.donate_ltc ?? null,
    status: patch.status ?? existing?.status ?? "pending",
    plan: patch.plan ?? existing?.plan ?? "premium",
    expires_at: patch.expires_at ?? existing?.expires_at ?? 0,
    created_at: existing?.created_at || now,
    runs: existing?.runs ?? 0,
  };
  await db`INSERT INTO premium_users (user_id, username, discord_token, client_secret, public_url, donate_ltc, status, plan, expires_at, created_at, runs)
    VALUES (${next.user_id}, ${next.username}, ${encToken(next.discord_token)}, ${encToken(next.client_secret)}, ${next.public_url}, ${next.donate_ltc}, ${next.status}, ${next.plan}, ${next.expires_at}, ${next.created_at}, ${next.runs})
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, discord_token=excluded.discord_token, client_secret=excluded.client_secret, public_url=excluded.public_url, donate_ltc=excluded.donate_ltc, status=excluded.status, plan=excluded.plan, expires_at=excluded.expires_at`;
  return next;
}

export async function listPremiumUsers(): Promise<PremiumUser[]> {
  const rows = await db`SELECT CAST(user_id AS VARCHAR(20)) AS user_id, username, discord_token, client_secret, public_url, donate_ltc, status, plan, expires_at, created_at, runs FROM premium_users ORDER BY created_at DESC`;
  return (rows as any[]).map((r) => ({
    user_id: r.user_id?.toString() ?? "",
    username: r.username ?? null,
    discord_token: decToken(r.discord_token),
    client_secret: decToken(r.client_secret),
    public_url: r.public_url ?? null,
    donate_ltc: r.donate_ltc ?? null,
    status: r.status ?? "pending",
    plan: r.plan ?? "premium",
    expires_at: Number(r.expires_at ?? 0),
    created_at: Number(r.created_at ?? 0),
    runs: Number(r.runs ?? 0),
  }));
}

export async function isPremiumActive(user_id: string): Promise<boolean> {
  const u = await getPremiumUser(user_id);
  if (!u || u.status !== "active") return false;
  if (!u.expires_at) return true;
  const now = Math.floor(Date.now() / 1000);
  if (now < u.expires_at + PREMIUM_GRACE_SEC) return true;
  return false;
}

export async function purgeExpiredPremium(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - PREMIUM_GRACE_SEC;
  const doomed = await db`SELECT CAST(user_id AS VARCHAR(20)) AS user_id FROM premium_users WHERE status = 'active' AND expires_at > 0 AND expires_at < ${cutoff}`.catch(() => []);
  const ids = (doomed as any[]).map((r) => r.user_id?.toString()).filter(Boolean);
  for (const id of ids) {
    await db`UPDATE premium_users SET status = 'expired', discord_token = NULL, client_secret = NULL WHERE user_id = ${id}`.catch(() => null);
    // delete isolated DB file if it exists (best effort)
    try {
      const p = `${process.cwd()}/premium_${id}.sqlite`;
      const f = Bun.file(p);
      if (await f.exists()) await Bun.write(p, "");
      await Bun.file(p).unlink?.();
    } catch { /* ignore */ }
    try { await Bun.file(`${process.cwd()}/premium_${id}.sqlite-wal`).unlink?.(); } catch { /* ignore */ }
    try { await Bun.file(`${process.cwd()}/premium_${id}.sqlite-shm`).unlink?.(); } catch { /* ignore */ }
  }
  return ids.length;
}

export async function hasUsedTxid(txid: string): Promise<boolean> {
  const [row] = await db`SELECT 1 as hit FROM premium_payments WHERE txid = ${txid}`.catch(() => []);
  return !!row;
}

export async function recordPremiumPayment(txid: string, user_id: string, ltc_amount: number, eur_amount: number, confirmations: number): Promise<void> {
  await db`INSERT INTO premium_payments (txid, user_id, ltc_amount, eur_amount, confirmations, verified_at)
    VALUES (${txid}, ${user_id}, ${ltc_amount}, ${eur_amount}, ${confirmations}, ${Math.floor(Date.now() / 1000)})
    ON CONFLICT(txid) DO NOTHING`;
}

export async function isCleanName(name: string): Promise<boolean> {  try {
    const list = await getBadWordsCached();
    const words = name.toLowerCase().replace(/[^a-z0-9]/gi, " ").split(/\W+/).filter(Boolean);
    return !words.some((w) => list.includes(w));
  } catch {
    return true; // filter unavailable: show rather than break the page
  }
}

export async function getModeratedCount(guild_id: string, channel_id?: string | null): Promise<number> {
  if (channel_id) {
    const [row] = await db`SELECT COUNT(*) as count FROM honeypot_events WHERE guild_id = ${guild_id} AND channel_id = ${channel_id}`;
    return Number(row.count);
  } else {
    const [row] = await db`SELECT COUNT(*) as count FROM honeypot_events WHERE guild_id = ${guild_id}`;
    return Number(row.count);
  }
}

export async function unsetHoneypotChannel(guildId: string, channelId: string) {
  await db`DELETE FROM honeypot_channels WHERE guild_id = ${guildId} AND channel_id = ${channelId}`;
}

export async function unsetLogChannel(guildId: string, channelId: string) {
  await db`UPDATE honeypot_config SET log_channel_id = NULL WHERE guild_id = ${guildId} AND log_channel_id = ${channelId}`;
}

export async function unsetHoneypotMsg(guildId: string, messageId: string) {
  const row = await db`SELECT 1 FROM honeypot_channels WHERE guild_id = ${guildId} AND msg_id = ${messageId}`;
  if (row.length === 0) return;

  await db`UPDATE honeypot_channels SET msg_id = NULL WHERE guild_id = ${guildId} AND msg_id = ${messageId}`;
}

export async function unsetHoneypotMsgs(guildId: string, messageIds: string[]) {
  if (messageIds.length === 0) return;

  const row = await db`SELECT 1 FROM honeypot_channels WHERE guild_id = ${guildId} AND msg_id IN ${db(messageIds)}`;
  if (row.length === 0) return;

  await db`UPDATE honeypot_channels SET msg_id = NULL WHERE guild_id = ${guildId} AND msg_id IN ${db(messageIds)}`;
}

export async function setHoneypotChannels(guild_id: string, channels: { channel_id: string; msg_id?: string | null }[]) {
  if (channels.length === 0) {
    await db`DELETE FROM honeypot_channels WHERE guild_id = ${guild_id}`;
    return;
  }
  await db.begin(async (tx) => {
    await tx`DELETE FROM honeypot_channels WHERE guild_id = ${guild_id} AND channel_id NOT IN ${db(channels.map(c => c.channel_id))}`;
    await tx`
        INSERT INTO honeypot_channels ${tx(
      channels.map(c => ({
        channel_id: c.channel_id,
        guild_id,
        msg_id: c.msg_id ?? null
      }))
    )}
        ON CONFLICT(channel_id)
        DO UPDATE SET msg_id=excluded.msg_id
      `;
  });
}

export async function replaceHoneypotChannel(guild_id: string, old_channel_id: string, new_channel_id: string, msg_id?: string | null) {
  await db.begin(async (tx) => {
    await tx`INSERT INTO honeypot_channels (channel_id, guild_id, msg_id) VALUES (${new_channel_id}, ${guild_id}, ${msg_id ?? null}) ON CONFLICT(channel_id) DO UPDATE SET msg_id=excluded.msg_id`;
    await tx`UPDATE honeypot_events SET channel_id = ${new_channel_id} WHERE guild_id = ${guild_id} AND channel_id = ${old_channel_id}`;
    await tx`DELETE FROM honeypot_channels WHERE guild_id = ${guild_id} AND channel_id = ${old_channel_id}`;
  });
}

export async function getStats(): Promise<{ totalGuilds: number; totalModerated: number; }> {
  const [result] = await db`SELECT (SELECT COUNT(*) FROM honeypot_config WHERE COALESCE(left_at, 0) = 0) AS config_count, (SELECT COUNT(*) FROM honeypot_events e WHERE EXISTS (SELECT 1 FROM honeypot_config c WHERE c.guild_id = e.guild_id AND COALESCE(c.left_at, 0) = 0)) AS event_count;`;
  return {
    totalGuilds: Number(result.config_count),
    totalModerated: Number(result.event_count),
  };
}


export async function getGuildStats(guild_id: string): Promise<{ channel_id: string | null; moderatedCount: number; }[]> {
  const rows = await db`SELECT CAST(channel_id AS VARCHAR(20)) AS channel_id, COUNT(*) as moderated_count FROM honeypot_events WHERE guild_id = ${guild_id} GROUP BY channel_id`;
  return rows.map((row: any) => ({
    channel_id: row.channel_id?.toString() || null,
    moderatedCount: Number(row.moderated_count)
  }));
}

export async function getRecentGuildModerationCount(guild_id: string, days: number = 7): Promise<number> {
  const sinceDate = Date.now() - days * 24 * 60 * 60 * 1000;
  const [row] = await db`SELECT COUNT(*) as count FROM honeypot_events WHERE guild_id = ${guild_id} AND timestamp >= ${sinceDate / 1000}`;
  return Number(row.count);
}

export async function getGuildHasHoneypotHistory(guild_id: string): Promise<boolean> {
  const [row] = await db`SELECT EXISTS (SELECT 1 FROM honeypot_events WHERE guild_id = ${guild_id}) as has_history`;
  return Boolean(row.has_history);
}

export async function getUserModeratedCount(user_id: string): Promise<number> {
  const [row] = await db`SELECT COUNT(*) as count FROM honeypot_events WHERE user_id = ${user_id}`;
  return Number(row.count);
}

export async function getGuildsWithExperiment(experiment: HoneypotConfig["experiments"][number]): Promise<HoneypotConfig[]> {
  const rows = await db`SELECT CAST(guild_id AS VARCHAR(20)) AS guild_id, CAST(log_channel_id AS VARCHAR(20)) AS log_channel_id, action, experiments FROM honeypot_config WHERE experiments LIKE '%' || ${experiment} || '%'`;
  return rows.map((row: any) => parseConfigRow(row));
}
export async function getHoneypotMessages(guild_id: string): Promise<{ warning_message: string | null; dm_message: string | null; log_message: string | null; }> {
  const [row] = await db`SELECT * FROM honeypot_messages WHERE guild_id = ${guild_id}`;
  if (!row) {
    return {
      warning_message: null,
      dm_message: null,
      log_message: null,
    };
  }
  return {
    warning_message: row.warning_message,
    dm_message: row.dm_message,
    log_message: row.log_message,
  };
}

export async function setHoneypotMessages(guild_id: string, messages: { warning_message?: string | null; dm_message?: string | null; log_message?: string | null; }) {
  if (messages.warning_message === null && messages.dm_message === null && messages.log_message === null) {
    await db`DELETE FROM honeypot_messages WHERE guild_id = ${guild_id}`;
    return;
  }
  await db`
    INSERT INTO honeypot_messages (guild_id, warning_message, dm_message, log_message)
    VALUES (${guild_id}, ${messages.warning_message}, ${messages.dm_message}, ${messages.log_message})
    ON CONFLICT(guild_id) DO UPDATE SET
      warning_message=excluded.warning_message,
      dm_message=excluded.dm_message,
      log_message=excluded.log_message
  `;
}


export async function getReinvite(guild_id: string): Promise<string | null> {
  const [row] = await db`SELECT invite FROM honeypot_reinvite WHERE guild_id = ${guild_id}`;
  if (!row) return null;
  return row.invite;
}

export async function setReinvite(guild_id: string, invite: string | false) {
  if (!invite) {
    await db`DELETE FROM honeypot_reinvite WHERE guild_id = ${guild_id}`;
    return;
  }
  await db`
    INSERT INTO honeypot_reinvite (guild_id, invite)
    VALUES (${guild_id}, ${invite})
    ON CONFLICT(guild_id) DO UPDATE SET
      invite=excluded.invite
  `;
}

export async function getFullStats(): Promise<{
  guilds: number;
  moderations: number;
  last7dModerations: number;
  last7dEngagedGuilds: number;
  moderationsByAction: { ban: number; softban: number };
  dailyStats: { date: string; moderations: number; engagedGuilds: number; }[];
  security: {
    totals: Record<SecurityEventType, number>;
    last7dIncidents: number;
    dailyStats: { date: string; incidents: number; }[];
    modules: Record<SecurityModule, number>;
  };
}> {
  const now = new Date();

  // Calculate the start of today in UTC (00:00:00)
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayStartSec = Math.floor(todayStart.getTime() / 1000);

  const sevenDaysAgoSec = todayStartSec - (7 * 24 * 60 * 60);
  const fourteenDaysAgoSec = todayStartSec - (14 * 24 * 60 * 60);

  const [[meta], events, byActionRows, securityTotalRows, securityEvents] = await Promise.all([
    db`
      SELECT
        (SELECT COUNT(*) FROM honeypot_config WHERE COALESCE(left_at, 0) = 0) AS guilds,
        (SELECT COUNT(*) FROM honeypot_events e WHERE EXISTS (SELECT 1 FROM honeypot_config c WHERE c.guild_id = e.guild_id AND COALESCE(c.left_at, 0) = 0)) AS moderations,
        (SELECT COUNT(*) FROM security_config WHERE anti_nuke = 1) AS mod_anti_nuke,
        (SELECT COUNT(*) FROM security_config WHERE quarantine = 1) AS mod_quarantine,
        (SELECT COUNT(*) FROM security_config WHERE anti_spam = 1) AS mod_anti_spam,
        (SELECT COUNT(*) FROM security_config WHERE anti_phishing = 1) AS mod_anti_phishing,
        (SELECT COUNT(*) FROM security_config WHERE event_log = 1) AS mod_event_log,
        (SELECT COUNT(*) FROM security_config WHERE backups = 1) AS mod_backups
    `,
    db`
      SELECT timestamp, CAST(guild_id AS VARCHAR(20)) AS guild_id
      FROM honeypot_events
      WHERE timestamp >= ${fourteenDaysAgoSec}
      ORDER BY timestamp ASC;
    `,
    db`
      SELECT action, COUNT(*) AS count
      FROM honeypot_events
      GROUP BY action;
    `,
    db`SELECT type, COUNT(*) AS count FROM security_events GROUP BY type`,
    db`SELECT timestamp FROM security_events WHERE timestamp >= ${fourteenDaysAgoSec} ORDER BY timestamp ASC`,
  ]);

  let last7dModerations = 0;
  const last7dGuilds = new Set<string>();
  const dailyMap = new Map<number, { moderations: number; guilds: Set<string> }>();

  // Constant number of seconds in a single day
  const SECONDS_IN_DAY = 24 * 60 * 60;

  for (const row of events) {
    const ts = row.timestamp;
    if (ts < fourteenDaysAgoSec) continue;

    const gID = row.guild_id ?? null;

    if (ts >= sevenDaysAgoSec) {
      last7dModerations++;
      if (gID) last7dGuilds.add(gID);
    }

    // Skip today's events for daily historical stats
    if (ts >= todayStartSec) continue;

    const dayStartTimestamp = ts - (ts % SECONDS_IN_DAY);

    let day = dailyMap.get(dayStartTimestamp);
    if (!day) {
      day = { moderations: 0, guilds: new Set() };
      dailyMap.set(dayStartTimestamp, day);
    }

    day.moderations++;
    if (gID) day.guilds.add(gID);
  }

  // security events: totals by type + daily incidents over the same 14 day window
  const securityTotals = { anti_nuke: 0, quarantine: 0, spam: 0, phishing: 0, backup: 0, restore: 0 } as Record<string, number>;
  for (const row of securityTotalRows) securityTotals[row.type] = Number(row.count);

  let last7dSecurityIncidents = 0;
  const securityDailyMap = new Map<number, number>();
  for (const row of securityEvents) {
    const ts = row.timestamp;
    if (ts < fourteenDaysAgoSec) continue;
    if (ts >= sevenDaysAgoSec) last7dSecurityIncidents++;
    if (ts >= todayStartSec) continue;
    const dayStartTimestamp = ts - (ts % SECONDS_IN_DAY);
    securityDailyMap.set(dayStartTimestamp, (securityDailyMap.get(dayStartTimestamp) ?? 0) + 1);
  }

  return {
    guilds: Number(meta.guilds),
    moderations: Number(meta.moderations),
    last7dModerations,
    last7dEngagedGuilds: last7dGuilds.size,
    moderationsByAction: (byActionRows as any[]).reduce(
      (acc, r) => {
        if (r.action === 'ban') acc.ban = Number(r.count);
        else acc.softban += Number(r.count);
        return acc;
      },
      { ban: 0, softban: 0 }
    ),
    dailyStats: Array.from(dailyMap.entries())
      .map(([dayTimestamp, v]) => ({
        date: new Date(dayTimestamp * 1000).toISOString().split('T')[0]!,
        moderations: v.moderations,
        engagedGuilds: v.guilds.size,
      })),
    security: {
      totals: securityTotals as Record<SecurityEventType, number>,
      last7dIncidents: last7dSecurityIncidents,
      dailyStats: Array.from(securityDailyMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([dayTimestamp, incidents]) => ({
          date: new Date(dayTimestamp * 1000).toISOString().split('T')[0]!,
          incidents,
        })),
      modules: {
        anti_nuke: Number(meta.mod_anti_nuke),
        quarantine: Number(meta.mod_quarantine),
        anti_spam: Number(meta.mod_anti_spam),
        anti_phishing: Number(meta.mod_anti_phishing),
        event_log: Number(meta.mod_event_log),
        backups: Number(meta.mod_backups),
      },
    },
  };
}
