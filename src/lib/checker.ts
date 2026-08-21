import { createHash } from "node:crypto";
import type { Api } from "grammy";
import { matchText, type MatchResult } from "./match";
import { broadcast, formatItem, overflowMessage, partialCheckWarning } from "./notify";
import {
  insertUnseen,
  listKeywords,
  listSites,
  markSiteChecked,
  notifyTargets,
} from "./repo";
import { extractItems, FETCH_TIMEOUT_MS, fetchHtml } from "./scrape";
import { keywordWindowOffset, searchUrlsFor } from "./searchurl";
import type { Keyword, ScrapedItem, Site } from "./types";

/** Чтобы одна шумная площадка не съела весь лимит времени и не заспамила чат. */
const MAX_NOTIFICATIONS_PER_SITE = 15;

/** Сколько ключевых слов за один прогон уходит в поиск сайта. */
const MAX_SEARCH_URLS = 8;

/**
 * При добавлении сайта берём меньше слов: разбор идёт внутри webhook-запроса,
 * и ответ Telegram нужен раньше, чем тот повторит апдейт.
 */
const SEED_SEARCH_URLS = 3;

/** Пауза между запросами к одной площадке: десяток поисков подряд не должен выглядеть как атака. */
const SEARCH_DELAY_MS = 300;

/** Сколько подошедших позиций показываем админу сразу после добавления сайта. */
const SEED_PREVIEW_LIMIT = 5;

/** Запас времени на разбор и рассылку сверх самого запроса. */
const SITE_OVERHEAD_MS = 5_000;

/** Сколько времени нужно, чтобы начинать сайт имело смысл: хотя бы один полный запрос. */
const MIN_SITE_BUDGET_MS = FETCH_TIMEOUT_MS + SITE_OVERHEAD_MS;

/** Ссылка стабильнее заголовка, но не у всех площадок она есть. */
function itemHash(item: ScrapedItem): string {
  return createHash("sha256").update(item.url ?? item.title).digest("hex").slice(0, 32);
}

type Evaluated = { item: ScrapedItem; hash: string; match: MatchResult };

/**
 * Считает хэши, схлопывает дубли и прогоняет позиции через ключевые слова.
 * Одно объявление легко попадает в разбор дважды — из выдачи поиска и со
 * страницы списка, — поэтому дубли снимаем здесь, до записи в базу.
 */
function evaluateItems(items: ScrapedItem[], keywords: Keyword[]): Evaluated[] {
  const byHash = new Map<string, Evaluated>();
  for (const item of items) {
    const hash = itemHash(item);
    if (byHash.has(hash)) continue;
    byHash.set(hash, { item, hash, match: matchText(`${item.title} ${item.text}`, keywords) });
  }
  return [...byHash.values()];
}

/** Записывает разобранное в «уже виденное» и возвращает хэши тех, кого там ещё не было. */
function recordItems(siteId: number, evaluated: Evaluated[]): Promise<Set<string>> {
  return insertUnseen(
    siteId,
    evaluated.map((entry) => ({
      hash: entry.hash,
      title: entry.item.title,
      url: entry.item.url,
      matched: entry.match.matched,
    })),
  );
}

/** Сколько позиций разобрано, сколько из них новых и о скольких сообщили. */
export type ProcessResult = { found: number; fresh: number; notified: number };

/**
 * Общая середина мониторинга: отсеять по ключевым словам, запомнить новое,
 * разослать подошедшее. Одинакова и для серверного обхода, и для страниц,
 * присланных домашним сборщиком, — раздваивать её нельзя, иначе площадки с
 * разным способом загрузки начали бы вести себя по-разному.
 *
 * Откуда взялся html, здесь уже не важно: на входе готовые позиции.
 * Отметку о проверке ставит вызывающий — только он знает, всё ли прочитал.
 */
export async function processScrapedItems(
  site: Site,
  items: ScrapedItem[],
  keywords: Keyword[],
  targets: number[],
  api: Api,
): Promise<ProcessResult> {
  const evaluated = evaluateItems(items, keywords);
  const freshHashes = await recordItems(site.id, evaluated);

  const toNotify = evaluated.filter((entry) => freshHashes.has(entry.hash) && entry.match.matched);

  for (const entry of toNotify.slice(0, MAX_NOTIFICATIONS_PER_SITE)) {
    await broadcast(api, targets, formatItem(site, entry.item, entry.match.hits));
  }

  const overflow = toNotify.length - MAX_NOTIFICATIONS_PER_SITE;
  if (overflow > 0) await broadcast(api, targets, overflowMessage(site.title, overflow));

  return { found: evaluated.length, fresh: freshHashes.size, notified: toNotify.length };
}

/**
 * Первый разбор площадки домашнего сборщика: то же, что делает seedSite для
 * обычных сайтов, только html уже принесли снаружи. Найденное помечается
 * просмотренным без единой рассылки — иначе установка сборщика заканчивалась бы
 * пачкой из полутора десятка сообщений про тендеры, которые владелец и так
 * видел на сайте.
 */
export async function seedScrapedItems(
  site: Site,
  items: ScrapedItem[],
  keywords: Keyword[],
): Promise<ProcessResult> {
  const evaluated = evaluateItems(items, keywords);
  const freshHashes = await recordItems(site.id, evaluated);
  return { found: evaluated.length, fresh: freshHashes.size, notified: 0 };
}

export type SiteResult = {
  site: string;
  found: number;
  fresh: number;
  notified: number;
  error?: string;
  /** Сайт ответил, но не весь: часть адресов недоступна или разбор пуст. */
  warning?: string;
};

/** Страницы, которые нужно разобрать за один прогон сайта. */
export function targetUrls(site: Site, keywords: Keyword[], limit = MAX_SEARCH_URLS): string[] {
  if (site.search?.mode !== "query") return [site.list_url];
  const positives = keywords
    .filter((keyword) => !keyword.is_negative)
    .map((keyword) => keyword.word);
  const offset = keywordWindowOffset(site.id, site.last_checked_at);
  return searchUrlsFor(site.search, positives, site.list_url, limit, offset);
}

type Collected = {
  items: ScrapedItem[];
  /** Сколько адресов не открылось: по ним покрытие ключевых слов потеряно. */
  failed: number;
  total: number;
  /** Пришлось читать страницу списка вместо выдачи поиска. */
  fallback: boolean;
};

/**
 * Обходит страницы сайта и склеивает позиции. Одно объявление легко попадает в
 * выдачу сразу по нескольким ключевым словам, поэтому дубли схлопываем по хэшу
 * здесь, до записи. Ошибка на одном URL не отменяет остальные — площадки часто
 * отдают 500 на отдельный запрос.
 *
 * Если через форму сайта не вышло ничего (все адреса упали или разбор пуст —
 * так бывает, когда форма принимает только POST или у выдачи своя вёрстка),
 * читаем обычную страницу списка. Иначе включение режима поиска полностью
 * останавливало бы мониторинг площадки, которая до этого работала.
 */
async function collectItems(site: Site, urls: string[], deadlineAt: number): Promise<Collected> {
  const byHash = new Map<string, ScrapedItem>();
  const errors: string[] = [];
  let visited = 0;

  const visit = async (url: string): Promise<void> => {
    visited += 1;
    try {
      const html = await fetchHtml(url);
      // Ссылки достраиваем от той страницы, откуда пришли: у выдачи поиска
      // и у страницы списка база может отличаться.
      for (const item of extractItems(html, url, site.selectors)) {
        const hash = itemHash(item);
        if (!byHash.has(hash)) byHash.set(hash, item);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  };

  for (const [index, url] of urls.entries()) {
    // Прогон крона ограничен по времени, а один запрос может занять весь таймаут:
    // начинаем следующий адрес, только если он успеет закончиться до дедлайна.
    if (index > 0 && Date.now() + FETCH_TIMEOUT_MS > deadlineAt) break;
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS));
    await visit(url);
  }

  const useFallback = byHash.size === 0 && !urls.includes(site.list_url);
  if (useFallback) await visit(site.list_url);

  if (byHash.size === 0 && errors.length > 0) throw new Error(errors[0]);

  return {
    items: [...byHash.values()],
    failed: errors.length,
    total: visited,
    fallback: useFallback,
  };
}

export type SeedResult = {
  found: number;
  matched: number;
  /** Сколько положительных ключевых слов было на момент разбора. */
  keywords: number;
  /** Подошедшие позиции для превью: по ним админ сразу видит, что ловит бот. */
  preview: ScrapedItem[];
  /** Разбор шёл по странице списка, а не по выдаче поиска. */
  fallback: boolean;
};

/**
 * Первый разбор сайта: заносит найденное в «уже виденное» и возвращает сводку.
 * Без пометки добавление сайта тут же выстрелило бы сотней старых тендеров,
 * а без сводки админ не понял бы, ловят ли что-нибудь его ключевые слова.
 */
export async function seedSite(site: Site, deadlineMs = 45_000): Promise<SeedResult> {
  const keywords = await listKeywords();
  const deadlineAt = Date.now() + deadlineMs;

  let collected: Collected;
  try {
    collected = await collectItems(site, targetUrls(site, keywords, SEED_SEARCH_URLS), deadlineAt);
  } catch (error) {
    // Пишем ошибку в карточку сайта, иначе она осталась бы только в сообщении
    // о добавлении, а сайт выглядел бы ни разу не проверенным.
    await markSiteChecked(site.id, error instanceof Error ? error.message : String(error));
    throw error;
  }

  const evaluated = evaluateItems(collected.items, keywords);

  await recordItems(site.id, evaluated);
  await markSiteChecked(site.id, partialCheckWarning(collected));

  const matched = evaluated.filter((entry) => entry.match.matched);
  return {
    found: collected.items.length,
    matched: matched.length,
    keywords: keywords.filter((keyword) => !keyword.is_negative).length,
    preview: matched.slice(0, SEED_PREVIEW_LIMIT).map((entry) => entry.item),
    fallback: collected.fallback,
  };
}

async function checkSite(
  api: Api,
  site: Site,
  keywords: Keyword[],
  targets: number[],
  deadlineAt: number,
): Promise<SiteResult> {
  const collected = await collectItems(site, targetUrls(site, keywords), deadlineAt);
  const processed = await processScrapedItems(site, collected.items, keywords, targets, api);

  // Частичный отказ не должен выглядеть как удачная проверка: иначе прошлая
  // ошибка стирается, и админ не узнает, что покрытие по словам просело.
  const warning = partialCheckWarning(collected);
  await markSiteChecked(site.id, warning);

  return { site: site.title, ...processed, ...(warning ? { warning } : {}) };
}

/**
 * Обходит все включённые сайты. Падение одного не мешает остальным,
 * а дедлайн не даёт превысить лимит времени serverless-функции: он же
 * передаётся внутрь обхода сайта, потому что в режиме поиска один сайт —
 * это до восьми запросов, а не один.
 *
 * Площадки домашнего сборщика сервер пропускает молча: с адреса дата-центра
 * они отдают проверку браузера, и каждый прогон вешал бы на карточку ошибку,
 * затирая настоящий результат последнего сбора с компьютера владельца.
 */
export async function runCheck(api: Api, deadlineMs = 240_000): Promise<SiteResult[]> {
  const deadlineAt = Date.now() + deadlineMs;
  const [sites, keywords, targets] = await Promise.all([
    listSites(),
    listKeywords(),
    notifyTargets(),
  ]);

  const results: SiteResult[] = [];

  for (const site of sites.filter((s) => s.enabled && !s.via_local)) {
    if (deadlineAt - Date.now() < MIN_SITE_BUDGET_MS) {
      results.push({
        site: site.title,
        found: 0,
        fresh: 0,
        notified: 0,
        error: "пропущен: закончилось время прогона",
      });
      continue;
    }
    try {
      results.push(await checkSite(api, site, keywords, targets, deadlineAt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markSiteChecked(site.id, message);
      results.push({ site: site.title, found: 0, fresh: 0, notified: 0, error: message });
    }
  }

  return results;
}
