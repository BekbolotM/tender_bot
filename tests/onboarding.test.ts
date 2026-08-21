import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard } from "grammy";
import type { CatalogEntry } from "../src/lib/catalog.ts";
import {
  advancedDetails,
  ADVANCED_LABEL,
  ASK_URL_TEXT,
  askExampleAgain,
  canTeachByExample,
  candidatesMessage,
  catalogFailed,
  catalogFound,
  catalogMenu,
  exampleFailedMessage,
  exampleFoundMessage,
  httpStatusFromError,
  lastErrorLine,
  learnByExampleMessage,
  MANUAL_RETRY,
  NOT_A_LINK_TEXT,
  parseManualSelectors,
  sameListUrl,
  searchModeText,
  searchOfferMessage,
  siteFieldsLine,
  tendersWord,
  testFailedReport,
  testReport,
} from "../src/lib/bot/onboarding.ts";
import { siteCard, sitesMenu } from "../src/lib/bot/menus.ts";
import type { PageDiagnosis } from "../src/lib/pagestate.ts";
import type { ScrapedItem, Selectors, Site } from "../src/lib/types.ts";

/* ---------- вспомогательное ---------- */

type Button = { text: string; data: string };

function buttons(keyboard: InlineKeyboard): Button[] {
  return keyboard.inline_keyboard.flat().map((button) => ({
    text: button.text,
    data: (button as { callback_data?: string }).callback_data ?? "",
  }));
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "kg-demo",
    title: "Демо-закупки",
    country: "Кыргызстан",
    listUrl: "https://demo.example.kg/tenders",
    selectors: { item: "div.card", title: "a" },
    ...overrides,
  };
}

function item(overrides: Partial<ScrapedItem> = {}): ScrapedItem {
  return {
    title: "Поставка канцелярских товаров для школы №12",
    url: "https://demo.example.kg/tenders/1",
    date: "18.08.2026",
    price: "120 000 сом",
    text: "Поставка канцелярских товаров",
    ...overrides,
  };
}

function site(overrides: Partial<Site> = {}): Site {
  return {
    id: 7,
    title: "Демо-закупки",
    list_url: "https://demo.example.kg/tenders",
    selectors: { item: "div.card", title: "a", date: ".date" },
    search: { mode: "off" },
    via_local: false,
    enabled: true,
    last_checked_at: null,
    last_error: null,
    ...overrides,
  };
}

/**
 * Слова, которых человек в боте видеть не должен. Он не программист: увидев
 * «селектор» или «HTTP 403», он не узнает ничего нового, зато решит, что бот
 * сломался и починить его может только специалист.
 */
const FORBIDDEN = [
  "селектор",
  "css",
  "html",
  "http 4",
  "http 5",
  "403",
  "404",
  "dom",
  "парсинг",
  "парсер",
  "json",
  "api",
  "javascript",
  "item:",
  "тег",
];

function assertHuman(text: string, where: string): void {
  const lower = text.toLowerCase();
  for (const word of FORBIDDEN) {
    assert.ok(!lower.includes(word), `«${word}» просочилось в ${where}:\n${text}`);
  }
}

/* ---------- меню сайтов ---------- */

test("готовые площадки — первая кнопка в меню сайтов, выше добавления по ссылке", () => {
  const rows = buttons(sitesMenu([site()]).keyboard);
  const catalogAt = rows.findIndex((button) => button.data === "catalog");
  const addAt = rows.findIndex((button) => button.data === "site_add");

  assert.equal(catalogAt, 0);
  assert.ok(catalogAt < addAt, "каталог должен стоять выше ручного добавления");
});

test("пустой список сайтов зовёт в каталог, а не просит ссылку", () => {
  const { text } = sitesMenu([]);
  assert.match(text, /Готовые площадки/);
  assertHuman(text, "пустое меню сайтов");
});

/* ---------- каталог ---------- */

test("каталог помечает уже добавленные площадки галочкой", () => {
  const entries = [entry(), entry({ id: "kz-demo", listUrl: "https://demo.example.kz/list" })];
  const rows = buttons(catalogMenu(entries, ["https://www.demo.example.kg/tenders/"]).keyboard);

  assert.match(rows[0].text, /^✅/);
  assert.equal(rows[0].data, "cat:kg-demo");
  assert.match(rows[1].text, /^➕/);
  assert.equal(rows[1].data, "cat:kz-demo");
});

test("адрес площадки узнаётся с www и без хвостовой косой черты", () => {
  assert.ok(sameListUrl("https://www.demo.kg/tenders/", "https://demo.kg/tenders"));
  assert.ok(!sameListUrl("https://demo.kg/tenders", "https://demo.kg/archive"));
  assert.ok(sameListUrl("https://demo.kg/s?f=all", "https://DEMO.kg/s?f=all"));
});

test("проверенная площадка показывает находку, заметку и кнопку добавления", () => {
  const note = "Площадка показывает только 10 свежих объявлений.";
  const { text, keyboard } = catalogFound(entry({ note }), [item(), item()], { date: ".date" });

  assert.match(text, /Демо-закупки/);
  assert.match(text, /Поставка канцелярских/);
  assert.match(text, /Площадка показывает только 10/);
  assert.match(text, /Добавляем эту площадку\?/);
  assert.equal(buttons(keyboard)[0].data, "cat_add:kg-demo");
  assertHuman(text, "карточку площадки из каталога");
});

test("неотвечающая площадка объясняет причину и предлагает вернуться к списку", () => {
  const blocked: PageDiagnosis = { kind: "blocked" };
  const { text, keyboard } = catalogFailed(entry(), blocked);

  assert.match(text, /не пускает/);
  assert.deepEqual(
    buttons(keyboard).map((button) => button.data),
    ["catalog"],
    "безнадёжную площадку перепроверять незачем",
  );
  assertHuman(text, "отказ площадки из каталога");
});

test("площадку, которая просто молчит, можно перепроверить кнопкой", () => {
  const down: PageDiagnosis = { kind: "site_down" };
  const rows = buttons(catalogFailed(entry(), down).keyboard);
  assert.equal(rows[0].data, "cat:kg-demo");
});

/* ---------- разбор присланной ссылки ---------- */

test("просьба о ссылке объясняет, где её взять, и зовёт в каталог", () => {
  assert.match(ASK_URL_TEXT, /адресной строки/);
  assert.match(ASK_URL_TEXT, /Готовые площадки/);
  assertHuman(NOT_A_LINK_TEXT, "ответ на не-ссылку");
});

test("варианты списков показывают заголовки, а не правила разбора", () => {
  const candidate = {
    selectors: { item: "div.card", title: "a" } as Selectors,
    count: 21,
    preview: [item(), item({ title: "Ремонт кровли детского сада" })],
  };
  const { text, keyboard } = candidatesMessage([candidate, { ...candidate, count: 3 }], [2, 0]);

  assert.ok(!text.includes("div.card"), "правило разбора не должно попадать в сообщение");
  assert.ok(text.includes("21 тендер,"), "склонение должно быть по числу позиций");
  assert.match(text, /подходит 2/);
  assert.match(text, /Ремонт кровли/);
  assertHuman(text, "выбор варианта списка");

  const rows = buttons(keyboard);
  assert.equal(rows[0].data, "site_pick:0");
  assert.equal(rows[1].data, "site_pick:1");
  assert.ok(
    rows.some((button) => button.text === ADVANCED_LABEL && button.data === "site_manual"),
    "ручной ввод остаётся, но отдельной кнопкой",
  );
});

test("единственный вариант не называется «несколько списков»", () => {
  const one = {
    selectors: { item: "div.card" } as Selectors,
    count: 1,
    preview: [item()],
  };
  const { text } = candidatesMessage([one]);
  assert.ok(!text.includes("несколько"));
  assert.ok(text.includes("— 1 тендер\n"));
});

test("склонение числа тендеров", () => {
  assert.equal(tendersWord(1), "тендер");
  assert.equal(tendersWord(3), "тендера");
  assert.equal(tendersWord(11), "тендеров");
  assert.equal(tendersWord(21), "тендер");
  assert.equal(tendersWord(112), "тендеров");
});

/* ---------- обучение по примеру ---------- */

test("обучение по примеру предлагается только там, где оно может сработать", () => {
  assert.ok(canTeachByExample({ kind: "unknown" }));
  for (const kind of ["login_required", "captcha", "blocked", "javascript", "not_found"] as const) {
    assert.ok(!canTeachByExample({ kind }), `${kind} — образец не поможет`);
  }
});

test("непонятная страница получает причину и просьбу прислать пример", () => {
  const { text, keyboard } = learnByExampleMessage({ kind: "unknown" }, "https://demo.kg/list");

  assert.match(text, /привычного перечня объявлений/);
  assert.match(text, /Откройте эту страницу в браузере/);
  assert.match(text, /скопируйте его название целиком/);
  assertHuman(text, "просьбу об образце");

  const data = buttons(keyboard).map((button) => button.data);
  assert.deepEqual(data, ["catalog", "site_add", "site_manual", "cancel"]);
});

test("закрытая площадка образца не просит — там его негде взять", () => {
  const { text } = learnByExampleMessage({ kind: "login_required" }, "https://demo.kg/list");
  assert.ok(!text.includes("скопируйте"), "просить образец у страницы входа бессмысленно");
  assert.match(text, /только своим пользователям/);
  assertHuman(text, "объяснение про страницу входа");
});

test("повторная просьба об образце содержит те же три шага и ссылку", () => {
  const text = askExampleAgain("https://demo.kg/list");
  assert.match(text, /1\. Откройте/);
  assert.match(text, /2\. Найдите/);
  assert.match(text, /3\. Выделите/);
  assert.match(text, /<a href="https:\/\/demo\.kg\/list">/);
});

test("каждая неудача с образцом объясняет, что сделать иначе", () => {
  const cases = {
    too_short: /целиком/,
    not_found: /той самой страницы/,
    single_item: /списком друг под другом/,
    uneven: /другого тендера/,
  } as const;

  for (const [reason, expected] of Object.entries(cases)) {
    const { text, keyboard } = exampleFailedMessage(reason as keyof typeof cases);
    assert.match(text, expected as RegExp);
    assertHuman(text, `неудачу «${reason}»`);
    assert.ok(buttons(keyboard).some((button) => button.data === "catalog"));
  }
});

test("узнанный по образцу список показывает находку и просит подтвердить", () => {
  const { text, keyboard } = exampleFoundMessage([item(), item()], { date: ".date" });

  assert.match(text, /Получилось/);
  assert.match(text, /Поставка канцелярских/);
  assert.match(text, /это тендеры\?/);
  assertHuman(text, "подтверждение образца");

  assert.deepEqual(
    buttons(keyboard).map((button) => button.data),
    ["ex_ok", "ex_retry", "cancel"],
  );
});

test("пустой список по образцу не выдаётся за удачу", () => {
  const { text } = exampleFoundMessage([], {});
  assert.match(text, /Не нашёл ни одной позиции/);
});

/* ---------- карточка сайта ---------- */

test("карточка сайта показывает распознанные поля, а не правила разбора", () => {
  const { text, keyboard } = siteCard(site({ selectors: { item: "div.card", date: ".d" } }));

  assert.ok(!text.includes("div.card"), "правило разбора ушло в подробности для продвинутых");
  assert.match(text, /Показываю: дата/);
  assertHuman(text, "карточку сайта");

  assert.ok(buttons(keyboard).some((button) => button.data === "site_raw:7"));
});

test("что именно бот показывает — человеческой строкой", () => {
  assert.equal(siteFieldsLine({ item: "li" }), "только название и ссылка");
  assert.equal(siteFieldsLine({ item: "li", date: ".d", price: ".p" }), "дата, цена");
});

test("подробности для продвинутых — единственное место с правилами разбора", () => {
  const { text, keyboard } = advancedDetails(
    site({ selectors: { item: "div.card", title: "a.name" } }),
  );

  assert.match(text, /<code>div\.card<\/code>/);
  assert.match(text, /<code>a\.name<\/code>/);
  assert.deepEqual(
    buttons(keyboard).map((button) => button.data),
    ["site_manual_edit:7", "site:7"],
  );
});

test("режим поиска подписан смыслом, а не именем поля формы", () => {
  assert.match(searchModeText({ mode: "off" }), /весь|список целиком|страницу списка/);
  const query = searchModeText({ mode: "query", action: "https://demo.kg/s", param: "filter[name]" });
  assert.ok(!query.includes("filter[name]"));
  assert.match(query, /поиск на сайте/);
});

test("предложение искать через сайт объясняет выгоду человеку", () => {
  const { text, keyboard } = searchOfferMessage();
  assert.match(text, /лишнего будет приходить меньше/);
  assertHuman(text, "предложение поиска");
  assert.deepEqual(
    buttons(keyboard).map((button) => button.data),
    ["site_search_on", "site_search_off"],
  );
});

/* ---------- проверка сайта ---------- */

test("проверка показывает находку и режим, но не правила разбора", () => {
  const text = testReport(site(), "https://demo.example.kg/tenders", [item()], { price: ".p" });

  assert.ok(!text.includes("div.card"));
  assert.match(text, /Поставка канцелярских/);
  assert.match(text, /Режим:/);
  assertHuman(text, "отчёт проверки");
});

test("неудачная проверка объясняет причину словами площадки", () => {
  const text = testFailedReport(site(), "https://demo.example.kg/tenders", { kind: "captcha" });
  assert.match(text, /подтвердить, что страницу открывает человек/);
  assertHuman(text, "неудачную проверку");
});

test("прошлая ошибка пересказывается человеку, а не цитируется", () => {
  const silent = lastErrorLine("HTTP 403 Forbidden");
  assert.match(silent, /площадка не ответила/);
  assertHuman(silent, "строку о прошлой ошибке");

  assert.match(
    lastErrorLine("частично: 2 из 5 адресов недоступны"),
    /частично: 2 из 5 адресов недоступны/,
  );
});

/* ---------- разбор ответа площадки ---------- */

test("код ответа достаётся из ошибки загрузки — для объяснения, не для показа", () => {
  assert.equal(httpStatusFromError(new Error("HTTP 403 Forbidden")), 403);
  assert.equal(httpStatusFromError(new Error("HTTP 500 Internal Server Error")), 500);
  assert.equal(httpStatusFromError(new Error("The operation was aborted due to timeout")), undefined);
  assert.equal(httpStatusFromError("совсем не ошибка"), undefined);
});

/* ---------- ручной ввод ---------- */

test("подсказка о неверном ручном вводе не ругается и даёт выход", () => {
  assert.match(MANUAL_RETRY, /\/cancel/);
});

test("ручные правила разбираются построчно, лишние строки игнорируются", () => {
  const parsed = parseManualSelectors(
    ["привет!", "item: div.tender-card", "TITLE = a.title", "цена: .p", "date: .date"].join("\n"),
  );

  assert.deepEqual(parsed, { item: "div.tender-card", title: "a.title", date: ".date" });
});

test("без строки списка ручные правила не принимаются", () => {
  assert.equal(parseManualSelectors("title: a.title\ndate: .date"), null);
  assert.equal(parseManualSelectors(""), null);
});
