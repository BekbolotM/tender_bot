/**
 * Разбор ссылок, присланных человеком. Отдельно от диалога: правила «что
 * считать ссылкой» нужны и в проверке текста, и в подсказках, и их удобно
 * проверять тестами без сети и без Telegram.
 */

/** Домен: хотя бы одна точка и осмысленная зона, иначе слово «привет» тоже пройдёт. */
const BARE_DOMAIN_RE = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(:\d+)?([/?#]\S*)?$/u;

export function parseUrl(input: string): string | null {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Строгая проверка «это ссылка» для сообщений вне диалога: `parseUrl`
 * достраивает схему и потому принимает любое слово без пробелов, а здесь ошибка
 * стоит дорого — бот полез бы качать страницу в ответ на обычный текст.
 */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return false;
  return /^https?:\/\/\S+$/i.test(trimmed) || BARE_DOMAIN_RE.test(trimmed);
}
