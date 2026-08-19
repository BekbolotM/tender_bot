import { neon } from "@neondatabase/serverless";
import { env } from "./env";

export type Sql = ReturnType<typeof neon>;

let cached: Sql | null = null;

export function sql(): Sql {
  if (!cached) cached = neon(env.databaseUrl);
  return cached;
}

/**
 * Создаёт схему, если её ещё нет. Дёшево и идемпотентно, поэтому
 * вызывается из /api/setup, а не отдельным миграционным инструментом.
 */
export async function migrate(): Promise<void> {
  const db = sql();

  await db`
    CREATE TABLE IF NOT EXISTS sites (
      id            SERIAL PRIMARY KEY,
      title         TEXT        NOT NULL,
      list_url      TEXT        NOT NULL,
      selectors     JSONB       NOT NULL,
      enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
      last_checked_at TIMESTAMPTZ,
      last_error    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  // Режим поиска появился позже самой таблицы, поэтому отдельным шагом:
  // миграция должна поднимать и пустую базу, и уже работающую.
  await db`
    ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS search JSONB NOT NULL DEFAULT '{"mode":"off"}'::jsonb`;

  await db`
    CREATE TABLE IF NOT EXISTS keywords (
      id         SERIAL PRIMARY KEY,
      word       TEXT        NOT NULL,
      is_negative BOOLEAN    NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (word, is_negative)
    )`;

  await db`
    CREATE TABLE IF NOT EXISTS admins (
      tg_id      BIGINT PRIMARY KEY,
      username   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await db`
    CREATE TABLE IF NOT EXISTS seen_items (
      id         SERIAL PRIMARY KEY,
      site_id    INTEGER     NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      item_hash  TEXT        NOT NULL,
      title      TEXT        NOT NULL,
      url        TEXT,
      matched    BOOLEAN     NOT NULL DEFAULT FALSE,
      found_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (site_id, item_hash)
    )`;

  await db`
    CREATE TABLE IF NOT EXISTS user_state (
      tg_id      BIGINT PRIMARY KEY,
      state      TEXT,
      payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

  await db`
    CREATE TABLE IF NOT EXISTS invites (
      token      TEXT PRIMARY KEY,
      created_by BIGINT      NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_by    BIGINT,
      used_at    TIMESTAMPTZ
    )`;

  await db`CREATE INDEX IF NOT EXISTS seen_items_found_at_idx ON seen_items (found_at DESC)`;

  // Частичный индекс: погашенные приглашения остаются в таблице как журнал
  // «кто кого впустил», а искать среди них всегда нужно только живые.
  await db`
    CREATE INDEX IF NOT EXISTS invites_active_idx
    ON invites (expires_at) WHERE used_by IS NULL`;
}
