/**
 * Нарезка длинных списков на страницы. Живёт отдельно от меню, потому что
 * ограничение здесь жёсткое: Telegram отвергает слишком большую разметку
 * целиком, и меню на две сотни ключевых слов просто переставало открываться,
 * а удалить лишнее через интерфейс было уже нечем.
 */

/** Сколько кнопок-строк показываем за раз. */
export const PAGE_SIZE = 20;

export type Page<T> = {
  items: T[];
  /** Начало показанной страницы — уходит в callback_data кнопок листания. */
  from: number;
  /** Подпись «показаны N–M из K»; пусто, когда всё поместилось на одну страницу. */
  note: string;
};

/** Смещение приходит из callback_data: чужое или устаревшее — прижимаем к границам. */
export function page<T>(all: T[], offset: number, size = PAGE_SIZE): Page<T> {
  const last = all.length > 0 ? Math.floor((all.length - 1) / size) * size : 0;
  const from = Math.min(Math.max(Number.isFinite(offset) ? offset : 0, 0), last);
  const items = all.slice(from, from + size);
  const note = all.length > size ? `\nПоказаны ${from + 1}–${from + items.length} из ${all.length}.` : "";
  return { items, from, note };
}
