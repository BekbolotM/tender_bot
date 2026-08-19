import { randomBytes } from "node:crypto";

/** Сколько живёт приглашение. Сутки — компромисс: успеть переслать, но не оставлять «вечный ключ». */
export const INVITE_TTL_HOURS = 24;

/** Префикс deep-link payload: по нему /start отличает приглашение от других сценариев. */
export const INVITE_PREFIX = "inv_";

/** Telegram принимает в параметре start не больше 64 символов алфавита A-Za-z0-9_-. */
const TELEGRAM_START_MAX = 64;
const TELEGRAM_START_ALPHABET = /^[A-Za-z0-9_-]+$/;

/**
 * Алфавит имени бота у Telegram: латиница, цифры и подчёркивание.
 * Проверяем до сборки URL: кавычка или пробел в имени (например, из кривого
 * BOT_USERNAME в env) уезжают внутрь href и рвут разметку сообщения.
 */
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{4,32}$/;

/** 16 байт = 128 бит энтропии: перебор ссылки, дающей права админа, невозможен. */
const TOKEN_BYTES = 16;

/**
 * Токен приглашения. Источник случайности только криптографический:
 * Math.random / Date.now / счётчики предсказуемы, а по ссылке выдаётся админка.
 * base64url уже даёт алфавит Telegram (без '=', '+' и '/'), перекодировать не нужно.
 */
export function newInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Собирает deep-link. Имя бота часто копируют из профиля вместе с '@',
 * поэтому лидирующую собаку снимаем сами, а не ругаемся на пользователя.
 */
export function inviteLink(botUsername: string, token: string): string {
  const username = botUsername.trim().replace(/^@+/, "");
  if (!username) throw new Error("Не задано имя бота — ссылку-приглашение не собрать.");
  if (!TELEGRAM_USERNAME.test(username)) {
    throw new Error(
      "Недопустимое имя бота: разрешены латиница, цифры и подчёркивание, 4–32 символа.",
    );
  }
  if (!token) throw new Error("Пустой токен приглашения.");
  return `https://t.me/${username}?start=${INVITE_PREFIX}${token}`;
}

/**
 * Достаёт токен из payload команды /start. Всё сомнительное отбраковывается
 * молча (null), чтобы вызывающий код не пытался искать мусор в базе.
 * Префикс сравнивается с учётом регистра: «Inv_» — это уже другой payload,
 * и неоднозначность здесь опаснее лишнего отказа.
 */
export function parseInvitePayload(payload: string | undefined | null): string | null {
  if (!payload) return null;

  const trimmed = payload.trim();
  if (trimmed.length > TELEGRAM_START_MAX) return null;
  if (!trimmed.startsWith(INVITE_PREFIX)) return null;

  const token = trimmed.slice(INVITE_PREFIX.length);
  if (!token || !TELEGRAM_START_ALPHABET.test(token)) return null;

  return token;
}

export function inviteExpiresAt(now: Date, ttlHours: number = INVITE_TTL_HOURS): Date {
  return new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
}

/**
 * Форма срока из базы зависит от драйвера и типа колонки: «2026-08-20T10:00:00.000Z»,
 * «2026-08-20 10:00:00+00», «2026-08-20 10:00:00» (timestamp without time zone).
 * Только этот набор форм и разбираем: `new Date(строка)` читает запись без
 * смещения как МЕСТНОЕ время процесса, и тогда истёкшее админ-приглашение живёт
 * лишними часами смещения хоста (а восточнее UTC — умирает раньше срока).
 */
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Postgres пишет смещение как «+00» или «+06:00» — Date.parse принимает только «+06:00». */
function normalizeZone(zone: string | undefined): string {
  if (!zone || zone.toUpperCase() === "Z") return "Z";
  const digits = zone.slice(1).replace(":", "");
  return `${zone[0]}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2, 4) : "00"}`;
}

function parseTimestamp(value: string): number {
  const parts = TIMESTAMP.exec(value.trim());
  if (!parts) return NaN;

  const [, date, time, fraction = "", zone] = parts;
  const seconds = time.length === 5 ? `${time}:00` : time;
  const millis = `${fraction}000`.slice(0, 3);
  // Смещение не указано — считаем UTC: timestamptz Postgres отдаёт уже в UTC,
  // а зона процесса к сроку приглашения отношения не имеет.
  return Date.parse(`${date}T${seconds}.${millis}${normalizeZone(zone)}`);
}

/**
 * Из базы срок приходит строкой, из кода — Date, поэтому принимаем оба.
 * Нераспознанная дата считается истёкшей: безопаснее отказать в правах,
 * чем выдать админку по битой записи.
 */
export function isInviteExpired(expiresAt: Date | string, now: Date): boolean {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : parseTimestamp(expiresAt);
  if (Number.isNaN(ms)) return true;
  return ms <= now.getTime();
}

/** Часовой пояс получателя нам неизвестен, поэтому показываем UTC и говорим об этом прямо. */
function formatUtc(date: Date): string {
  if (Number.isNaN(date.getTime())) return "неизвестно";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Экранирование дублируется намеренно: модуль обязан оставаться без зависимостей.
 * Кавычки экранируем в отличие от notify.ts: здесь результат идёт внутрь
 * атрибута href="…", где сырая кавычка закрывает атрибут раньше времени.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Сообщение для parse_mode: "HTML". Ссылка экранируется и в href, и в тексте:
 * неэкранированный '&' из query-строки ломает разметку, и Telegram отвергает всё сообщение.
 * Про одноразовость не пишем: погашение токена этот модуль не реализует и не может
 * гарантировать, а ложное «ссылка уже сгорела» отговаривает получателя просить отзыв.
 */
export function formatInviteMessage(link: string, expiresAt: Date): string {
  const safeLink = escapeHtml(link);
  return [
    "🔑 <b>Приглашение администратора</b>",
    "",
    `<a href="${safeLink}">${safeLink}</a>`,
    "",
    `⏳ Действует до <b>${escapeHtml(formatUtc(expiresAt))}</b>`,
    "⚠️ До конца срока ссылка даёт права администратора любому, кто по ней перейдёт. Не пересылайте её посторонним.",
  ].join("\n");
}
