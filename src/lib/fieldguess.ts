import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { ScrapedItem, Selectors } from "./types";

/**
 * Что бот распознал внутри карточки тендера. Значения — CSS-селекторы
 * ОТНОСИТЕЛЬНО карточки, `extractItems` ищет их через `card.find(selector)`.
 * Человеку эти строки не показывают никогда — для него есть `describeItems`
 * и `fieldsSummary`.
 *
 * ВНИМАНИЕ: в `Selectors` можно положить только `date` и `price` — больше
 * полей эта запись не хранит, а `formatItem` больше и не печатает. Срок
 * подачи, номер и заказчика мы распознаём (без этого срок подачи выдавал бы
 * себя за дату публикации), но в уведомление они пока не попадают, поэтому и
 * человеку их не обещаем. Складывать `guessed` в `Selectors` спредом нельзя:
 * TypeScript лишние ключи при спреде не ловит, и они мёртвым грузом уедут в
 * базу — для этого есть `selectorFields`.
 */
export type GuessedFields = {
  date?: string;
  price?: string;
  number?: string;
  customer?: string;
  deadline?: string;
};

type Field = keyof GuessedFields;

const FIELDS: readonly Field[] = ["date", "deadline", "price", "number", "customer"];

/** Сколько карточек смотрим: по одной верстку не проверить, все — незачем. */
const SAMPLE_CARDS = 6;

/** Длиннее — это уже описание тендера, а не значение поля. */
const MAX_FIELD_TEXT: Record<Field, number> = {
  date: 60,
  deadline: 80,
  price: 60,
  number: 40,
  customer: 140,
};

/** Подпись поля стоит рядом и всегда коротка; длинный сосед — это заголовок. */
const LABEL_LOOKBEHIND = 40;

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "path",
  "img",
  "br",
  "input",
  "button",
  "option",
]);

/* ---------- что считаем содержимым поля ---------- */

const DATE_NUMERIC_RE = /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/;
const DATE_ISO_RE = /\b\d{4}-\d{1,2}-\d{1,2}\b/;
const DATE_WORDS_RE =
  /\b\d{1,2}\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

/**
 * Валюты перечислены вместе с окончаниями и закрыты `(?![\p{L}])`: без этого
 * «сум» опознавался бы внутри слова «сумма» и подпись поля становилась ценой.
 */
const CURRENCY = [
  "сом(?:а|ов|ы)?",
  "kgs",
  "тенге",
  "тг",
  "kzt",
  "рубл(?:ь|я|ей)?",
  "руб",
  "₽",
  "rub",
  "сум(?:а|ов|ы)?",
  "сўм",
  "uzs",
  "доллар(?:а|ов)?",
  "usd",
  "\\$",
  "евро",
  "eur",
  "€",
].join("|");

/** Разряды на площадках разделяют пробелами, в том числе неразрывными. */
const AMOUNT = "\\d[\\d\\s.,]*";

const PRICE_RE = new RegExp(
  `(?:${AMOUNT}\\s*(?:${CURRENCY})(?![\\p{L}]))|(?:(?:${CURRENCY})(?![\\p{L}])\\s*${AMOUNT})`,
  "iu",
);

const NUMBER_RE = new RegExp(
  [
    "(?:№\\s*\\d[\\w.\\-/]*)",
    "(?:(?:^|[^\\p{L}])(?:лот|lot)\\s*(?:№|#)?\\s*\\d+)",
    "(?:(?:^|[^\\p{L}])(?:no|nr)\\.?\\s*\\d{2,})",
  ].join("|"),
  "iu",
);

/* ---------- подсказки вёрстки: имя класса и подпись рядом ---------- */

const DATE_HINT_RE = /(date|дата|дате|опубликован|опублик|размещ|публикац|posted|published|created|объявлен)/i;

const DEADLINE_HINT_RE =
  /(deadline|closing|due|expir|until|till|end[-_]?date|date[-_]?end|окончан|оконч|срок|подач|заявк|заявок|крайн|завершен|прием|приём|принима)/i;

/** «до 12.09.2026» — самая частая подпись срока. Кириллица мимо `\b`, границы задаём руками. */
const DEADLINE_UNTIL_RE = /(?:^|[^\p{L}\p{N}])до(?![\p{L}])/iu;

const PRICE_HINT_RE = /(price|cost|amount|budget|money|\bsum\b|цена|цену|цены|стоимост|сумм|бюджет|нмц)/i;

const NUMBER_HINT_RE =
  /(number|\bnum\b|\bno\b|\blot\b|nomer|\bcode\b|номер|(?:^|[^\p{L}])лот(?![\p{L}])|шифр|реестр|регистрацион)/iu;

const CUSTOMER_HINT_RE =
  /(customer|client|organizer|organiser|organization|organisation|orgname|\borg\b|buyer|purchaser|заказчик|организатор|покупател|учрежден|уполномоч)/i;

/** Слова самой подписи — их вычитаем, чтобы отличить «Цена:» от «Цена: 1 200 000 сом». */
const PRICE_LABEL_RE = /(цен[аыу]|стоимост[а-яё]*|сумм[а-яё]*|бюджет[а-яё]*|нмцк?|price|cost|amount|budget|sum)/gi;
const NUMBER_LABEL_RE = /(номер[а-яё]*|лот[а-яё]*|код|шифр|number|lot|code|no)/gi;
const CUSTOMER_LABEL_RE =
  /(заказчик[а-яё]*|организатор[а-яё]*|покупател[а-яё]*|организаци[а-яё]*|customer|organizer|organiser|organization|buyer|client)/gi;

function textOf(node: cheerio.Cheerio<AnyNode>): string {
  return node.text().replace(/\s+/g, " ").trim();
}

function looksLikeDate(text: string): boolean {
  return DATE_NUMERIC_RE.test(text) || DATE_ISO_RE.test(text) || DATE_WORDS_RE.test(text);
}

/**
 * Узел, в котором кроме слов-подписи ничего нет: «Заказчик:», «Цена». Такой
 * узел сам себя рекламирует подсказкой, но значения не несёт, а по длине текста
 * выигрывает у настоящего значения — поэтому его выкидываем явно.
 */
function isBareLabel(text: string, labels: RegExp): boolean {
  return text.replace(labels, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().length === 0;
}

/* ---------- селектор относительно карточки ---------- */

/**
 * Классы вида `css-1x9d8h` меняются от сборки к сборке, а `md:flex` и `w-1/2`
 * ещё и ломают разбор селектора — опираться можно только на простые имена.
 */
function isStableClass(cls: string): boolean {
  return cls.length <= 30 && /^[a-z_][\w-]*$/i.test(cls) && !/^(css|sc)-[a-z0-9]{4,}$/i.test(cls);
}

function classesOf(element: Element): string[] {
  return (element.attribs?.class ?? "").split(/\s+/).filter(Boolean);
}

function tagWithClasses(element: Element): string {
  const classes = classesOf(element).filter(isStableClass).slice(0, 2);
  return classes.length ? `${element.tagName}.${classes.join(".")}` : element.tagName;
}

function nthOfType(element: Element): number {
  const parent = element.parent as Element | null;
  if (!parent?.children) return 1;
  let index = 0;
  for (const child of parent.children) {
    const node = child as Element;
    if (node.tagName !== element.tagName) continue;
    index += 1;
    if (node === element) return index;
  }
  return index || 1;
}

/** Шаг пути: класс, если он есть, иначе позиция — так берутся ячейки таблиц без классов. */
function pathStep(element: Element): string {
  const withClasses = tagWithClasses(element);
  return withClasses.includes(".") ? withClasses : `${element.tagName}:nth-of-type(${nthOfType(element)})`;
}

function buildPath(card: Element, node: Element, positional: boolean): string | null {
  const parts: string[] = [];
  let current: Element | null = node;
  for (let depth = 0; depth < 4 && current && current !== card; depth += 1) {
    const step = positional ? `${current.tagName}:nth-of-type(${nthOfType(current)})` : pathStep(current);
    parts.unshift(step);
    current = current.parent as Element | null;
  }
  return current === card && parts.length ? parts.join(" > ") : null;
}

/**
 * Селектор, по которому `card.find(...)` первым делом вернёт именно этот узел.
 * Сначала короткая форма по классу — она переживает мелкие правки вёрстки;
 * затем путь от карточки, а если по дороге встретились одинаковые классы
 * (две подряд `div.row`) — путь из одних позиций.
 */
function relativeSelector($: cheerio.CheerioAPI, card: Element, node: Element): string | null {
  const resolves = (selector: string | null): selector is string => {
    if (!selector) return false;
    try {
      return $(card).find(selector).first().get(0) === node;
    } catch {
      return false;
    }
  };

  const short = tagWithClasses(node);
  if (short.includes(".") && resolves(short)) return short;

  const byClass = buildPath(card, node, false);
  if (resolves(byClass)) return byClass;

  const byPosition = buildPath(card, node, true);
  return resolves(byPosition) ? byPosition : null;
}

/* ---------- разбор одной карточки ---------- */

/**
 * Похоже на подпись поля, а не на кусок заголовка: пара слов без цифр.
 * «Поставка угля до зимы» подписью не является — иначе «до» из заголовка
 * превратило бы дату публикации в срок подачи.
 */
function isLabelLike(text: string): boolean {
  if (!text || text.length > 30) return false;
  if (/\d/.test(text)) return false;
  return (text.match(/[\p{L}]+/gu) ?? []).length <= 3;
}

/**
 * Текст соседей слева. Берём его только когда он похож на подпись: длинный
 * сосед — это заголовок тендера, и слова из него сбили бы распознавание.
 */
function precedingText($: cheerio.CheerioAPI, node: Element): string {
  const parts: string[] = [];
  let sibling = node.prev as AnyNode | null;
  for (let step = 0; step < 3 && sibling; step += 1) {
    const element = sibling as Element;
    if (element.tagName) {
      // Сосед-ссылка — это заголовок тендера, а не подпись поля: короткий
      // заголовок вроде «Поставка угля до зимы» иначе проходил бы по длине.
      if (element.tagName === "a" || $(element).find("a").length > 0) break;
      parts.unshift(textOf($(element)));
    } else {
      parts.unshift((sibling as unknown as { data?: string }).data ?? "");
    }
    sibling = sibling.prev as AnyNode | null;
  }

  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.endsWith(":")) return text.slice(-LABEL_LOOKBEHIND);
  return isLabelLike(text) ? text : "";
}

function hintsFor($: cheerio.CheerioAPI, card: Element, node: Element, text: string): string {
  const parts = [
    node.attribs?.class ?? "",
    node.attribs?.id ?? "",
    node.attribs?.["data-label"] ?? "",
    node.attribs?.["aria-label"] ?? "",
  ];

  let parent = node.parent as Element | null;
  for (let depth = 0; depth < 3 && parent && parent !== card && parent.tagName; depth += 1) {
    parts.push(parent.attribs?.class ?? "");
    parent = parent.parent as Element | null;
  }

  parts.push(precedingText($, node), text);
  return parts.join(" ").toLowerCase();
}

function looksLikeDeadline(hints: string): boolean {
  return DEADLINE_HINT_RE.test(hints) || DEADLINE_UNTIL_RE.test(hints);
}

/**
 * Насколько узел похож на поле. Ноль — не похож вовсе. Содержимое и подсказка
 * вёрстки складываются: дата с классом `date` вернее даты без класса, а цена
 * без валюты берётся только при подписи «Цена».
 */
function scoreField(field: Field, text: string, hints: string, node: Element): number {
  switch (field) {
    case "date": {
      if (!looksLikeDate(text)) return 0;
      // Дата под словом «до» — это срок подачи, а не дата публикации.
      if (looksLikeDeadline(hints)) return 0;
      return DATE_HINT_RE.test(hints) ? 3 : 2;
    }
    case "deadline": {
      if (!looksLikeDate(text)) return 0;
      return looksLikeDeadline(hints) ? 3 : 0;
    }
    case "price": {
      if (isBareLabel(text, PRICE_LABEL_RE)) return 0;
      const money = PRICE_RE.test(text);
      const hinted = PRICE_HINT_RE.test(hints);
      if (money) return hinted ? 4 : 3;
      return hinted && /\d/.test(text) ? 2 : 0;
    }
    case "number": {
      if (isBareLabel(text, NUMBER_LABEL_RE)) return 0;
      const hinted = NUMBER_HINT_RE.test(hints);
      // «Ремонт кровли школы №12» — это заголовок-ссылка, а не номер лота.
      if (node.tagName === "a" && !hinted) return 0;
      if (NUMBER_RE.test(text)) return hinted ? 4 : 2;
      return hinted && /\d/.test(text) ? 2 : 0;
    }
    case "customer": {
      // У заказчика нет узнаваемой формы — опознаём только по подписи.
      if (!CUSTOMER_HINT_RE.test(hints)) return 0;
      if (isBareLabel(text, CUSTOMER_LABEL_RE)) return 0;
      if (!/\p{L}/u.test(text)) return 0;
      return looksLikeDate(text) || PRICE_RE.test(text) ? 0 : 3;
    }
  }
}

type Best = { selector: string; score: number; length: number; leaf: boolean };

/** Узел без вложенных элементов: его текст — само значение, а не склейка подписи со значением. */
function isLeaf(node: Element): boolean {
  return !node.children.some((child) => {
    const tag = (child as Element).tagName;
    return Boolean(tag) && !SKIP_TAGS.has(tag);
  });
}

/**
 * Кто выигрывает при равном счёте. У даты, цены и номера — более короткий
 * текст: он ближе к чистому значению. У заказчика наоборот, имя организации
 * всегда длинное, а короткий сосед в том же блоке — это город или отдел;
 * зато обёртку, внутри которой лежат другие узлы, брать нельзя никогда:
 * её текст склеен из подписи и значения.
 */
function beats(field: Field, next: Omit<Best, "selector">, current: Best): boolean {
  if (next.score !== current.score) return next.score > current.score;
  if (field !== "customer") return next.length < current.length;
  if (next.leaf !== current.leaf) return next.leaf;
  return next.length > current.length;
}

function guessInCard($: cheerio.CheerioAPI, card: Element): [Field, string][] {
  const best = new Map<Field, Best>();
  const cardText = textOf($(card));

  for (const element of $(card).find("*").toArray()) {
    const node = element as Element;
    if (!node.tagName || SKIP_TAGS.has(node.tagName)) continue;

    const text = textOf($(node));
    // Узел, повторяющий всю карточку, ничего не уточняет — значением поля он стать не может.
    if (!text || text === cardText) continue;

    const hints = hintsFor($, card, node, text);

    for (const field of FIELDS) {
      if (text.length > MAX_FIELD_TEXT[field]) continue;
      const score = scoreField(field, text, hints, node);
      if (score <= 0) continue;

      const next = { score, length: text.length, leaf: isLeaf(node) };
      const current = best.get(field);
      if (current && !beats(field, next, current)) continue;

      const selector = relativeSelector($, card, node);
      if (selector) best.set(field, { selector, ...next });
    }
  }

  return [...best.entries()].map(([field, value]) => [field, value.selector]);
}

/**
 * Наполнено ли поле в этой карточке. Проверять непустоту текста нельзя:
 * у позиционного селектора (`td:nth-of-type(4)`) ячейка есть в каждой строке, и
 * «по договору» сходило бы за цену, найденную по всему списку. Поэтому узел
 * опознаём заново — тем же правилом, каким его нашли.
 */
function fieldFilled(
  $: cheerio.CheerioAPI,
  card: Element,
  field: Field,
  selector: string,
): boolean {
  try {
    const found = $(card).find(selector).first();
    const node = found.get(0) as Element | undefined;
    if (!node?.tagName) return false;

    const text = textOf(found);
    if (!text || text.length > MAX_FIELD_TEXT[field]) return false;
    return scoreField(field, text, hintsFor($, card, node, text), node) > 0;
  } catch {
    return false;
  }
}

/**
 * Ищет дату, срок подачи, цену, номер и заказчика внутри карточек списка.
 * Поле засчитывается, только если один и тот же селектор наполнен в большинстве
 * проверенных карточек: одиночное совпадение — это случайность вёрстки, и в
 * уведомлениях такое поле почти всегда оказалось бы пустым.
 */
export function guessFields(html: string, itemSelector: string): GuessedFields {
  const $ = cheerio.load(html);

  const cards: Element[] = [];
  try {
    $(itemSelector)
      .slice(0, SAMPLE_CARDS)
      .each((_, element) => {
        cards.push(element as Element);
      });
  } catch {
    // Селектор мог прийти из автоподбора или из старой записи в базе — не роняем диалог.
    return {};
  }
  if (cards.length === 0) return {};

  const votes = new Map<Field, Map<string, number>>();
  for (const card of cards) {
    for (const [field, selector] of guessInCard($, card)) {
      const perField = votes.get(field) ?? new Map<string, number>();
      perField.set(selector, (perField.get(selector) ?? 0) + 1);
      votes.set(field, perField);
    }
  }

  const guessed: GuessedFields = {};
  for (const field of FIELDS) {
    const perField = votes.get(field);
    if (!perField) continue;
    const [selector] = [...perField.entries()].sort((a, b) => b[1] - a[1])[0];
    const present = cards.filter((card) => fieldFilled($, card, field, selector)).length;
    if (present * 2 > cards.length) guessed[field] = selector;
  }

  return guessed;
}

/* ---------- как это выглядит для человека ---------- */

/** Telegram отвергает всё сообщение целиком, если в нём чужой «<» из вёрстки площадки. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Обрезка идёт по кодовым единицам UTF-16 и может разрубить эмодзи пополам.
 * Одинокий суррогат Telegram показывает как «�», а при некоторых сериализациях
 * отвергает сообщение целиком — поэтому оборванную половину пары убираем.
 */
function dropBrokenTail(text: string): string {
  return text.replace(/[\uD800-\uDBFF]$/, "");
}

/** Насколько далеко отступаем назад до пробела, чтобы не рвать слово посередине. */
const WORD_LOOKBACK = 15;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = dropBrokenTail(text.slice(0, max - 1));
  const space = cut.lastIndexOf(" ");
  const body = space > 0 && cut.length - space <= WORD_LOOKBACK ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

/** Обрезка уже экранированного текста: хвост вида «&am» сломал бы parse_mode. */
function clipEscaped(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = dropBrokenTail(text.slice(0, max - 1).replace(/&[#a-z0-9]{0,6}$/i, ""));
  return `${cut.trimEnd()}…`;
}

function positions(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return "позицию";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "позиции";
  return "позиций";
}

const MAX_DESCRIPTION = 900;
const TITLE_BUDGET = 140;
const VALUE_BUDGET = 60;

/**
 * Значения полей из первой позиции — ТЕКСТЫ с сайта, а не селекторы. Метка
 * `source` нужна не разбору, а компилятору: без неё в `describeItems` можно
 * было бы по ошибке передать `GuessedFields` (формы у них одинаковые), и
 * человек увидел бы в сводке «Дата: span.tender-date». С меткой это ошибка
 * компиляции.
 */
export type FieldValues = {
  source: "first-card";
  date?: string;
  price?: string;
};

/**
 * Читает из первой карточки то, что бот будет показывать в уведомлениях.
 * Нужно потому, что `extractItems` вызывают ДО подбора полей: в его позициях
 * `date` и `price` ещё пустые, и без этого шага сводка выродилась бы в столбик
 * «есть» — сверять человеку было бы нечего.
 */
export function readFields(
  html: string,
  itemSelector: string,
  guessed: GuessedFields,
): FieldValues {
  const $ = cheerio.load(html);

  let card: cheerio.Cheerio<AnyNode>;
  try {
    card = $(itemSelector).first();
  } catch {
    // Селектор мог прийти из автоподбора или из старой записи в базе — не роняем диалог.
    return { source: "first-card" };
  }
  if (card.length === 0) return { source: "first-card" };

  const read = (selector: string | undefined): string | undefined => {
    if (!selector) return undefined;
    try {
      return textOf(card.find(selector).first()) || undefined;
    } catch {
      return undefined;
    }
  };

  const date = read(guessed.date);
  const price = read(guessed.price);
  return { source: "first-card", ...(date ? { date } : {}), ...(price ? { price } : {}) };
}

/**
 * Только те поля, которые `Selectors` умеет хранить, а `extractItems` — читать.
 * Спред `{...guessed}` TypeScript пропустит вместе с лишними ключами, и они
 * навсегда останутся мёртвым грузом в jsonb.
 */
export function selectorFields(guessed: GuessedFields): Pick<Selectors, "date" | "price"> {
  return {
    ...(guessed.date ? { date: guessed.date } : {}),
    ...(guessed.price ? { price: guessed.price } : {}),
  };
}

type Row = {
  icon: string;
  label: string;
  missing: string;
  value: string | null | undefined;
  known: boolean;
};

/**
 * Сводка для подтверждения кнопкой. Человек не должен видеть ни одного
 * селектора: он сверяет то, что бот понял, с тем, что видит на сайте сам.
 * Поэтому в каждой строке стоит ЗНАЧЕНИЕ первой позиции.
 *
 * Значения берутся из самих позиций, а когда их там ещё нет — из `values`:
 * `guessFields` работает уже после `extractItems`, поэтому в естественном
 * порядке вызовов дата и цена в позициях пустые. Чтобы человеку было что
 * сверять, третьим аргументом передают `readFields(html, item, guessed)`.
 *
 * Слова «есть» вместо значения здесь нет и быть не должно: сверить его не с
 * чем. Поле, которое бот распознал, но у первой позиции оно пустое, просто
 * молчит — обещать его нечестно, а записывать в «не нашёл» неправда.
 *
 * Срок подачи, номер и заказчика не показываем совсем — положить их в
 * уведомление всё равно некуда (см. `GuessedFields`).
 */
export function describeItems(
  items: ScrapedItem[],
  guessed: GuessedFields = {},
  values: FieldValues = { source: "first-card" },
): string {
  if (items.length === 0) return "Не нашёл ни одной позиции — похоже, это не страница со списком.";

  const first = items[0];
  const head = `Нашёл ${items.length} ${positions(items.length)}. Вот что распознал в первой:`;

  // Подпись в строке и подпись в перечислении «не нашёл» стоят в разных падежах:
  // «📅 Дата: …», но «не нашёл даты».
  const rows: Row[] = [
    { icon: "📌", label: "Название", missing: "названия", value: first.title, known: false },
    {
      icon: "📅",
      label: "Дата",
      missing: "даты",
      value: values.date ?? first.date,
      known: Boolean(guessed.date),
    },
    {
      icon: "💰",
      label: "Цена",
      missing: "цены",
      value: values.price ?? first.price,
      known: Boolean(guessed.price),
    },
    { icon: "🔗", label: "Ссылка", missing: "", value: first.url, known: false },
  ];

  const lines: string[] = [];
  const missing: string[] = [];

  for (const row of rows) {
    const value = row.value?.trim() ? row.value.trim() : null;
    if (!value) {
      if (row.missing && !row.known) missing.push(row.missing);
      continue;
    }
    const budget = row.label === "Название" ? TITLE_BUDGET : VALUE_BUDGET;
    lines.push(`${row.icon} ${row.label}: ${escapeHtml(clip(value, budget))}`);
  }

  const tail: string[] = [];
  if (missing.length) {
    tail.push(
      `❓ Не нашёл: ${missing.join(", ")}. Это не ошибка — просто этих строк не будет в уведомлениях.`,
    );
  }
  // Ссылка — не такая же необязательная строка, как цена: без неё уведомление
  // бесполезно, открыть тендер человеку будет неоткуда. Это повод вернуться и
  // выбрать другую страницу, поэтому в общий список её не прячем.
  if (!first.url) {
    tail.push("🔗 Ссылку на тендер найти не удалось — уведомления придут без кнопки открытия.");
  }

  const body = [...lines];
  const build = (): string => [head, ...body, ...tail].join("\n");

  // Лишнее режем целыми строками: обрывок строки посреди значения только путает.
  let text = build();
  while (text.length > MAX_DESCRIPTION && body.length > 1) {
    body.pop();
    text = build();
  }

  return clipEscaped(text, MAX_DESCRIPTION);
}

const SUMMARY_LABELS: { field: Field; label: string }[] = [
  { field: "date", label: "дата" },
  { field: "price", label: "цена" },
];

/**
 * Строка в одну-две пары слов для карточки сайта: что именно бот умеет
 * показывать. Про ссылку спрашиваем отдельно — она берётся не из `guessed`, а
 * из самих позиций, и на площадках с `javascript:`-заглушками её просто нет.
 */
export function fieldsSummary(guessed: GuessedFields, hasLink = true): string {
  const labels = SUMMARY_LABELS.filter((row) => guessed[row.field]).map((row) => row.label);
  if (labels.length) return labels.join(", ");
  return hasLink ? "только название и ссылка" : "только название";
}
