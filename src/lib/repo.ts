import { sql, withSchema } from "./db";
import { env } from "./env";
import type { Keyword, Selectors, Site, SiteSearch } from "./types";

/* ---------- админы ---------- */

export async function isAdmin(tgId: number): Promise<boolean> {
  if (env.ownerIds.includes(tgId)) return true;
  const rows = (await sql()`SELECT 1 FROM admins WHERE tg_id = ${tgId}`) as unknown[];
  return rows.length > 0;
}

export async function listAdmins(): Promise<{ tg_id: number; username: string | null }[]> {
  const rows = (await sql()`
    SELECT tg_id, username FROM admins ORDER BY created_at`) as { tg_id: string; username: string | null }[];
  return rows.map((r) => ({ tg_id: Number(r.tg_id), username: r.username }));
}

export async function addAdmin(tgId: number, username: string | null): Promise<void> {
  await sql()`
    INSERT INTO admins (tg_id, username) VALUES (${tgId}, ${username})
    ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username`;
}

/**
 * Первый, кто напишет боту, становится владельцем — иначе после деплоя
 * пришлось бы отдельно выяснять свой Telegram ID и класть его в переменные.
 * Условие `WHERE NOT EXISTS` выполняется в самой БД, поэтому окно захвата
 * закрывается атомарно: второй претендент уже не пройдёт.
 */
export async function claimOwnership(tgId: number, username: string | null): Promise<boolean> {
  const rows = (await sql()`
    INSERT INTO admins (tg_id, username)
    SELECT ${tgId}, ${username}
    WHERE NOT EXISTS (SELECT 1 FROM admins)
    RETURNING tg_id`) as unknown[];
  return rows.length > 0;
}

/**
 * Снятие прав закрывает и невыданные ключи этого админа: иначе он вернёт себе
 * доступ по собственной ссылке — она живёт ещё сутки, а в меню видно только
 * их число, без автора, и владелец даже не знает, что отзыв надо нажать.
 * Одним запросом: у HTTP-драйвера каждый запрос сам себе транзакция, и между
 * двумя оставалось бы окно, в которое снятый успевает перейти по ссылке.
 */
export async function removeAdmin(tgId: number): Promise<void> {
  await sql()`
    WITH revoked AS (
      UPDATE invites SET expires_at = NOW()
      WHERE created_by = ${tgId} AND used_by IS NULL AND expires_at > NOW()
      RETURNING token
    )
    DELETE FROM admins WHERE tg_id = ${tgId}`;
}

/** Кому рассылать найденные тендеры: владельцы из env + добавленные админы. */
export async function notifyTargets(): Promise<number[]> {
  const admins = await listAdmins();
  return [...new Set([...env.ownerIds, ...admins.map((a) => a.tg_id)])];
}

/* ---------- приглашения ---------- */

export async function createInvite(
  token: string,
  createdBy: number,
  expiresAt: Date,
): Promise<void> {
  // Срок уходит строкой ISO в UTC: драйвер шлёт параметры текстом, и форма
  // записи не должна зависеть от того, в какой зоне поднялся процесс.
  await sql()`
    INSERT INTO invites (token, created_by, expires_at)
    VALUES (${token}, ${createdBy}, ${expiresAt.toISOString()})`;
}

/**
 * Гасит приглашение и выдаёт права одним запросом. Одним — потому что
 * у HTTP-драйвера каждый запрос сам себе транзакция: разбей это на «проверить»
 * и «добавить», и между ними влезал бы второй переход по той же ссылке.
 * Условие `used_by IS NULL` живёт в WHERE самого UPDATE, поэтому строку
 * заберёт ровно один из одновременных запросов, остальные увидят 0 строк —
 * и админ по ссылке появится ровно один.
 * Срок сверяем с NOW() базы, а не с часами приложения: они расходятся,
 * а лишние минуты жизни у ключа от админки не нужны.
 */
export async function redeemInvite(
  token: string,
  tgId: number,
  username: string | null,
): Promise<boolean> {
  const rows = (await sql()`
    WITH redeemed AS (
      UPDATE invites SET used_by = ${tgId}, used_at = NOW()
      WHERE token = ${token} AND used_by IS NULL AND expires_at > NOW()
      RETURNING token
    )
    INSERT INTO admins (tg_id, username)
    SELECT ${tgId}, ${username} FROM redeemed
    ON CONFLICT (tg_id) DO UPDATE SET username = EXCLUDED.username
    RETURNING tg_id`) as unknown[];
  return rows.length > 0;
}

/**
 * Кто выпустил уже погашенную ссылку — чтобы сообщить ему о входе.
 * Отдельным чтением после redeemInvite: атомарный запрос погашения ради
 * уведомления трогать нельзя, а строку с проставленным used_by больше никто
 * не заберёт, поэтому гонки здесь нет.
 */
export async function inviteCreator(token: string, usedBy: number): Promise<number | null> {
  const rows = (await sql()`
    SELECT created_by FROM invites
    WHERE token = ${token} AND used_by = ${usedBy}`) as { created_by: string }[];
  return rows[0] ? Number(rows[0].created_by) : null;
}

export type ActiveInvite = { created_by: number; created_at: string; expires_at: string };

/**
 * Живые приглашения — без самого токена. Ссылку показываем один раз, тому,
 * кто нажал кнопку: восстановимый из меню токен означал бы, что любой админ
 * может подобрать чужую невыданную ссылку и раздать права от своего имени.
 * Потерявшему ссылку дешевле отозвать её и выпустить новую.
 */
export async function listActiveInvites(): Promise<ActiveInvite[]> {
  const rows = (await sql()`
    SELECT created_by, created_at, expires_at FROM invites
    WHERE used_by IS NULL AND expires_at > NOW()
    ORDER BY created_at`) as { created_by: string; created_at: string; expires_at: string }[];
  return rows.map((r) => ({
    created_by: Number(r.created_by),
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

/**
 * Отзыв — это досрочный конец срока, а не пометка об использовании:
 * иначе в журнале появился бы used_by, которого на самом деле не было.
 */
export async function revokeInvites(): Promise<number> {
  const rows = (await sql()`
    UPDATE invites SET expires_at = NOW()
    WHERE used_by IS NULL AND expires_at > NOW()
    RETURNING token`) as unknown[];
  return rows.length;
}

export async function countActiveInvites(): Promise<number> {
  const rows = (await sql()`
    SELECT COUNT(*) AS count FROM invites
    WHERE used_by IS NULL AND expires_at > NOW()`) as { count: string }[];
  return Number(rows[0].count);
}

/* ---------- сайты ---------- */

/**
 * Все запросы к `sites` идут через `withSchema`. Эта таблица растёт вместе с
 * кодом (последним появился `via_local`), и выкладка новой версии не должна
 * выключать бота до тех пор, пока владелец вручную не откроет /api/setup:
 * первый же запрос сам докатит схему и повторится. Добавляете колонку в другую
 * таблицу — оберните её запросы так же.
 */

/** Со строк, добавленных до миграции, режим может прийти null — карточка сайта не должна падать. */
function withDefaults(row: Site): Site {
  return { ...row, search: row.search ?? { mode: "off" }, via_local: row.via_local ?? false };
}

export async function listSites(): Promise<Site[]> {
  const rows = (await withSchema(() => sql()`
    SELECT id, title, list_url, selectors, search, via_local, enabled, last_checked_at, last_error
    FROM sites ORDER BY id`)) as Site[];
  return rows.map(withDefaults);
}

export async function getSite(id: number): Promise<Site | null> {
  const rows = (await withSchema(() => sql()`
    SELECT id, title, list_url, selectors, search, via_local, enabled, last_checked_at, last_error
    FROM sites WHERE id = ${id}`)) as Site[];
  return rows[0] ? withDefaults(rows[0]) : null;
}

/**
 * Задания для домашнего сборщика: только включённые площадки, которые сервер
 * обойти не может. Выключенную площадку сборщику качать незачем — присланную
 * страницу приём всё равно отвергнет.
 */
export async function listLocalSites(): Promise<Site[]> {
  const rows = (await withSchema(() => sql()`
    SELECT id, title, list_url, selectors, search, via_local, enabled, last_checked_at, last_error
    FROM sites WHERE enabled AND via_local ORDER BY id`)) as Site[];
  return rows.map(withDefaults);
}

/**
 * `enabled` задаётся явно: сайт создаётся выключенным и включается уже после
 * первичного разбора. Иначе крон, стартовавший в эти секунды (а в режиме поиска
 * разбор длится до минуты), успел бы разослать всю историю площадки.
 */
export async function addSite(
  title: string,
  listUrl: string,
  selectors: Selectors,
  search: SiteSearch = { mode: "off" },
  enabled = true,
  viaLocal = false,
): Promise<Site> {
  const rows = (await withSchema(() => sql()`
    INSERT INTO sites (title, list_url, selectors, search, enabled, via_local)
    VALUES (${title}, ${listUrl}, ${JSON.stringify(selectors)}::jsonb, ${JSON.stringify(search)}::jsonb, ${enabled}, ${viaLocal})
    RETURNING id, title, list_url, selectors, search, via_local, enabled, last_checked_at, last_error`)) as Site[];
  return withDefaults(rows[0]);
}

/** Кто качает площадку: сервер или сборщик на компьютере владельца. */
export async function setSiteViaLocal(id: number, viaLocal: boolean): Promise<void> {
  await withSchema(() => sql()`UPDATE sites SET via_local = ${viaLocal} WHERE id = ${id}`);
}

/** Вёрстка площадки меняется — селекторы обновляем у той же строки, а не заводим второй сайт. */
export async function setSiteSelectors(id: number, selectors: Selectors): Promise<void> {
  await withSchema(
    () => sql()`UPDATE sites SET selectors = ${JSON.stringify(selectors)}::jsonb WHERE id = ${id}`,
  );
}

export async function setSiteSearch(id: number, search: SiteSearch): Promise<void> {
  await withSchema(
    () => sql()`UPDATE sites SET search = ${JSON.stringify(search)}::jsonb WHERE id = ${id}`,
  );
}

export async function setSiteEnabled(id: number, enabled: boolean): Promise<void> {
  await withSchema(() => sql()`UPDATE sites SET enabled = ${enabled} WHERE id = ${id}`);
}

export async function deleteSite(id: number): Promise<void> {
  await withSchema(() => sql()`DELETE FROM sites WHERE id = ${id}`);
}

export async function markSiteChecked(id: number, error: string | null): Promise<void> {
  await withSchema(
    () => sql()`UPDATE sites SET last_checked_at = NOW(), last_error = ${error} WHERE id = ${id}`,
  );
}

/* ---------- ключевые слова ---------- */

export async function listKeywords(): Promise<Keyword[]> {
  const rows = (await sql()`
    SELECT id, word, is_negative FROM keywords ORDER BY is_negative, word`) as Keyword[];
  return rows;
}

export async function addKeyword(word: string, isNegative: boolean): Promise<void> {
  await sql()`
    INSERT INTO keywords (word, is_negative) VALUES (${word}, ${isNegative})
    ON CONFLICT (word, is_negative) DO NOTHING`;
}

export async function deleteKeyword(id: number): Promise<void> {
  await sql()`DELETE FROM keywords WHERE id = ${id}`;
}

/* ---------- дедупликация ---------- */

/**
 * Записывает хэши позиций. Возвращает те, которых раньше не было —
 * ON CONFLICT DO NOTHING + RETURNING делает это атомарно, поэтому
 * параллельные запуски крона не пришлют дубли.
 */
export async function insertUnseen(
  siteId: number,
  items: { hash: string; title: string; url: string | null; matched: boolean }[],
): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const rows = (await sql()`
    INSERT INTO seen_items (site_id, item_hash, title, url, matched)
    SELECT ${siteId}, x.hash, x.title, x.url, x.matched
    FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb)
      AS x(hash TEXT, title TEXT, url TEXT, matched BOOLEAN)
    ON CONFLICT (site_id, item_hash) DO NOTHING
    RETURNING item_hash`) as { item_hash: string }[];
  return new Set(rows.map((r) => r.item_hash));
}

/**
 * Сколько позиций площадки уже помечено просмотренными. Ноль означает, что
 * площадку ещё ни разу не разбирали: её первый сбор нужно засеять, а не
 * разослать целиком.
 */
export async function countSeenItems(siteId: number): Promise<number> {
  const rows = (await sql()`
    SELECT COUNT(*) AS count FROM seen_items WHERE site_id = ${siteId}`) as { count: string }[];
  return Number(rows[0].count);
}

export async function stats(): Promise<{
  sites: number;
  keywords: number;
  seen: number;
  matched: number;
  last24h: number;
}> {
  const rows = (await sql()`
    SELECT
      (SELECT COUNT(*) FROM sites)                                             AS sites,
      (SELECT COUNT(*) FROM keywords WHERE NOT is_negative)                    AS keywords,
      (SELECT COUNT(*) FROM seen_items)                                        AS seen,
      (SELECT COUNT(*) FROM seen_items WHERE matched)                          AS matched,
      (SELECT COUNT(*) FROM seen_items WHERE matched
         AND found_at > NOW() - INTERVAL '24 hours')                           AS last24h`) as Record<
    string,
    string
  >[];
  const r = rows[0];
  return {
    sites: Number(r.sites),
    keywords: Number(r.keywords),
    seen: Number(r.seen),
    matched: Number(r.matched),
    last24h: Number(r.last24h),
  };
}

/* ---------- состояние диалога (в serverless нет памяти между запросами) ---------- */

export type DialogState = {
  state: string | null;
  payload: Record<string, unknown>;
};

export async function getState(tgId: number): Promise<DialogState> {
  const rows = (await sql()`
    SELECT state, payload FROM user_state WHERE tg_id = ${tgId}`) as DialogState[];
  return rows[0] ?? { state: null, payload: {} };
}

export async function setState(
  tgId: number,
  state: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await sql()`
    INSERT INTO user_state (tg_id, state, payload, updated_at)
    VALUES (${tgId}, ${state}, ${JSON.stringify(payload)}::jsonb, NOW())
    ON CONFLICT (tg_id) DO UPDATE
      SET state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = NOW()`;
}

export async function clearState(tgId: number): Promise<void> {
  await setState(tgId, null, {});
}
