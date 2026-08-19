import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl, keywordWindowOffset, searchUrlsFor } from "../src/lib/searchurl.ts";
import type { SiteSearch } from "../src/lib/types.ts";

const LIST_URL = "https://zakupki.example.kg/tenders";

const search: SiteSearch = {
  mode: "query",
  action: "https://zakupki.example.kg/search",
  method: "get",
  param: "q",
};

test("подставляет кириллическое слово и кодирует его", () => {
  const url = buildSearchUrl(search, "ремонт", LIST_URL);

  assert.equal(new URL(url).searchParams.get("q"), "ремонт");
  assert.match(url, /^[\x20-\x7e]+$/, "в URL не должно остаться сырой кириллицы");
});

test("хвостовая звёздочка матчера не уходит на сайт", () => {
  assert.equal(buildSearchUrl(search, "ремонт*", LIST_URL), buildSearchUrl(search, "ремонт", LIST_URL));
});

test("фраза в кавычках уходит как фраза с закодированным пробелом", () => {
  const url = buildSearchUrl(search, '"ремонт кровли"', LIST_URL);

  assert.equal(new URL(url).searchParams.get("q"), "ремонт кровли");
  assert.ok(!url.includes(" "), "пробел должен быть закодирован");
});

test("минус-слово не ищется на сайте", () => {
  assert.equal(buildSearchUrl(search, "-аренда", LIST_URL), LIST_URL);
  assert.equal(buildSearchUrl(search, "   ", LIST_URL), LIST_URL);
});

test("extra перезаписывает одноимённые параметры action", () => {
  const withExtra: SiteSearch = {
    ...search,
    action: "https://zakupki.example.kg/search?region=0&page=1",
    extra: { region: "7", status: "active" },
  };

  const params = new URL(buildSearchUrl(withExtra, "кровля", LIST_URL)).searchParams;
  assert.equal(params.get("region"), "7");
  assert.equal(params.get("status"), "active");
  assert.equal(params.get("page"), "1");
  assert.equal(params.get("q"), "кровля");
});

test("extra не затирает поле поиска", () => {
  const shadowing: SiteSearch = { ...search, extra: { q: "" } };

  assert.equal(new URL(buildSearchUrl(shadowing, "кровля", LIST_URL)).searchParams.get("q"), "кровля");
});

test("без режима query или без настроек формы отдаём страницу списка", () => {
  assert.equal(buildSearchUrl({ mode: "off" }, "ремонт", LIST_URL), LIST_URL);
  assert.equal(buildSearchUrl({ mode: "query", param: "q" }, "ремонт", LIST_URL), LIST_URL);
  assert.equal(buildSearchUrl({ mode: "query", action: search.action }, "ремонт", LIST_URL), LIST_URL);
});

test("битый action не роняет сборку URL", () => {
  const broken: SiteSearch = { ...search, action: "/search?q=" };

  assert.equal(buildSearchUrl(broken, "ремонт", LIST_URL), LIST_URL);
});

test("одинаковые по сути слова дают один URL", () => {
  const urls = searchUrlsFor(search, ["ремонт", "ремонт*", '"ремонт"'], LIST_URL);

  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get("q"), "ремонт");
});

test("минус-слова и пустые строки в список не попадают", () => {
  const urls = searchUrlsFor(search, ["-аренда", "", "  ", "кровля"], LIST_URL);

  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get("q"), "кровля");
});

test("лимит обрезает список ключевых слов", () => {
  const many = Array.from({ length: 12 }, (_, index) => `слово${index}`);

  assert.equal(searchUrlsFor(search, many, LIST_URL).length, 8);
  assert.equal(searchUrlsFor(search, many, LIST_URL, 3).length, 3);
  assert.equal(
    new URL(searchUrlsFor(search, many, LIST_URL, 3)[0]).searchParams.get("q"),
    "слово0",
    "берём первые слова, а не случайные",
  );
});

test("без режима query или без слов проверяем обычную страницу списка", () => {
  assert.deepEqual(searchUrlsFor({ mode: "off" }, ["ремонт"], LIST_URL), [LIST_URL]);
  assert.deepEqual(searchUrlsFor(search, [], LIST_URL), [LIST_URL]);
  assert.deepEqual(searchUrlsFor(search, ["-аренда"], LIST_URL), [LIST_URL]);
});

test("окно слов сдвигается, поэтому хвост списка тоже попадает в поиск", () => {
  const many = Array.from({ length: 12 }, (_, index) => `слово${index}`);
  const words = (offset: number) =>
    searchUrlsFor(search, many, LIST_URL, 8, offset).map(
      (url) => new URL(url).searchParams.get("q"),
    );

  assert.deepEqual(words(0).slice(0, 2), ["слово0", "слово1"]);
  // Без сдвига слова с 9-го никогда бы не искались: порядок в БД стабилен.
  assert.deepEqual(words(8).slice(0, 4), ["слово8", "слово9", "слово10", "слово11"]);
  assert.ok(words(8).includes("слово11"));
  assert.equal(words(8).length, 8, "окно всегда полное — оно заворачивается по кругу");
  assert.deepEqual(words(12), words(0), "сдвиг на длину списка возвращает то же окно");
  assert.deepEqual(words(-4), words(8), "отрицательный сдвиг не ломает окно");
});

test("сдвиг ничего не меняет, когда слов меньше лимита", () => {
  assert.deepEqual(
    searchUrlsFor(search, ["ремонт"], LIST_URL, 8, 0),
    searchUrlsFor(search, ["ремонт"], LIST_URL, 8, 5),
  );
});

test("сдвиг окна привязан к сайту и к времени прошлой проверки", () => {
  const first = keywordWindowOffset(1, "2026-08-19T10:00:00.000Z");
  const later = keywordWindowOffset(1, "2026-08-19T10:15:00.000Z");
  const other = keywordWindowOffset(2, "2026-08-19T10:00:00.000Z");

  assert.notEqual(first, later, "между прогонами окно должно съезжать");
  assert.notEqual(first, other, "два сайта не обязаны идти в ногу");
  assert.equal(keywordWindowOffset(3, null), 0, "сайт без проверок начинает с начала списка");
});

test("ровный интервал крона не загоняет окно в одно и то же место", () => {
  // Сдвиг «секунды % длина списка» при проверке раз в 15 минут давал бы одно
  // и то же окно на каждом прогоне, и хвост слов не искался бы никогда.
  const offsets = [0, 15, 30, 45, 60, 75].map((minute) =>
    keywordWindowOffset(1, new Date(Date.UTC(2026, 7, 19, 10, minute)).toISOString()) % 12,
  );

  assert.ok(new Set(offsets).size >= 3, `окна повторяются: ${offsets}`);
});

test("за несколько прогонов в поиск уходят все слова, а не первые восемь", () => {
  const many = Array.from({ length: 12 }, (_, index) => `слово${index}`);
  const seen = new Set<string>();

  for (const offset of [0, 4, 8]) {
    for (const url of searchUrlsFor(search, many, LIST_URL, 8, offset)) {
      seen.add(new URL(url).searchParams.get("q") ?? "");
    }
  }

  assert.equal(seen.size, many.length, `не искались: ${many.filter((w) => !seen.has(w))}`);
});
