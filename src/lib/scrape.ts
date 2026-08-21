import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ScrapedItem, Selectors } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Потолок ожидания одной страницы. Из него checker считает, влезет ли ещё один запрос в прогон. */
export const FETCH_TIMEOUT_MS = 20_000;
const MAX_ITEMS = 200;

/**
 * Качает страницу и декодирует её с учётом кодировки: тендерные площадки
 * СНГ до сих пор часто отдают windows-1251, и без этого заголовки
 * превращаются в кракозябры.
 */
export async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "ru,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const buffer = await response.arrayBuffer();
  const headerCharset = /charset=([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  const asUtf8 = new TextDecoder("utf-8").decode(buffer);
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(asUtf8.slice(0, 2000))?.[1];
  const charset = (headerCharset ?? metaCharset ?? "utf-8").toLowerCase();

  if (charset === "utf-8" || charset === "utf8") return asUtf8;
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return asUtf8;
  }
}

function textOf(node: cheerio.Cheerio<AnyNode>): string {
  return node.text().replace(/\s+/g, " ").trim();
}

/** И дата, и цена — это всегда числа. На этом держится отсечение подписей ниже. */
const HAS_DIGIT = /\d/;

/**
 * Значение даты или цены из ячейки карточки. От `textOf` отличается двумя
 * вещами, которые человек на странице видит, а разметка прячет:
 *
 * 1. Перенос строки он читает как пробел. Без этого ячейка вида
 *    `2026-08-21<br>16:40:31` уходила бы в уведомление как «2026-08-2116:40:31».
 * 2. Подпись колонки часто лежит в той же ячейке, что и само значение:
 *    `<span>Срок подачи предложений поставщиков</span>24.08.2026 17:41`. Так
 *    делают таблицы, которые умеют перестраиваться под узкий экран. У значения
 *    своего элемента нет, поэтому отсечь подпись правилом разбора нельзя — и в
 *    уведомление шла склейка «Срок подачи предложений поставщиков24.08.2026».
 *
 * Подписью считаем только элемент в самом начале ячейки, в котором нет ни одной
 * цифры. Убрать вместе с ним значение такое правило не может: в выброшенном
 * куске цифр не было, а значит цифры остались там, где и были.
 */
function fieldText(node: cheerio.Cheerio<AnyNode>): string {
  if (node.length === 0) return "";

  const cell = node.first().clone();
  cell.find("br").replaceWith(" ");

  if (HAS_DIGIT.test(cell.text())) {
    let head = cell.children().first();
    while (head.length > 0 && !HAS_DIGIT.test(head.text())) {
      head.remove();
      head = cell.children().first();
    }
  }

  return textOf(cell);
}

/**
 * Ссылка уходит в `<a href>` уведомления, а Telegram отвергает всё сообщение
 * целиком, если протокол не http(s). Заглушки вида `javascript:void(0)` на
 * площадках JSF/PrimeFaces — норма, поэтому отсекаем их прямо здесь: без ссылки
 * уведомление всё равно уйдёт, а с битой — не ушло бы совсем.
 */
function absoluteUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Имя хоста не проходит процентное кодирование: кавычка внутри него доживает
    // до `href="…"` в уведомлении и рвёт тег. Настоящее доменное имя (в том числе
    // записанное punycode) состоит только из букв, цифр, точки и дефиса.
    if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Достаёт позиции со страницы по сохранённым селекторам. */
export function extractItems(html: string, baseUrl: string, selectors: Selectors): ScrapedItem[] {
  const $ = cheerio.load(html);
  const items: ScrapedItem[] = [];

  $(selectors.item)
    .slice(0, MAX_ITEMS)
    .each((_, element) => {
      const card = $(element);
      const linkNode = selectors.link ? card.find(selectors.link).first() : card.find("a").first();

      let title = selectors.title ? textOf(card.find(selectors.title).first()) : "";
      if (!title) title = textOf(linkNode);
      if (!title) title = textOf(card).slice(0, 300);
      if (!title) return;

      const href = linkNode.attr("href") ?? (card.is("a") ? card.attr("href") : undefined);

      items.push({
        title,
        url: absoluteUrl(href, baseUrl),
        date: selectors.date ? fieldText(card.find(selectors.date)) || null : null,
        price: selectors.price ? fieldText(card.find(selectors.price)) || null : null,
        text: textOf(card).slice(0, 2000),
      });
    });

  return items;
}

/* ---------- автоподбор селекторов ---------- */

const NOISE_CONTAINERS = new Set(["nav", "header", "footer", "aside"]);

/** Классы навигации: меню, хлебные крошки, пагинация — это не тендеры. */
const NOISE_CLASS_RE =
  /(^|[-_])(nav|navbar|menu|dropdown|breadcrumb|pagination|pager|sidebar|social|lang)([-_]|$)/i;

/**
 * `header` и `footer` в конце класса — это чаще всего часть карточки
 * (`search-result-header`, `card-header`), а не шапка страницы, поэтому такие
 * классы считаем навигацией только когда слово стоит в начале.
 */
const CHROME_CLASS_RE = /^(site|page|top|main|global)?[-_]?(header|footer)([-_]|$)/i;

/** Классы вида `css-1x9d8h` или очень длинные — не опора, они меняются от сборки к сборке. */
function isStableClass(cls: string): boolean {
  return cls.length <= 30 && !/^(css|sc)-[a-z0-9]{4,}$/i.test(cls) && !/^\d/.test(cls);
}

function classesOf(element: Element): string[] {
  return (element.attribs?.class ?? "").split(/\s+/).filter(Boolean);
}

function stableClasses(element: Element): string[] {
  return classesOf(element).filter(isStableClass).slice(0, 2);
}

function selectorFor(element: Element): string {
  const classes = stableClasses(element);
  return classes.length ? `${element.tagName}.${classes.join(".")}` : element.tagName;
}

/** Структурная подпись ссылки: её путь вверх по дереву без индексов. */
function signature($: cheerio.CheerioAPI, link: Element): string {
  const parts: string[] = [selectorFor(link)];
  let current = link.parent as Element | null;
  for (let depth = 0; depth < 4 && current && current.tagName; depth += 1) {
    parts.unshift(selectorFor(current));
    current = current.parent as Element | null;
  }
  return parts.join(" > ");
}

function hasNoiseClass(element: Element): boolean {
  const role = element.attribs?.role ?? "";
  if (role === "navigation" || role === "menu") return true;
  // Классы проверяем поодиночке: CHROME_CLASS_RE привязан к началу строки.
  return classesOf(element).some((cls) => NOISE_CLASS_RE.test(cls) || CHROME_CLASS_RE.test(cls));
}

/**
 * Предки блока с основным содержимым. На живых страницах `role="navigation"`
 * нередко висит на обёртке всей страницы (шторка бокового меню), и без этого
 * исключения весь список тендеров считался бы навигацией.
 */
function contentWrappers($: cheerio.CheerioAPI): Set<Element> {
  const wrappers = new Set<Element>();
  for (const main of $("main, [role=main], #content, #main").toArray()) {
    let node = (main as Element).parent as Element | null;
    while (node && node.tagName) {
      wrappers.add(node);
      node = node.parent as Element | null;
    }
  }
  return wrappers;
}

function insideNoise(element: Element, wrappers: Set<Element>): boolean {
  if (hasNoiseClass(element)) return true;
  let current = element.parent as Element | null;
  while (current && current.tagName) {
    if (!wrappers.has(current) && (NOISE_CONTAINERS.has(current.tagName) || hasNoiseClass(current))) {
      return true;
    }
    current = current.parent as Element | null;
  }
  return false;
}

export type SelectorCandidate = {
  selectors: Selectors;
  count: number;
  preview: ScrapedItem[];
};

/** Минимальный размер группы: три одинаковых блока подряд — уже список. */
const MIN_GROUP = 3;

/** Заголовок карточки: короче — это подпись поля, длиннее — описание целиком. */
const TITLE_MIN_LENGTH = 15;
const TITLE_MAX_LENGTH = 200;

/** Блок короче — это пункт меню или подпись, а не карточка тендера. */
const MIN_BLOCK_TEXT = 40;

/** Сколько повторяющихся блоков доводим до разбора: дальше идёт заведомый мусор. */
const MAX_BLOCKS_CHECKED = 12;

/**
 * Пытается сам понять, где на странице список тендеров. Два прохода: сперва по
 * ссылкам с осмысленным текстом (так устроено большинство лент), затем по
 * повторяющимся блокам — строкам таблицы и однотипным карточкам, где заголовок
 * ссылкой не является, а ссылка спрятана в иконке. Возвращает несколько
 * вариантов — админ подтверждает нужный по превью.
 */
export function detectSelectors(html: string, baseUrl: string, limit = 3): SelectorCandidate[] {
  const $ = cheerio.load(html);
  const candidates: SelectorCandidate[] = [];

  const add = (selectors: Selectors | null): void => {
    if (!selectors || candidates.length >= limit) return;
    if (candidates.some((c) => c.selectors.item === selectors.item)) return;
    const items = extractItems(html, baseUrl, selectors);
    if (items.length < MIN_GROUP) return;
    candidates.push({ selectors, count: items.length, preview: items.slice(0, 3) });
  };

  const wrappers = contentWrappers($);
  for (const group of linkGroups($, wrappers, limit * 2)) add(buildSelectors($, group));
  if (candidates.length < limit) {
    for (const block of repeatedBlocks($, wrappers)) add(blockSelectors($, block));
  }

  return candidates;
}

/** Первый проход: группы структурно одинаковых ссылок с длинным текстом. */
function linkGroups($: cheerio.CheerioAPI, wrappers: Set<Element>, limit: number): Element[][] {
  const groups = new Map<string, Element[]>();

  $("a[href]").each((_, element) => {
    const link = element as Element;
    if (insideNoise(link, wrappers)) return;
    const text = textOf($(link));
    if (text.length < TITLE_MIN_LENGTH) return;
    const href = link.attribs?.href ?? "";
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    const key = signature($, link);
    const bucket = groups.get(key);
    if (bucket) bucket.push(link);
    else groups.set(key, [link]);
  });

  // Длинные заголовки — признак настоящего списка объявлений, а не навигации,
  // поэтому размер группы взвешиваем средней длиной текста ссылки.
  const score = (group: Element[]): number => {
    const lengths = group.map((link) => textOf($(link)).length);
    const average = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    return group.length * Math.min(average, 120);
  };

  return [...groups.values()]
    .filter((group) => group.length >= MIN_GROUP)
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

/** Поднимается от ссылки вверх, пока селектор предка описывает всю группу целиком. */
function buildSelectors($: cheerio.CheerioAPI, group: Element[]): Selectors | null {
  const first = group[0];
  const linkSelector = selectorFor(first).includes(".") ? selectorFor(first) : "a";

  let card: Element | null = null;
  let node = first.parent as Element | null;
  for (let depth = 0; depth < 4 && node && node.tagName; depth += 1) {
    const candidate = selectorFor(node);
    if (candidate.includes(".")) {
      const matchedCount = $(candidate).length;
      // Поднимаемся до самого внешнего предка, который всё ещё описывает группу
      // один в один: дата и цена часто лежат вне заголовочного блока.
      if (matchedCount >= group.length * 0.8 && matchedCount <= group.length * 1.5) card = node;
      else if (card) break;
    }
    node = node.parent as Element | null;
  }

  if (card) {
    return {
      item: selectorFor(card),
      title: linkSelector,
      link: linkSelector,
      ...sniffExtras($, card),
    };
  }

  // Ни один предок не подошёл — работаем по самим ссылкам как по «карточкам».
  const own = selectorFor(first);
  return own.includes(".") ? { item: own } : null;
}

type Block = { item: string; cards: Element[] };

/** Ссылка, по которой карточку можно открыть: якоря и js-заглушки не в счёт. */
function hasRealLink($: cheerio.CheerioAPI, card: Element): boolean {
  return $(card)
    .find("a[href]")
    .toArray()
    .some((link) => {
      const href = (link as Element).attribs?.href ?? "";
      return href !== "" && !href.startsWith("#") && !href.startsWith("javascript:");
    });
}

/**
 * Второй проход: повторяющиеся соседние блоки одного тега. Так свёрстаны
 * площадки, где заголовок не ссылка (`<p>` внутри карточки) или где вся ссылка —
 * иконка без текста: первый проход их не видит, потому что опирается на текст `<a>`.
 */
function repeatedBlocks($: cheerio.CheerioAPI, wrappers: Set<Element>): Block[] {
  const blocks: { block: Block; weight: number }[] = [];

  $("body *").each((_, element) => {
    const parent = element as Element;
    if (insideNoise(parent, wrappers)) return;

    const byTag = new Map<string, Element[]>();
    for (const child of parent.children) {
      const node = child as Element;
      if (!node.tagName) continue;
      const bucket = byTag.get(node.tagName);
      if (bucket) bucket.push(node);
      else byTag.set(node.tagName, [node]);
    }

    for (const cards of byTag.values()) {
      if (cards.length < MIN_GROUP) continue;

      const lengths = cards.map((card) => textOf($(card)).length);
      const average = lengths.reduce((sum, value) => sum + value, 0) / cards.length;
      // Короткие блоки — это меню и подписи; без ссылки тендер не открыть.
      if (average < MIN_BLOCK_TEXT) continue;
      if (cards.filter((card) => hasRealLink($, card)).length * 2 < cards.length) continue;

      const item = blockSelector($, parent, cards);
      if (item) blocks.push({ block: { item, cards }, weight: cards.length * Math.min(average, 400) });
    }
  });

  return blocks
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_BLOCKS_CHECKED)
    .map((entry) => entry.block);
}

/** Классы, которые есть у всех блоков группы: у строк таблицы половина классов чередуется. */
function sharedClasses(cards: Element[]): string[] {
  const [first, ...rest] = cards;
  return classesOf(first)
    .filter((cls) => rest.every((card) => classesOf(card).includes(cls)))
    .filter(isStableClass)
    .slice(0, 2);
}

/** Селектор, который выбирает ровно эти блоки и ничего сверх них. */
function blockSelector($: cheerio.CheerioAPI, parent: Element, cards: Element[]): string | null {
  const shared = sharedClasses(cards);
  const own = shared.length ? `${cards[0].tagName}.${shared.join(".")}` : cards[0].tagName;
  if ($(own).length === cards.length) return own;

  // Классы блока встречаются и вне списка (`div.row` у Bootstrap) — сужаем родителем.
  const parentSelector = selectorFor(parent);
  if (!parentSelector.includes(".")) return null;
  const scoped = `${parentSelector} > ${own}`;
  return $(scoped).length === cards.length ? scoped : null;
}

/**
 * Заголовок повторяющегося блока: самый длинный текстовый узел, который
 * встречается в карточке ровно один раз. Требование единственности отсекает
 * ячейки-описания, которых в карточке много и любая из них подошла бы по длине.
 */
function blockTitle($: cheerio.CheerioAPI, card: Element): string | undefined {
  let best: { selector: string; weight: number } | null = null;

  $(card)
    .find("*")
    .each((_, element) => {
      const node = element as Element;
      if (node.children.some((child) => (child as Element).tagName)) return;
      const selector = selectorFor(node);
      if (!selector.includes(".")) return;

      const text = textOf($(node));
      if (text.length < TITLE_MIN_LENGTH || text.length > TITLE_MAX_LENGTH) return;
      if ($(card).find(selector).length !== 1) return;

      const heading = /^h[1-5]$/.test(node.tagName) || node.attribs?.role === "heading";
      const weight = text.length + (heading ? 1000 : 0);
      if (!best || weight > best.weight) best = { selector, weight };
    });

  return (best as { selector: string } | null)?.selector;
}

function blockSelectors($: cheerio.CheerioAPI, block: Block): Selectors {
  const title = blockTitle($, block.cards[0]);
  // Ссылку не задаём: в таких карточках она одна и `extractItems` возьмёт первую.
  return { item: block.item, ...(title ? { title } : {}), ...sniffExtras($, block.cards[0]) };
}

const DATE_RE = /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/;
const PRICE_RE = /\d[\d\s.,]{2,}\s*(сом|тг|руб|₽|kgs|kzt|rub|usd|\$|тенге|сум)/i;

/** Ищет внутри карточки дату и цену — это то, что админ хочет видеть в уведомлении. */
function sniffExtras($: cheerio.CheerioAPI, card: Element): Partial<Selectors> {
  const extras: Partial<Selectors> = {};

  $(card)
    .find("*")
    .each((_, element) => {
      const node = element as Element;
      const text = textOf($(node));
      if (!text || text.length > 60) return;
      const selector = selectorFor(node);
      if (!selector.includes(".")) return;
      if (!extras.date && DATE_RE.test(text)) extras.date = selector;
      if (!extras.price && PRICE_RE.test(text)) extras.price = selector;
    });

  return extras;
}

/** Ссылка с текстом такой длины — уже заголовок или пункт меню, а не «читать далее». */
const MEANINGFUL_LINK_TEXT = 15;

/** Меньше осмысленных ссылок — на странице просто нечего разбирать, чем бы её ни рисовали. */
const MIN_MEANINGFUL_LINKS = 5;

/** `detectSelectors` нужен базовый адрес только чтобы достроить ссылки в превью. */
const PROBE_BASE_URL = "https://probe.local/";

/**
 * Подсказка для случая, когда автоподбор ничего не нашёл: на площадках вроде
 * PrimeFaces/JSF или React список приходит отдельным ajax-запросом, и в
 * исходном HTML его просто нет — тогда селекторы не спасут.
 *
 * Наличие списка сильнее любых маркеров фреймворка. Скрипты PrimeFaces или
 * React на странице говорят лишь о том, чем сделан сайт, а не о том, откуда
 * взялся список: `zakupki.gov.kg` тянет за собой всю обвязку PrimeFaces, но
 * строки таблицы отдаёт готовыми, и разбираются они прекрасно. Поэтому сперва
 * спрашиваем тот же детектор, который потом и будет читать площадку: если он
 * что-то нашёл, подсказка про JavaScript была бы прямым обманом.
 */
export function looksJavaScriptRendered(html: string): boolean {
  if (detectSelectors(html, PROBE_BASE_URL, 1).length > 0) return false;

  const $ = cheerio.load(html);
  const meaningfulLinks = $("a[href]").filter(
    (_, el) => textOf($(el)).length >= MEANINGFUL_LINK_TEXT,
  ).length;
  const hasSpaMarkers =
    /<script[^>]+(primefaces|jsf\.js|react|vue|angular|nuxt|__NEXT_DATA__)/i.test(html) ||
    $("#root, #app, [data-reactroot], [ng-app]").length > 0;
  return meaningfulLinks < MIN_MEANINGFUL_LINKS || hasSpaMarkers;
}
