/**
 * Тексты и клавиатуры добавления площадки. Отдельный модуль, потому что здесь
 * нет ни сети, ни базы: всё проверяется тестами, а главное требование к этому
 * коду — словарное. Человек, который добавляет сайт, не программист, поэтому в
 * сообщениях не должно быть ни одного слова из вёрстки и протоколов: ни
 * «селектор», ни «item», ни кодов ответа. Всё объясняем через то, что человек
 * видит в браузере своими глазами.
 */

import { InlineKeyboard } from "grammy";
import type { ExampleFailure } from "../byexample";
import type { CatalogEntry } from "../catalog";
import { describeItems, fieldsSummary, type GuessedFields } from "../fieldguess.ts";
import { escapeHtml } from "../notify.ts";
import { explainDiagnosis, type PageDiagnosis } from "../pagestate.ts";
import type { SelectorCandidate } from "../scrape";
import type { ScrapedItem, Selectors, Site, SiteSearch } from "../types";

/** Данные кнопок. Держим в одном месте: их читают и меню, и обработчики, и тесты. */
export const CB = {
  cancel: "cancel",
  sites: "sites",
  catalog: "catalog",
  /** `cat:<id>` — показать площадку из каталога. */
  catalogPick: "cat",
  /** `cat_add:<id>` — добавить показанную площадку. */
  catalogAdd: "cat_add",
  siteAdd: "site_add",
  manual: "site_manual",
  /** Подтверждение списка, найденного по образцу. */
  exampleConfirm: "ex_ok",
  /** «Пришлю другой пример». */
  exampleRetry: "ex_retry",
} as const;

/** Подпись кнопки ручного ввода. Она уводит с главного пути, поэтому и звучит так. */
export const ADVANCED_LABEL = "⚙️ Для продвинутых: задать правила вручную";

/* ---------- мелочи языка ---------- */

/** «1 тендер», «2 тендера», «5 тендеров» — иначе сообщение читается как машинный лог. */
export function tendersWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return "тендер";
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return "тендера";
  return "тендеров";
}

/**
 * Код ответа из ошибки загрузки. Нужен ровно затем, чтобы `diagnosePage` смогла
 * отличить «сайт не пускает» от «страницы нет» и сказать это человеку словами.
 * В сообщения бота само число не попадает никогда.
 */
export function httpStatusFromError(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const found = /\bHTTP\s+(\d{3})\b/.exec(message);
  return found ? Number(found[1]) : undefined;
}

/**
 * Два адреса ведут на один и тот же список. Нужно, чтобы уже добавленная
 * площадка не добавлялась во второй раз: у второй записи был бы свой список
 * виденного, и все тендеры пришли бы дважды.
 */
export function sameListUrl(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, "");
      return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`.toLowerCase();
    } catch {
      return value.trim().toLowerCase();
    }
  };
  return normalize(a) === normalize(b);
}

/** Ссылка в сообщении — только http(s): остальные Telegram отвергает вместе со всем текстом. */
function linkLine(url: string, label = "Открыть страницу в браузере"): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return `<a href="${escapeHtml(url)}">${label}</a>`;
}

/* ---------- готовые площадки ---------- */

/**
 * Список каталога. Уже добавленные помечаем галочкой и оставляем кнопку
 * нажимаемой: по ней человек увидит понятное «эта площадка уже у вас», а не
 * молчание в ответ на нажатие.
 */
export function catalogMenu(
  entries: CatalogEntry[],
  addedUrls: string[],
): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  for (const entry of entries) {
    const added = addedUrls.some((url) => sameListUrl(url, entry.listUrl));
    keyboard.text(`${added ? "✅" : "➕"} ${entry.title} · ${entry.country}`, `${CB.catalogPick}:${entry.id}`).row();
  }
  keyboard.text("🔗 Добавить свой сайт по ссылке", CB.siteAdd).row();
  keyboard.text("⬅️ К сайтам", CB.sites);

  const text = entries.length
    ? [
        "⭐ <b>Готовые площадки</b>",
        "Эти сайты я уже умею читать — настраивать ничего не нужно.",
        "",
        "Нажмите на площадку: проверю её прямо сейчас и покажу, что на ней нашёл.",
        "✅ — площадка уже добавлена.",
      ].join("\n")
    : [
        "⭐ <b>Готовые площадки</b>",
        "Пока список пуст.",
        "",
        "Пришлите ссылку на страницу со списком тендеров — разберусь с ней вместе с вами.",
      ].join("\n");

  return { text, keyboard };
}

/** Шапка карточки площадки: название, страна, ссылка — всё, что человек узнаёт глазами. */
function catalogHead(entry: CatalogEntry): string[] {
  const lines = [`⭐ <b>${escapeHtml(entry.title)}</b>`, `📍 ${escapeHtml(entry.country)}`];
  const link = linkLine(entry.listUrl);
  if (link) lines.push(link);
  return lines;
}

/**
 * Что показать после живой проверки площадки. Сначала находка, потом заметка о
 * площадке, и только в конце вопрос — так человек отвечает уже зная, на что.
 */
export function catalogFound(
  entry: CatalogEntry,
  items: ScrapedItem[],
  guessed: GuessedFields,
): { text: string; keyboard: InlineKeyboard } {
  const lines = [...catalogHead(entry), "", describeItems(items, guessed)];
  if (entry.note) lines.push("", `ℹ️ ${escapeHtml(entry.note)}`);
  lines.push("", "Добавляем эту площадку?");

  const keyboard = new InlineKeyboard()
    .text("➕ Добавить", `${CB.catalogAdd}:${entry.id}`)
    .row()
    .text("⬅️ К списку площадок", CB.catalog);

  return { text: lines.join("\n"), keyboard };
}

/** Площадка не ответила или список на ней сейчас не читается. */
export function catalogFailed(
  entry: CatalogEntry,
  diagnosis: PageDiagnosis,
): { text: string; keyboard: InlineKeyboard } {
  const explained = explainDiagnosis(diagnosis, entry.listUrl);
  const lines = [...catalogHead(entry), "", explained.text];

  const keyboard = new InlineKeyboard();
  if (explained.canRetry) keyboard.text("🔄 Проверить ещё раз", `${CB.catalogPick}:${entry.id}`).row();
  keyboard.text("⬅️ К списку площадок", CB.catalog);

  return { text: lines.join("\n"), keyboard };
}

/** Ответ на кнопку уже добавленной площадки. Короткий — он показывается всплывашкой. */
export const CATALOG_ALREADY_ADDED = "Эта площадка уже добавлена — она в списке «🌐 Сайты».";

/* ---------- добавление по ссылке ---------- */

export const ASK_URL_TEXT = [
  "Пришлите ссылку на страницу, где тендеры идут списком.",
  "",
  "Откройте нужный раздел на сайте и скопируйте адрес из адресной строки браузера.",
  "Например: https://zakupki.gov.kg/popp/view/order/list",
  "",
  "Не хочется искать самому? Загляните в «⭐ Готовые площадки».",
  "",
  "/cancel — отмена",
].join("\n");

export const NOT_A_LINK_TEXT = [
  "Это не похоже на адрес страницы.",
  "",
  "Нужен адрес из адресной строки браузера — та полоска в самом верху окна.",
  "Откройте на сайте раздел с тендерами, выделите там весь адрес и пришлите его сюда.",
  "",
  "/cancel — отмена",
].join("\n");

/**
 * Варианты списков, найденные на странице. Человеку показываем не правила
 * разбора, а сами заголовки: он сверяет их с тем, что видит на сайте. Рядом с
 * числом позиций — сколько из них ловят ключевые слова: ради этого числа он и
 * присылал ссылку.
 */
export function candidatesMessage(
  candidates: SelectorCandidate[],
  matched?: (number | null)[],
): { text: string; keyboard: InlineKeyboard } {
  const blocks = candidates.map((candidate, index) => {
    const examples = candidate.preview
      .map((item) => `   • ${escapeHtml(item.title.slice(0, 90))}`)
      .join("\n");
    const hits = matched?.[index];
    const head =
      `<b>Вариант ${index + 1}</b> — ${candidate.count} ${tendersWord(candidate.count)}` +
      (typeof hits === "number" ? `, по вашим словам подходит ${hits}` : "");
    return [head, examples].filter(Boolean).join("\n");
  });

  const keyboard = new InlineKeyboard();
  candidates.forEach((_, index) => keyboard.text(`Вариант ${index + 1}`, `site_pick:${index}`));
  keyboard.row().text(ADVANCED_LABEL, CB.manual).row().text("❌ Отмена", CB.cancel);

  const head =
    candidates.length === 1
      ? "Похоже, список тендеров на этой странице вот такой — проверьте заголовки:"
      : "Нашёл на странице несколько списков. Какой из них — тендеры?";

  return { text: [head, "", ...blocks].join("\n"), keyboard };
}

/* ---------- обучение по примеру ---------- */

/**
 * Причина, по которой обучение по примеру бессмысленно. Если сайт вообще не
 * показал список (просит войти, проверяет на робота, рисует страницу уже в
 * браузере), то присланного заголовка на странице тоже не окажется — просить
 * его значит гонять человека зря.
 */
export function canTeachByExample(diagnosis: PageDiagnosis): boolean {
  return diagnosis.kind === "unknown";
}

/** Три шага, которые человек делает руками. Нумерованные — их выполняют по порядку. */
const EXAMPLE_STEPS = [
  "1. Откройте эту страницу в браузере.",
  "2. Найдите в списке любой тендер.",
  "3. Выделите и скопируйте его название целиком — и пришлите мне сюда.",
];

/** Клавиатура «мне не подходит»: запасные пути, доступные на любом шаге разбора. */
function escapeHatches(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⭐ Готовые площадки", CB.catalog)
    .row()
    .text("🔗 Прислать другую ссылку", CB.siteAdd)
    .row()
    .text(ADVANCED_LABEL, CB.manual)
    .row()
    .text("❌ Отмена", CB.cancel);
}

/**
 * Ответ на ссылку, из которой список сам не собрался. Сначала причина обычными
 * словами, и только потом просьба помочь: человек должен понимать, зачем его о
 * чём-то просят, иначе просьба выглядит как «бот сломался».
 */
export function learnByExampleMessage(
  diagnosis: PageDiagnosis,
  url: string,
): { text: string; keyboard: InlineKeyboard } {
  const explained = explainDiagnosis(diagnosis, url);

  if (!canTeachByExample(diagnosis)) {
    return { text: explained.text, keyboard: escapeHatches() };
  }

  const text = [
    explained.text,
    "",
    "Давайте я научусь читать эту страницу с вашей помощью — это минута.",
    "",
    ...EXAMPLE_STEPS,
    "",
    "По одному названию я пойму, как устроен список, и найду остальные сам.",
  ].join("\n");

  return { text, keyboard: escapeHatches() };
}

/** Повтор просьбы, когда человек нажал «пришлю другой пример». */
export function askExampleAgain(url: string): string {
  const link = linkLine(url);
  return [
    "Хорошо, пришлите другое название.",
    "",
    ...EXAMPLE_STEPS,
    ...(link ? ["", link] : []),
  ].join("\n");
}

/** Почему образец не сработал — и что сделать по-другому. Ни слова про разметку. */
const EXAMPLE_FAILURES: Record<ExampleFailure, string[]> = {
  too_short: [
    "Пример слишком короткий — по паре слов список не узнать: они встречаются где угодно.",
    "",
    "Пришлите название тендера целиком, как оно написано на странице.",
  ],
  not_found: [
    "Такого текста на этой странице я не вижу.",
    "",
    "Проверьте, что название скопировано с той самой страницы, ссылку на которую вы прислали, и что оно скопировалось целиком — без потерянных букв в начале и в конце.",
  ],
  single_item: [
    "Этот тендер я нашёл, но похожих рядом с ним нет — на странице он один.",
    "",
    "Пришлите ссылку на раздел, где тендеры идут длинным списком друг под другом.",
  ],
  uneven: [
    "Ваш пример нашёлся, но соседние объявления на странице оформлены по-разному, и общего правила не выходит.",
    "",
    "Попробуйте скопировать название другого тендера — лучше из середины списка.",
  ],
};

export function exampleFailedMessage(
  reason: ExampleFailure,
): { text: string; keyboard: InlineKeyboard } {
  return { text: EXAMPLE_FAILURES[reason].join("\n"), keyboard: escapeHatches() };
}

/** Список узнан по образцу: показываем находку и просим подтвердить глазами. */
export function exampleFoundMessage(
  items: ScrapedItem[],
  guessed: GuessedFields,
): { text: string; keyboard: InlineKeyboard } {
  const text = [
    "✅ Получилось! По вашему примеру я узнал весь список.",
    "",
    describeItems(items, guessed),
    "",
    "Всё верно — это тендеры?",
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("✅ Да, добавляем", CB.exampleConfirm)
    .row()
    .text("🔁 Пришлю другой пример", CB.exampleRetry)
    .row()
    .text("❌ Отмена", CB.cancel);

  return { text, keyboard };
}

/* ---------- поиск на стороне сайта ---------- */

/** Как режим подписан в карточке сайта и в отчётах. Без имён параметров формы. */
export function searchModeText(search: SiteSearch): string {
  return search.mode === "query"
    ? "🔎 через поиск на сайте — по вашим ключевым словам"
    : "читаю страницу списка целиком";
}

/**
 * Предложение искать через поиск самой площадки. Выгоду называем словами
 * человека: меньше лишнего в уведомлениях, а не «сокращает объём разбора».
 */
export function searchOfferMessage(): { text: string; keyboard: InlineKeyboard } {
  return {
    text: [
      "🔎 У этого сайта есть свой поиск.",
      "",
      "Могу вводить в него ваши ключевые слова — тогда лишнего будет приходить меньше.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("🔎 Искать через сайт", "site_search_on")
      .text("Читать весь список", "site_search_off"),
  };
}

/* ---------- карточка сайта ---------- */

/** Что бот умеет показывать по сохранённым правилам — человеческим языком. */
export function siteFieldsLine(selectors: Selectors): string {
  return fieldsSummary({ date: selectors.date, price: selectors.price });
}

/**
 * Что показать вместо прошлой ошибки. В базу она попадает такой, какой её
 * вернула площадка, и человеку в этом виде бесполезна: ему важно, кончилось ли
 * дело неответом сайта или чем-то, что он может поправить сам.
 */
export function lastErrorLine(error: string): string {
  const technical = /\bHTTP\s+\d{3}\b|fetch|timeout|abort|network|ENOTFOUND|ECONN/i.test(error);
  return technical
    ? "⚠️ В прошлый раз площадка не ответила. Попробую снова при следующей проверке."
    : `⚠️ В прошлый раз получилось не всё: ${escapeHtml(error)}`;
}

/**
 * Технические подробности. Живут за отдельной кнопкой: на главном пути они
 * пугают, но при разборе сложного сайта без них не обойтись.
 */
export function advancedDetails(site: Site): { text: string; keyboard: InlineKeyboard } {
  const row = (label: string, value?: string): string | null =>
    value ? `${label}: <code>${escapeHtml(value)}</code>` : null;

  const lines = [
    `⚙️ <b>Подробности — ${escapeHtml(site.title)}</b>`,
    "Эта часть нужна редко: здесь правила, по которым я разбираю страницу.",
    "",
    row("Карточка", site.selectors.item),
    row("Заголовок", site.selectors.title),
    row("Ссылка", site.selectors.link),
    row("Дата", site.selectors.date),
    row("Цена", site.selectors.price),
  ].filter((line): line is string => line !== null);

  if (site.search.mode === "query") {
    lines.push("", `Поиск: <code>${escapeHtml(site.search.action ?? "")}</code>`);
    if (site.search.param) lines.push(`Поле запроса: <code>${escapeHtml(site.search.param)}</code>`);
  }

  const keyboard = new InlineKeyboard()
    .text("✍️ Задать правила заново", `site_manual_edit:${site.id}`)
    .row()
    .text("⬅️ К сайту", `site:${site.id}`);

  return { text: lines.join("\n"), keyboard };
}

/* ---------- проверка сайта кнопкой ---------- */

/** Успешная проверка: сколько позиций и что распознано. Правил разбора не показываем. */
export function testReport(
  site: Site,
  url: string,
  items: ScrapedItem[],
  guessed: GuessedFields,
): string {
  const lines = [`🧪 <b>Проверка — ${escapeHtml(site.title)}</b>`];
  const link = linkLine(url, "Страница, которую я читаю");
  if (link) lines.push(link);
  lines.push("", describeItems(items, guessed), "", `Режим: ${searchModeText(site.search)}`);
  return lines.join("\n");
}

/** Проверка не удалась: причина обычными словами плюс ссылка на страницу. */
export function testFailedReport(site: Site, url: string, diagnosis: PageDiagnosis): string {
  return [`🧪 <b>Проверка — ${escapeHtml(site.title)}</b>`, "", explainDiagnosis(diagnosis, url).text].join(
    "\n",
  );
}

/* ---------- ручной ввод ---------- */

export const MANUAL_HINT = [
  "⚙️ Режим для продвинутых.",
  "",
  "Если вы знаете, как устроена страница, пришлите правила построчно (обязательна только первая строка):",
  "",
  "<code>item: div.tender-card</code>",
  "<code>title: a.title</code>",
  "<code>link: a.title</code>",
  "<code>date: .date</code>",
  "<code>price: .price</code>",
  "",
  "Не про вас? Нажмите «⭐ Готовые площадки» — там всё уже настроено.",
  "",
  "/cancel — отмена",
].join("\n");

/**
 * Разбирает правила разбора, введённые вручную:
 *   item: div.card
 *   title: a.name
 * Путь для продвинутых: обычный человек сюда не заходит, но у того, кто зашёл,
 * ошибка в строке не должна тихо превращаться в сайт, читающий пустоту.
 */
export function parseManualSelectors(input: string): Selectors | null {
  const result: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const match = /^\s*(item|title|link|date|price)\s*[:=]\s*(.+?)\s*$/i.exec(line);
    if (match) result[match[1].toLowerCase()] = match[2];
  }
  return result.item ? (result as Selectors) : null;
}

export const MANUAL_RETRY = [
  "Не вижу первой строки вида <code>item: …</code>.",
  "",
  "Попробуйте ещё раз или /cancel.",
].join("\n");
