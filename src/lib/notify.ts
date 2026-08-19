import type { Api } from "grammy";
import type { ScrapedItem, Site } from "./types";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Одно уведомление о найденном тендере. */
export function formatItem(site: Site, item: ScrapedItem, hits: string[]): string {
  const lines = [`🎯 <b>${escapeHtml(truncate(item.title, 250))}</b>`];

  const meta = [
    item.price ? `💰 ${escapeHtml(item.price)}` : null,
    item.date ? `📅 ${escapeHtml(item.date)}` : null,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(" · "));

  if (hits.length) lines.push(`🔑 ${escapeHtml(hits.join(", "))}`);
  lines.push(`🌐 ${escapeHtml(site.title)}`);
  if (item.url) lines.push(`<a href="${escapeHtml(item.url)}">Открыть тендер</a>`);

  return lines.join("\n");
}

/**
 * Хвост рассылки, когда совпадений больше лимита. Название сайта — ввод админа,
 * а сообщение уходит с parse_mode HTML: без экранирования площадка с «<» в
 * названии роняла бы всё сообщение, и о потерянных совпадениях никто бы не узнал.
 */
export function overflowMessage(siteTitle: string, overflow: number): string {
  return `… и ещё ${overflow} совпадений на «${escapeHtml(siteTitle)}»`;
}

/**
 * Что показать про сайт, который ответил, но не полностью. Пустая строка тут
 * означала бы «проверка прошла успешно» и стёрла бы прошлую ошибку из карточки.
 */
export function partialCheckWarning(stats: {
  failed: number;
  total: number;
  fallback: boolean;
}): string | null {
  if (stats.fallback) return "через форму сайта ничего не разобралось — читаю страницу списка";
  if (stats.failed > 0) return `частично: ${stats.failed} из ${stats.total} адресов недоступны`;
  return null;
}

/**
 * Рассылает текст всем получателям. Telegram ограничивает ~30 сообщений
 * в секунду, поэтому между отправками пауза; ошибка одного получателя
 * (например, заблокировал бота) не должна ронять весь прогон.
 */
export async function broadcast(api: Api, targets: number[], text: string): Promise<void> {
  for (const chatId of targets) {
    try {
      await api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      console.error(`Не удалось отправить сообщение ${chatId}:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}
