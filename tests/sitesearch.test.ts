import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFilterForms } from "../src/lib/filters.ts";
import { buildSearchUrl, pickSearchForm, searchFromForm } from "../src/lib/searchurl.ts";
import type { FilterForm } from "../src/lib/types.ts";

function form(overrides: Partial<FilterForm>): FilterForm {
  return {
    action: "https://zakupki.example.kg/search",
    method: "get",
    fields: [],
    searchField: null,
    score: 0.5,
    ...overrides,
  };
}

test("форму с полем поиска превращает в режим query", () => {
  const search = searchFromForm(
    form({ searchField: "q", action: "https://zakupki.example.kg/search" }),
  );

  assert.deepEqual(search, {
    mode: "query",
    action: "https://zakupki.example.kg/search",
    method: "get",
    param: "q",
  });
});

test("без поля поиска конфиг не собирается", () => {
  assert.equal(searchFromForm(form({ searchField: null })), null);
});

test("при сопоставимом качестве предпочитается GET", () => {
  const best = pickSearchForm([
    form({ searchField: "keyword", method: "post", score: 0.7 }),
    form({ searchField: "q", method: "get", score: 0.6 }),
  ]);

  assert.equal(best?.searchField, "q");
  assert.equal(best?.method, "get");
});

test("заметно лучшая POST-форма выигрывает у слабого поиска по сайту", () => {
  const best = pickSearchForm([
    form({ searchField: "q", method: "post", score: 0.95, action: "https://zakupki.example.kg/tenders/list" }),
    form({ searchField: "s", method: "get", score: 0.45 }),
  ]);

  assert.equal(best?.method, "post");
  assert.equal(best?.action, "https://zakupki.example.kg/tenders/list");
});

test("если GET-форм нет, годится и POST", () => {
  const best = pickSearchForm([form({ searchField: "keyword", method: "post" })]);
  assert.equal(best?.method, "post");
});

test("форма без поля поиска в выбор не попадает", () => {
  assert.equal(pickSearchForm([form({ searchField: null })]), null);
});

const listHtml = `
<html><body>
  <header>
    <form class="site-search" action="/search"><input type="text" name="s" placeholder="Поиск по сайту"></form>
  </header>
  <main>
    <form action="/tenders/list" method="get">
      <label for="q">Наименование закупки</label>
      <input type="text" id="q" name="q">
      <label for="region">Регион</label>
      <select id="region" name="region">
        <option value="">Все</option>
        <option value="7">Ошская область</option>
        <option value="1">Бишкек</option>
      </select>
      <input type="date" name="from">
      <button type="submit">Найти</button>
    </form>
  </main>
</body></html>`;

test("вся цепочка: со страницы находится форма фильтра и по ней строится URL поиска", () => {
  const forms = detectFilterForms(listHtml, "https://zakupki.example.kg/tenders");
  const best = pickSearchForm(forms);
  assert.ok(best, "форма фильтра должна найтись");

  const search = searchFromForm(best);
  assert.ok(search);
  assert.equal(search.param, "q");
  assert.equal(search.action, "https://zakupki.example.kg/tenders/list");

  const url = buildSearchUrl(search, "ремонт*", "https://zakupki.example.kg/tenders");
  assert.equal(url, "https://zakupki.example.kg/tenders/list?q=%D1%80%D0%B5%D0%BC%D0%BE%D0%BD%D1%82");
});
