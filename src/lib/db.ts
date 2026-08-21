import { neon } from "@neondatabase/serverless";
import { env } from "./env.ts";

export type Sql = ReturnType<typeof neon>;

let cached: Sql | null = null;

export function sql(): Sql {
  if (!cached) cached = neon(env.databaseUrl);
  return cached;
}

/**
 * Похоже ли на «схема отстала от кода»: нет колонки или нет таблицы.
 * Коды Postgres: 42703 — undefined_column, 42P01 — undefined_table.
 */
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "42703" || code === "42P01") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(column|relation|таблиц).{0,80}does not exist/i.test(message);
}

/**
 * Оборачивает работу так, чтобы она шла не чаще одного раза за жизнь процесса,
 * сколько бы запросов ни попросили её одновременно: второй и следующие ждут
 * тот же самый промис. Неудача сбрасывает засов — иначе одна неудачная попытка
 * навсегда запомнилась бы как «уже сделано», и холодный старт с моргнувшей
 * сетью выключал бы бота до следующей выкладки.
 */
export function once(run: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    if (!started) {
      started = run().catch((error: unknown) => {
        started = null;
        throw error;
      });
    }
    return started;
  };
}

/**
 * Запускает запрос и, если база отстала от кода (новая колонка ещё не
 * доехала), один раз чинит схему и повторяет.
 *
 * Иначе выкладка версии с новой колонкой выключала бы бота целиком до тех пор,
 * пока владелец вручную не откроет /api/setup: падало бы всё, что читает
 * сайты, — меню, кнопка проверки, крон и приём страниц от сборщика.
 *
 * Повтор ровно один: если после миграции запрос падает тем же самым, дело не в
 * схеме, и крутить это по кругу значит менять понятную ошибку на зависший бот.
 */
export async function retryOnMissingSchema<T>(
  run: () => Promise<T>,
  repair: () => Promise<void>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    await repair();
    return run();
  }
}

/** Миграция на процесс не чаще одного раза: она идемпотентна, но не бесплатна. */
const ensureSchema = once(() => migrate());

/** Тот же повтор, но с настоящей миграцией: этим и пользуется весь код репозитория. */
export function withSchema<T>(run: () => Promise<T>): Promise<T> {
  return retryOnMissingSchema(run, ensureSchema);
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

  // Часть площадок пускает только обычных посетителей: серверным адресам они
  // показывают проверку браузера. Такие сайты качает домашний сборщик и
  // присылает страницу в /api/ingest, а серверный обход их пропускает.
  await db`
    ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS via_local BOOLEAN NOT NULL DEFAULT FALSE`;

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
