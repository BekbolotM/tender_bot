import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { extractItems, type SelectorCandidate } from "./scrape.ts";
import type { ScrapedItem, Selectors } from "./types.ts";

/**
 * Подбор селекторов по образцу текста. Человек не знает, что такое CSS-селектор,
 * зато видит страницу: он копирует заголовок любого тендера и присылает его.
 * Дальше дело техники — найти этот текст в HTML и понять, каким правилом
 * описывается весь список.
 */

/* ---------- образец ---------- */

/** Мягкий перенос и нулевой пробел на экране не видны, но приезжают из буфера обмена. */
const INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

/** Короче — это слово-другое, такой образец совпадёт где угодно, вплоть до пункта меню. */
const MIN_SIGNIFICANT_CHARS = 8;

/**
 * Одно слово порог по символам проходит («Строительство» — 13), а совпадает всё
 * равно где угодно: в меню категорий, в хлебных крошках, в подписи фильтра.
 * Заголовок тендера — это всегда несколько слов, поэтому требуем их отдельно.
 */
const MIN_WORDS = 2;

/** Насколько текст обязан совпасть с образцом, если человек копировал неаккуратно. */
const MIN_SIMILARITY = 0.85;

type Sample = { text: string; words: string[] };

/**
 * Приводит текст к виду, где сравнение не зависит от того, как выделяли мышью.
 * `\s` в JS покрывает и nbsp, поэтому отдельно вычищаем только по-настоящему
 * невидимые символы, которые иначе разорвут совпадение посреди слова.
 */
function normalizeText(text: string): string {
  return text
    .replace(INVISIBLE_RE, "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsOf(normalized: string): string[] {
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function prepareSample(sample: string): Sample | null {
  const text = normalizeText(sample);
  const words = wordsOf(text);
  const significant = words.reduce((sum, word) => sum + word.length, 0);
  const enough = significant >= MIN_SIGNIFICANT_CHARS && words.length >= MIN_WORDS;
  return enough ? { text, words } : null;
}

/** Доля общих слов относительно более длинного текста: 1 — тексты совпали. */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const pool = new Map<string, number>();
  for (const word of a) pool.set(word, (pool.get(word) ?? 0) + 1);

  let common = 0;
  for (const word of b) {
    const left = pool.get(word) ?? 0;
    if (left > 0) {
      pool.set(word, left - 1);
      common += 1;
    }
  }
  return common / Math.max(a.length, b.length);
}

/**
 * Текст похож на образец, если содержит его целиком (скопировали ровно заголовок
 * или прихватили соседнюю дату) либо совпадает почти дословно (прихватили кнопку
 * «Подробнее» или обрезали хвост).
 */
function looksLikeSample(text: string, sample: Sample): boolean {
  if (!text) return false;
  if (text.includes(sample.text)) return true;
  return similarity(wordsOf(text), sample.words) >= MIN_SIMILARITY;
}

/* ---------- работа с деревом ---------- */

const SKIP_TAGS = new Set(["script", "style", "noscript", "head", "html"]);

/** Сколько мест, где нашёлся образец, доводим до разбора. */
const MAX_ANCHORS = 6;

/** Карточка — это повтор: сам элемент и ещё хотя бы двое таких же соседей. */
const MIN_GROUP = 3;

/** Насколько высоко поднимаемся от образца в поисках карточки. */
const MAX_CLIMB = 8;

/** Длина пути в селекторе: дальше он описывает уже вёрстку страницы, а не карточку. */
const MAX_PATH = 4;

/**
 * Доля карточек, в которых селектор обязан указывать ровно на один узел. Просто
 * «есть хоть что-то» мало: в списке, где у половины карточек перед заголовком
 * стоит иконка-ссылка на документ, селектор `a` в каждой второй позиции укажет
 * на неё, и в уведомление уедет «PDF» вместо названия тендера.
 */
const MIN_COVERAGE = 0.8;

/** Найденных позиций должно быть больше одной — одна позиция списком не является. */
const MIN_ITEMS = 2;

function textOf($: cheerio.CheerioAPI, element: Element): string {
  return normalizeText($(element).text());
}

function depthOf(element: Element): number {
  let depth = 0;
  for (let node = element.parent as Element | null; node; node = node.parent as Element | null) {
    depth += 1;
  }
  return depth;
}

/**
 * Классы вида `css-1a2b3c` меняются от сборки к сборке, а неименные (цифра в
 * начале, спецсимволы) ещё и требуют экранирования в селекторе — опираться
 * ни на те, ни на другие нельзя.
 */
function isStableClass(cls: string): boolean {
  return cls.length <= 30 && /^[a-z_][\w-]*$/i.test(cls) && !/^(css|sc)-[a-z0-9]{4,}$/i.test(cls);
}

function stableClasses(element: Element): string[] {
  return (element.attribs?.class ?? "").split(/\s+/).filter(Boolean).filter(isStableClass);
}

function descriptorOf(element: Element, classes: string[] = stableClasses(element)): string {
  const used = classes.slice(0, 2);
  return used.length ? `${element.tagName}.${used.join(".")}` : element.tagName;
}

/**
 * Соседи, похожие структурно: тот же тег и общий устойчивый класс. Сравниваем
 * пересечением, а не списками целиком, потому что у строк таблицы половина
 * классов чередуется — `odd`/`even`.
 */
function similarSiblings(element: Element): Element[] {
  const parent = element.parent as Element | null;
  if (!parent?.children) return [element];

  const own = new Set(stableClasses(element));
  return parent.children.filter((child): child is Element => {
    const node = child as Element;
    if (!node.tagName || node.tagName !== element.tagName) return false;
    const classes = stableClasses(node);
    return own.size === 0 ? classes.length === 0 : classes.some((cls) => own.has(cls));
  });
}

/** Классы, которые есть у всех карточек группы. */
function sharedClasses(group: Element[]): string[] {
  const [first, ...rest] = group;
  return stableClasses(first).filter((cls) =>
    rest.every((card) => stableClasses(card).includes(cls)),
  );
}

function selects($: cheerio.CheerioAPI, selector: string): Element[] {
  try {
    return $(selector).toArray() as Element[];
  } catch {
    return [];
  }
}

/**
 * Селектор карточки: сперва по её собственным классам, а если они встречаются и
 * вне списка (`div.row` у Bootstrap) — сужаем предками. Селектор обязан выбирать
 * ровно найденную группу, поэтому сверяем не количество, а сами элементы.
 *
 * Голый тег (`li`, `section`, `div`) сегодня может совпасть с группой один в
 * один просто потому, что других таких на странице нет. Завтра площадка добавит
 * меню в подвале — и его пункты уедут человеку как новые тендеры, поэтому такой
 * селектор берём только последней опорой, уже перепробовав путь с предком.
 */
function buildItemSelector($: cheerio.CheerioAPI, card: Element, group: Element[]): string | null {
  const exact = (selector: string): boolean => {
    const found = selects($, selector);
    return found.length === group.length && group.every((el) => found.includes(el));
  };

  let path = descriptorOf(card, sharedClasses(group));
  const bare = exact(path) ? path : null;
  if (bare?.includes(".")) return bare;

  // Выше <body> не поднимаемся: правило, привязанное к корню страницы, описывает
  // макет, а не список, и на следующей странице оно рассыпается.
  let node = card.parent as Element | null;
  for (let depth = 0; depth < MAX_PATH && node?.tagName && node.tagName !== "body"; depth += 1) {
    path = `${descriptorOf(node)} > ${path}`;
    if (exact(path)) return path;
    node = node.parent as Element | null;
  }

  return bare;
}

/** Номер тега среди таких же соседей: колонка таблицы не съезжает от страницы к странице. */
function nthSelector(element: Element): string {
  const parent = element.parent as Element | null;
  const same = (parent?.children ?? []).filter(
    (child) => (child as Element).tagName === element.tagName,
  );
  const index = same.indexOf(element) + 1;
  return same.length > 1 && index > 0
    ? `${descriptorOf(element)}:nth-of-type(${index})`
    : descriptorOf(element);
}

/** Путь до элемента по позициям тегов — последняя опора, когда классов нет вовсе. */
function positionalPath(card: Element, target: Element): string | null {
  const parts: string[] = [];
  let node: Element | null = target;
  for (let depth = 0; depth < MAX_PATH && node?.tagName && node !== card; depth += 1) {
    parts.unshift(nthSelector(node));
    node = node.parent as Element | null;
  }
  return node === card ? parts.join(" > ") : null;
}

function selectsTarget(
  $: cheerio.CheerioAPI,
  card: Element,
  selector: string,
  target: Element,
): boolean {
  try {
    const found = $(card).find(selector).toArray();
    return found.length === 1 && found[0] === target;
  } catch {
    return false;
  }
}

/**
 * Селекторы элемента внутри карточки, от самого короткого: теги и устойчивые
 * классы, а когда их нет — позиция тега относительно карточки (`h3 > a`,
 * `td:nth-of-type(2)`). Отдаём весь список, а не первый подошедший: в карточке
 * образца подходит и `a`, но у соседей перед заголовком может стоять вторая
 * ссылка, и тогда спасёт только более длинный путь.
 */
function relativeCandidates($: cheerio.CheerioAPI, card: Element, target: Element): string[] {
  if (target === card) return [];

  const found: string[] = [];
  const add = (selector: string): void => {
    if (selectsTarget($, card, selector, target) && !found.includes(selector)) found.push(selector);
  };

  let path = descriptorOf(target);
  let node = target.parent as Element | null;
  for (let depth = 0; depth < MAX_PATH; depth += 1) {
    add(path);
    if (!node?.tagName || node === card) break;
    path = `${descriptorOf(node)} > ${path}`;
    node = node.parent as Element | null;
  }

  const positional = positionalPath(card, target);
  if (positional) add(positional);

  return found;
}

/** Ссылка, по которой карточку можно открыть: якоря и js-заглушки не в счёт. */
function isRealLink(element: Element): boolean {
  if (element.tagName !== "a") return false;
  const href = element.attribs?.href ?? "";
  return href !== "" && !href.startsWith("#") && !href.startsWith("javascript:");
}

function firstRealLink($: cheerio.CheerioAPI, root: Element): Element | null {
  const found = $(root)
    .find("a[href]")
    .toArray()
    .find((node) => isRealLink(node as Element));
  return (found as Element | undefined) ?? null;
}

function linkFor($: cheerio.CheerioAPI, card: Element, anchor: Element): Element | null {
  // Образец мог лежать прямо внутри ссылки — тогда ссылка карточки уже найдена.
  for (let node: Element | null = anchor; node; node = node.parent as Element | null) {
    if (isRealLink(node)) return node;
    if (node === card) break;
  }
  return firstRealLink($, anchor) ?? firstRealLink($, card);
}

/**
 * Доля карточек, в которых селектор находит РОВНО один узел: так проверяем и
 * что карточка — не ячейка, и что заголовок у всех позиций один и тот же, а не
 * «первое, что попалось» в конкретной карточке.
 */
function coverage($: cheerio.CheerioAPI, item: string, inner: string): number {
  const cards = selects($, item);
  if (cards.length === 0) return 0;
  const hits = cards.filter((card) => {
    try {
      return $(card).find(inner).length === 1;
    } catch {
      return false;
    }
  }).length;
  return hits / cards.length;
}

/** Первый селектор, который указывает на нужный узел не только в карточке образца. */
function pickInner(
  $: cheerio.CheerioAPI,
  card: Element,
  target: Element,
  item: string,
): string | null {
  for (const selector of relativeCandidates($, card, target)) {
    if (coverage($, item, selector) >= MIN_COVERAGE) return selector;
  }
  return null;
}

function itemHasSample(item: ScrapedItem, sample: Sample): boolean {
  if (looksLikeSample(normalizeText(item.title), sample)) return true;
  // Образец мог быть скопирован вместе с датой и ценой — тогда он лежит в тексте
  // карточки целиком, а заголовок из него вычленил уже extractItems.
  return normalizeText(item.text).includes(sample.text);
}

/* ---------- шум страницы ---------- */

/**
 * Меню, шапка, подвал и боковые виджеты. Ровно так же от них защищается
 * `detectSelectors` в scrape.ts, но наружу та проверка не вынесена, поэтому
 * держим локальную копию: без неё блок «Похожие закупки» с ТЕМИ ЖЕ заголовками
 * выигрывает у настоящего списка просто потому, что стоит выше в разметке.
 */
const NOISE_CONTAINERS = new Set(["nav", "header", "footer", "aside"]);

const NOISE_CLASS_RE =
  /(^|[-_])(nav|navbar|menu|dropdown|breadcrumb|pagination|pager|sidebar|social|lang)([-_]|$)/i;

/** `header`/`footer` в конце класса — это часть карточки (`card-header`), а не шапка страницы. */
const CHROME_CLASS_RE = /^(site|page|top|main|global)?[-_]?(header|footer)([-_]|$)/i;

function rawClasses(element: Element): string[] {
  return (element.attribs?.class ?? "").split(/\s+/).filter(Boolean);
}

function hasNoiseClass(element: Element): boolean {
  const role = element.attribs?.role ?? "";
  if (role === "navigation" || role === "menu") return true;
  // Классы проверяем поодиночке: CHROME_CLASS_RE привязан к началу строки.
  return rawClasses(element).some((cls) => NOISE_CLASS_RE.test(cls) || CHROME_CLASS_RE.test(cls));
}

/**
 * Предки блока с основным содержимым. На живых страницах `role="navigation"`
 * нередко висит на обёртке всей страницы (шторка бокового меню), и без этого
 * исключения весь список тендеров считался бы навигацией.
 */
function contentWrappers($: cheerio.CheerioAPI): Set<Element> {
  const wrappers = new Set<Element>();
  for (const main of selects($, "main, [role=main], #content, #main")) {
    for (let node = main.parent as Element | null; node?.tagName; node = node.parent as Element | null) {
      wrappers.add(node);
    }
  }
  return wrappers;
}

function insideNoise(element: Element, wrappers: Set<Element>): boolean {
  if (hasNoiseClass(element)) return true;
  for (let node = element.parent as Element | null; node?.tagName; node = node.parent as Element | null) {
    if (!wrappers.has(node) && (NOISE_CONTAINERS.has(node.tagName) || hasNoiseClass(node))) return true;
  }
  return false;
}

/* ---------- сборка кандидата ---------- */

/**
 * Места, где на странице встретился образец, от самого глубокого: иначе
 * совпадёт body. Точное вхождение идёт впереди почти-совпадения: в списке, где
 * заголовки различаются одним номером, соседние карточки проходят по похожести
 * и иначе съели бы весь запас якорей — вместе с местом настоящей карточки.
 */
function findAnchors($: cheerio.CheerioAPI, sample: Sample): Element[] {
  const found: { element: Element; fuzzy: number; depth: number; length: number }[] = [];

  for (const element of selects($, "body, body *")) {
    if (SKIP_TAGS.has(element.tagName)) continue;
    const text = textOf($, element);
    if (!looksLikeSample(text, sample)) continue;
    found.push({
      element,
      fuzzy: text.includes(sample.text) ? 0 : 1,
      depth: depthOf(element),
      length: text.length,
    });
  }

  return found
    .sort((a, b) => a.fuzzy - b.fuzzy || b.depth - a.depth || a.length - b.length)
    .slice(0, MAX_ANCHORS)
    .map((hit) => hit.element);
}

function candidateFor(
  $: cheerio.CheerioAPI,
  html: string,
  baseUrl: string,
  sample: Sample,
  anchor: Element,
  card: Element,
  group: Element[],
): SelectorCandidate | null {
  const item = buildItemSelector($, card, group);
  if (!item) return null;

  // Карточка повторяется целиком, поэтому заголовок (а если образец занял всю
  // карточку — ссылка) обязан однозначно находиться и у соседей. Без этой
  // проверки за карточку принимается одна ячейка строки: у ячеек тоже есть
  // похожие соседи, — а заголовком становится случайная соседняя ссылка.
  const title = pickInner($, card, anchor, item);
  const linkNode = linkFor($, card, anchor);
  const link = linkNode ? pickInner($, card, linkNode, item) : null;
  if (!title && !link) return null;

  const selectors: Selectors = {
    item,
    ...(title ? { title } : {}),
    ...(link ? { link } : {}),
  };

  const items = extractItems(html, baseUrl, selectors);
  if (items.length < MIN_ITEMS) return null;
  if (!items.some((found) => itemHasSample(found, sample))) return null;

  return { selectors, count: items.length, preview: items.slice(0, 3) };
}

/**
 * Почему разбор не удался. Это внутренний код, а не текст для человека: фразу
 * подбирает бот, но он должен знать, что именно посоветовать — прислать
 * заголовок целиком, взять другую страницу или скопировать текст точнее.
 */
export type ExampleFailure =
  /** Образец — одно слово или пара символов: совпадёт где угодно. */
  | "too_short"
  /** Такого текста на странице нет вовсе. */
  | "not_found"
  /** Образец нашёлся, но повторяющегося списка вокруг него нет. */
  | "single_item"
  /** Список есть, но соседние позиции свёрстаны по-разному — надёжного правила не выходит. */
  | "uneven";

export type ExampleResult =
  | { ok: true; candidate: SelectorCandidate }
  | { ok: false; reason: ExampleFailure };

/** Сколько кандидатов доводим до разбора: каждый заново разбирает страницу целиком. */
const MAX_CANDIDATES = 12;

type Scored = { candidate: SelectorCandidate; noisy: boolean };

/** Кандидат с заголовком надёжнее: без него `extractItems` возьмёт текст первой ссылки. */
function titled(scored: Scored): number {
  return scored.candidate.selectors.title ? 1 : 0;
}

/**
 * Строит правила разбора списка по одному присланному заголовку. Кандидатов
 * собираем всех и выбираем лучшего: первый попавшийся — это тот, что стоит выше
 * в разметке, то есть чаще всего боковой блок «Похожие закупки» или меню.
 */
export function matchExample(html: string, baseUrl: string, sample: string): ExampleResult {
  const wanted = prepareSample(sample);
  if (!wanted) return { ok: false, reason: "too_short" };

  const $ = cheerio.load(html);
  const anchors = findAnchors($, wanted);
  if (anchors.length === 0) return { ok: false, reason: "not_found" };

  const wrappers = contentWrappers($);
  const found: Scored[] = [];
  const seen = new Set<string>();
  let groups = 0;

  for (const anchor of anchors) {
    let node: Element | null = anchor;
    for (let climb = 0; climb < MAX_CLIMB && node?.tagName && node.tagName !== "body"; climb += 1) {
      const group = similarSiblings(node);
      if (group.length >= MIN_GROUP && seen.size < MAX_CANDIDATES) {
        groups += 1;
        const key = `${descriptorOf(node, sharedClasses(group))}#${group.length}#${depthOf(node)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const candidate = candidateFor($, html, baseUrl, wanted, anchor, node, group);
          if (candidate) found.push({ candidate, noisy: insideNoise(node, wrappers) });
        }
      }
      node = node.parent as Element | null;
    }
  }

  // Пустой ответ честнее выдуманного селектора, который на следующей проверке
  // даст мусор, но причину различаем: советы человеку у них разные.
  if (found.length === 0) return { ok: false, reason: groups === 0 ? "single_item" : "uneven" };

  // Сортировка устойчива, поэтому при полном равенстве побеждает кандидат от
  // самого глубокого якоря — он описывает карточку точнее прочих.
  found.sort(
    (a, b) =>
      Number(a.noisy) - Number(b.noisy) ||
      b.candidate.count - a.candidate.count ||
      titled(b) - titled(a),
  );

  return { ok: true, candidate: found[0].candidate };
}

/** Тот же разбор, когда причина отказа вызывающему не нужна. */
export function selectorsFromExample(
  html: string,
  baseUrl: string,
  sample: string,
): SelectorCandidate | null {
  const result = matchExample(html, baseUrl, sample);
  return result.ok ? result.candidate : null;
}
