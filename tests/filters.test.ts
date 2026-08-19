import { test } from "node:test";
import assert from "node:assert/strict";
import { describeForm, detectFilterForms } from "../src/lib/filters.ts";

const BASE = "https://zakupki.example.kg/tenders/list";

const searchFormHtml = `
<html><body>
  <header class="site-header">
    <form action="/search" method="get" role="search">
      <input type="text" name="q" placeholder="Поиск по сайту">
      <button type="submit">Найти</button>
    </form>
  </header>
</body></html>`;

const filterFormHtml = `
<html><body>
  <form action="/tenders/search" method="get" class="tender-filter">
    <label for="kw">Наименование закупки</label>
    <input id="kw" type="text" name="q">
    <label for="reg">Регион</label>
    <select id="reg" name="region">
      <option value="">Все регионы</option>
      <option value="1">Ошская область</option>
      <option value="2" selected>Бишкек</option>
      <option value="3">Нарынская область</option>
    </select>
    <label for="cat">Категория</label>
    <select id="cat" name="category">
      <option value="">Все категории</option>
      <option value="10">Строительство</option>
      <option value="20">Медикаменты</option>
    </select>
    <label for="df">Дата с</label>
    <input id="df" type="date" name="date_from">
    <label for="dt">Дата по</label>
    <input id="dt" type="date" name="date_to">
    <input type="hidden" name="csrf" value="a1b2">
    <button type="submit">Показать</button>
  </form>
</body></html>`;

test("находит форму поиска с полем q", () => {
  const forms = detectFilterForms(searchFormHtml, BASE);

  assert.equal(forms.length, 1);
  assert.equal(forms[0].searchField, "q");
  assert.equal(forms[0].action, "https://zakupki.example.kg/search");
  assert.equal(forms[0].method, "get");
  // Поиск по всему сайту работает, но ищет не только тендеры — оценка средняя.
  assert.ok(forms[0].score > 0 && forms[0].score <= 0.5, `score=${forms[0].score}`);
});

test("разбирает форму фильтров с селектами и датами", () => {
  const [form] = detectFilterForms(filterFormHtml, BASE);

  assert.equal(form.action, "https://zakupki.example.kg/tenders/search");
  assert.equal(form.searchField, "q");
  assert.deepEqual(
    form.fields.map((f) => f.name),
    ["q", "region", "category", "date_from", "date_to", "csrf"],
  );

  const region = form.fields.find((f) => f.name === "region");
  assert.equal(region?.kind, "select");
  assert.equal(region?.label, "Регион");
  assert.equal(region?.options?.length, 4);
  assert.equal(region?.defaultValue, "2");
  assert.equal(region?.options?.[1].label, "Ошская область");

  assert.equal(form.fields.find((f) => f.name === "date_from")?.kind, "date");
  assert.equal(form.fields.find((f) => f.name === "csrf")?.kind, "hidden");
  assert.ok(form.score > 0.8, `score=${form.score}`);
});

test("формы входа и подписки не возвращаются", () => {
  const html = `
    <html><body>
      <form action="/login" method="post" class="login-form">
        <input type="text" name="username" placeholder="Логин">
        <input type="password" name="password">
        <button>Войти</button>
      </form>
      <form action="/subscribe" method="post">
        <input type="text" name="email" placeholder="Ваш e-mail">
        <button>Подписаться</button>
      </form>
    </body></html>`;

  assert.deepEqual(detectFilterForms(html, BASE), []);
});

test("поля без name пропускаются", () => {
  const html = `
    <html><body>
      <form action="/list">
        <input type="text" placeholder="Поиск без имени">
        <select><option value="1">Ош</option><option value="2">Бишкек</option></select>
        <input type="text" name="q" placeholder="Поиск по наименованию">
        <select name="region">
          <option value="1">Ош</option><option value="2">Бишкек</option><option value="3">Нарын</option>
        </select>
      </form>
    </body></html>`;

  const [form] = detectFilterForms(html, BASE);
  assert.deepEqual(
    form.fields.map((f) => f.name),
    ["q", "region"],
  );
});

test("подпись берётся из label, placeholder, aria-label, title, соседнего текста или name", () => {
  const html = `
    <html><body>
      <form action="/list">
        <label for="a">Регион закупки</label><input id="a" type="text" name="a">
        <input type="text" name="b" placeholder="Введите номер лота">
        <input type="text" name="c" aria-label="Организатор">
        <input type="text" name="d" title="Цена от">
        <div><span>Заказчик:</span><input type="text" name="e"></div>
        <div><input type="text" name="f"></div>
      </form>
    </body></html>`;

  const [form] = detectFilterForms(html, BASE);
  const labels = Object.fromEntries(form.fields.map((f) => [f.name, f.label]));

  assert.deepEqual(labels, {
    a: "Регион закупки",
    b: "Введите номер лота",
    c: "Организатор",
    d: "Цена от",
    e: "Заказчик",
    f: "f",
  });
});

test("находит фильтры, лежащие вне <form>", () => {
  const html = `
    <html><body>
      <div class="filter-panel">
        <input type="text" name="q" placeholder="Поиск по наименованию">
        <select name="region">
          <option value="">Все регионы</option>
          <option value="1">Ош</option>
          <option value="2">Бишкек</option>
          <option value="3">Нарын</option>
        </select>
        <button class="btn">Найти</button>
      </div>
    </body></html>`;

  const forms = detectFilterForms(html, BASE);

  assert.equal(forms.length, 1);
  assert.equal(forms[0].action, BASE);
  assert.equal(forms[0].method, "get");
  assert.equal(forms[0].searchField, "q");
  assert.equal(forms[0].fields.find((f) => f.name === "region")?.options?.length, 4);
});

test("одинокое поле вне <form> формой не считается", () => {
  const html = `<html><body><div><input type="text" name="q"></div></body></html>`;
  assert.deepEqual(detectFilterForms(html, BASE), []);
});

test("action становится абсолютным, пустой action — это сам baseUrl", () => {
  const relative = `
    <html><body><form action="../search?type=1">
      <input type="text" name="q">
      <select name="r"><option value="1">Ош</option><option value="2">Бишкек</option></select>
    </form></body></html>`;
  const empty = `
    <html><body><form action="">
      <input type="text" name="query">
      <select name="r"><option value="1">Ош</option><option value="2">Бишкек</option></select>
    </form></body></html>`;

  assert.equal(
    detectFilterForms(relative, "https://zakupki.example.kg/tenders/list/")[0].action,
    "https://zakupki.example.kg/tenders/search?type=1",
  );
  assert.equal(detectFilterForms(empty, BASE)[0].action, BASE);
});

test("битый HTML и вложенные формы не роняют разбор", () => {
  const broken = `<div><form action="/s"><input name="q" type="text"><select name="r">
    <option>Ош<option>Бишкек</form><p>текст<div><span>ещё`;
  const nested = `<form action="/outer"><input type="text" name="q">
    <form action="/inner"><input type="text" name="query"></form>
    <select name="r"><option value="1">Ош</option><option value="2">Бишкек</option></select></form>`;

  assert.doesNotThrow(() => detectFilterForms(broken, BASE));
  assert.doesNotThrow(() => detectFilterForms(nested, BASE));
  assert.deepEqual(detectFilterForms("", BASE), []);
  assert.deepEqual(detectFilterForms("<<<>>", BASE), []);
  assert.ok(Array.isArray(detectFilterForms(broken, "не-урл")));
});

test("форма фильтров идёт выше поиска по сайту", () => {
  const page = searchFormHtml.replace("</body>", `${filterFormHtml}</body>`);
  const forms = detectFilterForms(page, BASE);

  assert.equal(forms.length, 2);
  assert.ok(forms[0].score > forms[1].score);
  assert.equal(forms[0].action, "https://zakupki.example.kg/tenders/search");
});

test("describeForm даёт короткий текст без разметки", () => {
  const [form] = detectFilterForms(filterFormHtml, BASE);
  const text = describeForm(form);

  assert.ok(text.length <= 400, `длина ${text.length}`);
  assert.ok(!text.includes("<") && !text.includes(">"));
  assert.match(text, /Поиск: «Наименование закупки» \(q\)/);
  assert.match(text, /Регион — 4 варианта/);
  assert.match(text, /Категория — 3 варианта/);
  // Скрытые поля пользователю не нужны.
  assert.ok(!text.includes("csrf"));
});

test("скрытые поля без name не порождают форму-призрак", () => {
  // Четыре безымянных input в общей обёртке раньше собирались в «панель фильтров»,
  // которая проглатывала поля настоящих форм и вставала первой в выдаче.
  const html = `
    <html><body>
      <div class="container">
        <input type="hidden" id="breadcrumb_title">
        <input type="hidden" id="breadcrumb_queryString">
        <input type="hidden" id="breadcrumb_keepBreadcrumb">
        <input type="hidden" id="breadcrumb_needUpdate">
        <form action="/atm" method="get">
          <input type="hidden" name="filter">
          <input type="text" name="Number" placeholder="ATM ID">
          <input type="text" name="Keyword" placeholder="Keyword">
        </form>
        <form action="/atm" method="get">
          <input type="hidden" name="Keyword">
          <select name="OrderBy"><option value="a">A</option><option value="b">B</option></select>
        </form>
      </div>
    </body></html>`;

  const forms = detectFilterForms(html, "https://tenders.example.au/atm");
  const names = forms.flatMap((form) => form.fields.map((field) => field.name));

  assert.equal(forms.length, 1, `формы: ${JSON.stringify(names)}`);
  assert.equal(forms[0].searchField, "Keyword");
  assert.deepEqual(forms[0].fields.map((f) => f.name), ["filter", "Number", "Keyword"]);
});

test("форма сортировки фильтром не считается", () => {
  const html = `
    <html><body>
      <form action="/Search/Results" method="post">
        <select name="sort">
          <option value="1">Relevance</option>
          <option value="2">Publication date</option>
          <option value="3">Closing date</option>
        </select>
        <input type="text" name="sort_js_enabled_select">
        <input type="text" name="sort_js_enabled">
        <input type="hidden" name="form_token" value="x">
      </form>
    </body></html>`;

  assert.deepEqual(detectFilterForms(html, BASE), []);
});

test("подпись берётся по aria-labelledby, а не из текста справки рядом", () => {
  const html = `
    <html><body>
      <form action="/Search/Results" method="post">
        <h2 id="keywords_id">Ключевые слова</h2>
        <button type="button">Как выполнить расширенный поиск? Используйте OR, AND или кавычки</button>
        <input type="text" name="keywords" aria-labelledby="keywords_id">
        <select name="region"><option value="1">Ош</option><option value="2">Бишкек</option></select>
      </form>
    </body></html>`;

  const [form] = detectFilterForms(html, BASE);

  assert.equal(form.searchField, "keywords");
  assert.equal(form.fields.find((f) => f.name === "keywords")?.label, "Ключевые слова");
});

test("длинный текст и вопрос соседней подписью не становятся", () => {
  const html = `
    <html><body>
      <form action="/list">
        <div><span>Как выполнить расширенный поиск по всем разделам площадки?</span><input type="text" name="q"></div>
        <select name="region"><option value="1">Ош</option><option value="2">Бишкек</option></select>
      </form>
    </body></html>`;

  const [form] = detectFilterForms(html, BASE);

  assert.equal(form.fields.find((f) => f.name === "q")?.label, "q");
});

test("имя, сгенерированное фреймворком, подписью не работает", () => {
  const html = `
    <html><body>
      <form action="/list.xhtml" method="post">
        <input type="text" name="tv1:search-field-e">
        <select name="tv1:ate"><option value="1">Ош</option><option value="2">Бишкек</option></select>
        <script>PrimeFaces.cw("Watermark", "w1", {});</script>
      </form>
    </body></html>`;

  const [form] = detectFilterForms(html, "https://zakupki.example.kg/list.xhtml");

  assert.equal(form.searchField, "tv1:search-field-e");
  assert.equal(form.fields.find((f) => f.name === "tv1:search-field-e")?.label, "без подписи");
  assert.ok(!describeForm(form).includes("j_idt"));
});

test("одинаковые формы схлопываются в одну — самую полную", () => {
  const one = `<form action="/search" method="get"><input type="text" name="q">
    <select name="r"><option value="1">Ош</option><option value="2">Бишкек</option></select></form>`;
  const two = `<form action="/search" method="get"><input type="text" name="q">
    <select name="r"><option value="1">Ош</option><option value="2">Бишкек</option></select>
    <input type="date" name="from"></form>`;

  const forms = detectFilterForms(`<html><body>${one}${two}</body></html>`, BASE);

  assert.equal(forms.length, 1);
  assert.equal(forms[0].fields.length, 3, "остаётся форма с большим числом фильтров");
});
