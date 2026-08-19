import { test } from "node:test";
import assert from "node:assert/strict";
import { matchExample, selectorsFromExample } from "../src/lib/byexample.ts";
import { extractItems } from "../src/lib/scrape.ts";

const BASE = "https://zakupki.example.kg/list";

/** Обычная лента карточек: заголовок-ссылка, дата, цена и кнопка «Подробнее». */
const cardsHtml = `
<html><body>
  <header><a href="/about">О площадке государственных закупок</a></header>
  <main>
    <div class="tender-list">
      ${[1, 2, 3, 4, 5]
        .map(
          (n) => `
      <div class="tender-card">
        <a class="tender-title" href="/tender/${n}">Ремонт кровли школы №${n} в городе Ош</a>
        <span class="tender-date">0${n}.09.2026</span>
        <span class="tender-price">1 200 000 сом</span>
        <a class="more" href="/tender/${n}">Подробнее</a>
      </div>`,
        )
        .join("")}
    </div>
  </main>
</body></html>`;

test("точный образец заголовка даёт селекторы всего списка", () => {
  const found = selectorsFromExample(cardsHtml, BASE, "Ремонт кровли школы №2 в городе Ош");

  assert.ok(found, "образец со страницы должен находиться");
  assert.equal(found.selectors.item, "div.tender-card");
  assert.equal(found.selectors.title, "a.tender-title");
  assert.equal(found.selectors.link, "a.tender-title");
  assert.equal(found.count, 5);
});

test("лишний хвост, прихваченный при копировании, не мешает", () => {
  // Человек выделил заголовок вместе с кнопкой под ним.
  const found = selectorsFromExample(
    cardsHtml,
    BASE,
    "Ремонт кровли школы №3 в городе Ош Подробнее",
  );

  assert.ok(found, "почти совпавший образец должен находиться");
  assert.equal(found.selectors.item, "div.tender-card");
  assert.equal(found.selectors.title, "a.tender-title");
});

test("двойные пробелы, nbsp и нулевой пробел не ломают поиск", () => {
  const messy = "Ремонт  кровли школы №4 в  городе​ Ош\n";
  const found = selectorsFromExample(cardsHtml, BASE, messy);

  assert.ok(found, "образец с невидимыми символами должен находиться");
  assert.equal(found.selectors.item, "div.tender-card");
  assert.equal(found.count, 5);
});

test("регистр и «ё» в образце не важны", () => {
  const yoHtml = `
    <html><body><div class="list">
      ${[1, 2, 3, 4]
        .map(
          (n) => `
        <article class="notice">
          <h3><a href="/n/${n}">Приобретение ёмкостей для питьевой воды в село Кызыл-Сай ${n}</a></h3>
          <a href="/n/${n}/docs">Документация</a>
        </article>`,
        )
        .join("")}
    </div></body></html>`;

  const found = selectorsFromExample(
    yoHtml,
    BASE,
    "ПРИОБРЕТЕНИЕ ЕМКОСТЕЙ ДЛЯ ПИТЬЕВОЙ ВОДЫ В СЕЛО КЫЗЫЛ-САЙ 2",
  );

  assert.ok(found, "«ё» и регистр не должны мешать совпадению");
  assert.equal(found.selectors.item, "article.notice");
  // Классов у заголовка нет — опора на позицию тега относительно карточки.
  assert.equal(found.selectors.title, "h3 > a");
  assert.equal(found.count, 4);
});

test("в таблице карточкой становится строка, а не ячейка", () => {
  const tableHtml = `
    <html><body><table><tbody class="ui-datatable-data">
      ${[1, 2, 3, 4, 5]
        .map(
          (n) => `
        <tr class="ui-widget-content ui-datatable-${n % 2 ? "odd" : "even"} ui-datatable-selectable">
          <td><span>№</span>2608195869486${n}</td>
          <td><span>Наименование закупки</span><span class="nameTender">Ремонт кабинета в средней школе №${n}</span></td>
          <td><a href="view.xhtml?id=5869486${n}"><i class="fa fa-external-link"></i></a></td>
        </tr>`,
        )
        .join("")}
    </tbody></table></body></html>`;

  const found = selectorsFromExample(
    tableHtml,
    "https://zakupki.example.kg/popp/view/order/list.xhtml",
    "Ремонт кабинета в средней школе №4",
  );

  assert.ok(found, "строка таблицы должна распознаваться как карточка");
  assert.equal(found.selectors.item, "tr.ui-widget-content.ui-datatable-selectable");
  assert.equal(found.selectors.title, "span.nameTender");
  assert.equal(found.count, 5);
  assert.equal(
    found.preview[0].url,
    "https://zakupki.example.kg/popp/view/order/view.xhtml?id=58694861",
  );
});

test("в таблице без классов заголовок находится по номеру колонки", () => {
  const tableHtml = `
    <html><body><table class="tenders">
      <thead><tr><th>№</th><th>Наименование</th><th>Открыть</th></tr></thead>
      <tbody>
        ${[1, 2, 3, 4, 5]
          .map(
            (n) => `
          <tr>
            <td>${n}</td>
            <td>Ремонт кабинета в средней школе №${n} города Каракол</td>
            <td><a href="/view/${n}">открыть</a></td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table></body></html>`;

  const found = selectorsFromExample(
    tableHtml,
    BASE,
    "Ремонт кабинета в средней школе №2 города Каракол",
  );

  assert.ok(found, "строка без классов должна распознаваться");
  assert.equal(found.selectors.item, "tbody > tr");
  assert.equal(found.selectors.title, "td:nth-of-type(2)");
  assert.equal(found.count, 5);
  assert.equal(found.preview[0].title, "Ремонт кабинета в средней школе №1 города Каракол");
});

test("список <li> распознаётся, а меню в селектор не попадает", () => {
  const listHtml = `
    <html><body>
      <nav><ul class="menu">
        <li><a href="/a">Закупки</a></li>
        <li><a href="/b">Контакты</a></li>
        <li><a href="/c">Помощь</a></li>
      </ul></nav>
      <ul class="notices">
        ${[1, 2, 3, 4]
          .map(
            (n) => `
          <li>
            <a href="/notice/${n}">Поставка канцелярских товаров для мэрии Бишкека ${n}</a>
            <span class="date">0${n}.09.2026</span>
          </li>`,
          )
          .join("")}
      </ul>
    </body></html>`;

  const found = selectorsFromExample(
    listHtml,
    BASE,
    "Поставка канцелярских товаров для мэрии Бишкека 3",
  );

  assert.ok(found, "список <li> должен распознаваться");
  // Голый `li` захватил бы и меню, поэтому селектор сужается родителем.
  assert.equal(found.selectors.item, "ul.notices > li");
  assert.equal(found.count, 4);
  assert.equal(found.preview[0].url, "https://zakupki.example.kg/notice/1");
});

test("заголовок, разбитый на вложенные <span> внутри ссылки, находится целиком", () => {
  const spansHtml = `
    <html><body><div class="results">
      ${[1, 2, 3, 4]
        .map(
          (n) => `
        <div class="result">
          <a class="link" href="/t/${n}">
            <span class="name">Строительство моста</span>
            <span class="place">через реку Нарын в селе Ат-Башы ${n}</span>
          </a>
        </div>`,
        )
        .join("")}
    </div></body></html>`;

  const found = selectorsFromExample(
    spansHtml,
    BASE,
    "Строительство моста через реку Нарын в селе Ат-Башы 2",
  );

  assert.ok(found, "текст из нескольких span внутри <a> должен собираться");
  assert.equal(found.selectors.item, "div.result");
  assert.equal(found.selectors.title, "a.link");
  assert.equal(found.count, 4);
});

test("образец, скопированный вместе с датой и ценой, всё равно даёт карточку", () => {
  const found = selectorsFromExample(
    cardsHtml,
    BASE,
    "Ремонт кровли школы №1 в городе Ош 01.09.2026 1 200 000 сом",
  );

  assert.ok(found, "образец шире заголовка должен приводить к карточке");
  assert.equal(found.selectors.item, "div.tender-card");
  assert.equal(found.selectors.link, "a.tender-title");
  assert.equal(found.count, 5);
  // Заголовок в уведомлении остаётся чистым, хотя человек прислал лишнее.
  assert.equal(found.preview[0].title, "Ремонт кровли школы №1 в городе Ош");
});

test("образца нет на странице — честный null", () => {
  const found = selectorsFromExample(
    cardsHtml,
    BASE,
    "Поставка вертолётов для министерства обороны республики",
  );

  assert.equal(found, null);
});

test("слишком короткий и пустой образец отвергаются", () => {
  assert.equal(selectorsFromExample(cardsHtml, BASE, "Ремонт"), null);
  assert.equal(selectorsFromExample(cardsHtml, BASE, "   \n  "), null);
  assert.equal(selectorsFromExample(cardsHtml, BASE, ""), null);
});

test("единственная позиция без похожих соседей списком не считается", () => {
  const singleHtml = `
    <html><body><main>
      <h1>Объявления</h1>
      <div class="tender-card">
        <a class="tender-title" href="/tender/7">Реконструкция здания детского сада в Нарыне</a>
      </div>
      <p>Других объявлений пока нет</p>
    </main></body></html>`;

  const found = selectorsFromExample(
    singleHtml,
    BASE,
    "Реконструкция здания детского сада в Нарыне",
  );

  assert.equal(found, null);
});

test("превью показывает первые позиции и содержит присланный образец", () => {
  const found = selectorsFromExample(cardsHtml, BASE, "Ремонт кровли школы №1 в городе Ош");

  assert.ok(found);
  assert.equal(found.preview.length, 3);
  assert.equal(found.preview[0].title, "Ремонт кровли школы №1 в городе Ош");
  assert.equal(found.preview[0].url, "https://zakupki.example.kg/tender/1");
  assert.ok(found.preview.some((item) => item.title.includes("Ремонт кровли школы №1")));
});

test("выданные селекторы действительно дают весь список, а не одну позицию", () => {
  const found = selectorsFromExample(cardsHtml, BASE, "Ремонт кровли школы №5 в городе Ош");

  assert.ok(found);
  const items = extractItems(cardsHtml, BASE, found.selectors);
  assert.equal(items.length, 5);
  assert.equal(items.length, found.count);
  assert.deepEqual(
    items.map((item) => item.url),
    [1, 2, 3, 4, 5].map((n) => `https://zakupki.example.kg/tender/${n}`),
  );
});

test("селектор не опирается на body и nth-child — иначе он сломается на второй странице", () => {
  const found = selectorsFromExample(cardsHtml, BASE, "Ремонт кровли школы №2 в городе Ош");

  assert.ok(found);
  const all = JSON.stringify(found.selectors);
  assert.ok(!/\bbody\b/.test(all), all);
  assert.ok(!/nth-child/.test(all), all);
});

test("нестабильные классы сборки в селектор не попадают", () => {
  const hashedHtml = `
    <html><body><div class="css-1a2b3c4d">
      ${[1, 2, 3, 4]
        .map(
          (n) => `
        <div class="lot-card css-9f8e7d6c">
          <a class="css-7g6h5j4k" href="/lot/${n}">Закупка компьютерной техники для управления образования ${n}</a>
        </div>`,
        )
        .join("")}
    </div></body></html>`;

  const found = selectorsFromExample(
    hashedHtml,
    BASE,
    "Закупка компьютерной техники для управления образования 1",
  );

  assert.ok(found, "карточки с хешированными классами должны находиться");
  assert.equal(found.selectors.item, "div.lot-card");
  assert.ok(!/css-/.test(JSON.stringify(found.selectors)), "классы сборки не опора");
  assert.equal(found.count, 4);
});

/* ---------- шум страницы не должен выигрывать у списка ---------- */

/** Боковой блок «Похожие закупки» с ТЕМИ ЖЕ заголовками стоит выше списка. */
const sidebarHtml = `
<html><body>
  <aside class="side">
    <h3>Похожие закупки</h3>
    <div class="box">
      ${[4, 5, 6]
        .map(
          (n) => `
      <div class="mini"><a href="/t/${n}">Ремонт кровли школы ${n} в городе Ош</a></div>`,
        )
        .join("")}
    </div>
  </aside>
  <main>
    <div class="list">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        .map(
          (n) => `
      <div class="card">
        <a class="name" href="/tender/${n}">Ремонт кровли школы ${n} в городе Ош</a>
        <span class="date">${n}.09.2026</span>
      </div>`,
        )
        .join("")}
    </div>
  </main>
</body></html>`;

test("боковой блок с теми же заголовками проигрывает основному списку", () => {
  const found = selectorsFromExample(sidebarHtml, BASE, "Ремонт кровли школы 4 в городе Ош");

  assert.ok(found, "список должен находиться");
  assert.equal(found.selectors.item, "div.card", "выбран сайдбар вместо списка");
  assert.equal(found.selectors.title, "a.name");
  assert.equal(found.count, 10);
  assert.equal(found.preview[0].url, "https://zakupki.example.kg/tender/1");
});

/** Виджет внутри <nav> ровно той же глубины и того же размера, что и список. */
const navWidgetHtml = `
<html><body>
  <nav class="menu">
    ${[1, 2, 3, 4, 5]
      .map(
        (n) => `
    <div class="mini"><a href="/t/${n}">Ремонт кровли школы ${n} в городе Ош</a></div>`,
      )
      .join("")}
  </nav>
  <main>
    ${[1, 2, 3, 4, 5]
      .map(
        (n) => `
    <div class="card"><a class="name" href="/tender/${n}">Ремонт кровли школы ${n} в городе Ош</a></div>`,
      )
      .join("")}
  </main>
</body></html>`;

test("виджет внутри nav не выигрывает у списка даже при равном размере", () => {
  const found = selectorsFromExample(navWidgetHtml, BASE, "Ремонт кровли школы 2 в городе Ош");

  assert.ok(found, "список должен находиться");
  // Обе группы по пять позиций и на одной глубине: решает только то, что одна из
  // них лежит в навигации.
  assert.equal(found.selectors.item, "div.card");
  assert.equal(found.selectors.title, "a.name");
  assert.equal(found.count, 5);
});

/* ---------- селектор карточки должен пережить завтрашнюю вёрстку ---------- */

const cleanListHtml = `
<html><body>
  <ul class="notices">
    ${[1, 2, 3, 4]
      .map(
        (n) => `
    <li><a href="/notice/${n}">Поставка канцелярских товаров для мэрии Бишкека ${n}</a></li>`,
      )
      .join("")}
  </ul>
</body></html>`;

test("селектор карточки не остаётся голым тегом, даже когда шума на странице нет", () => {
  const found = selectorsFromExample(
    cleanListHtml,
    BASE,
    "Поставка канцелярских товаров для мэрии Бишкека 2",
  );

  assert.ok(found, "список <li> должен распознаваться");
  assert.equal(found.selectors.item, "ul.notices > li");
  assert.equal(found.count, 4);

  // Завтра площадка добавит меню и подвал — сохранённый селектор обязан
  // продолжить видеть ровно те же четыре позиции.
  const tomorrow = cleanListHtml.replace(
    "<ul class=\"notices\">",
    "<nav><ul><li><a href=\"/a\">Закупки</a></li><li><a href=\"/b\">Контакты</a></li></ul></nav><ul class=\"notices\">",
  );
  const items = extractItems(tomorrow, BASE, found.selectors);
  assert.equal(items.length, 4);
  assert.ok(
    items.every((item) => item.title.startsWith("Поставка канцелярских товаров")),
    JSON.stringify(items.map((item) => item.title)),
  );
});

/* ---------- неоднородные карточки ---------- */

/** В чётных карточках перед заголовком стоит иконка-ссылка на документ. */
const mixedHtml = `
<html><body><div class="list">
  ${[1, 2, 3, 4, 5, 6]
    .map(
      (n) => `
  <div>
    ${n % 2 === 0 ? `<a href="/doc/${n}.pdf">PDF</a>` : ""}
    <h3><a href="/t/${n}">Ремонт кровли средней школы номер ${n} в городе Ош</a></h3>
  </div>`,
    )
    .join("")}
</div></body></html>`;

test("лишняя ссылка в части карточек не становится заголовком", () => {
  const found = selectorsFromExample(
    mixedHtml,
    BASE,
    "Ремонт кровли средней школы номер 1 в городе Ош",
  );

  assert.ok(found, "список должен распознаваться");
  const items = extractItems(mixedHtml, BASE, found.selectors);
  assert.equal(items.length, 6);
  assert.ok(
    items.every((item) => item.title.startsWith("Ремонт кровли средней школы")),
    JSON.stringify(items.map((item) => item.title)),
  );
  assert.ok(
    items.every((item) => /\/t\/\d$/.test(item.url ?? "")),
    JSON.stringify(items.map((item) => item.url)),
  );
});

test("когда надёжного правила нет, бот отказывается, а не шлёт «PDF»", () => {
  // Тот же список, но заголовок ничем не обёрнут: селектора, который в каждой
  // карточке указывал бы именно на него, не существует.
  const flatHtml = mixedHtml.replace(/<h3>|<\/h3>/g, "");

  const result = matchExample(flatHtml, BASE, "Ремонт кровли средней школы номер 1 в городе Ош");

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "uneven");
});

/* ---------- образец из одного слова ---------- */

const catsHtml = `
<html><body>
  <nav class="cats"><ul>
    ${["Строительство", "Медикаменты", "Транспорт", "Продукты"]
      .map((word, index) => `<li><a href="/c/${index}">${word}</a></li>`)
      .join("")}
  </ul></nav>
  <main><div class="list">
    ${[1, 2, 3, 4, 5]
      .map(
        (n) => `
    <div class="card"><a class="name" href="/t/${n}">Строительство моста через реку Нарын ${n}</a></div>`,
      )
      .join("")}
  </div></main>
</body></html>`;

test("одно длинное слово образцом не считается — иначе бот подпишется на меню", () => {
  assert.equal(selectorsFromExample(catsHtml, BASE, "Строительство"), null);
  assert.equal(selectorsFromExample(catsHtml, BASE, "Медикаменты"), null);

  const found = selectorsFromExample(catsHtml, BASE, "Строительство моста через реку Нарын 3");
  assert.ok(found, "заголовок целиком должен находиться");
  assert.equal(found.selectors.item, "div.card");
  assert.equal(found.count, 5);
});

/* ---------- причина отказа ---------- */

test("три разных отказа различимы: боту есть что посоветовать", () => {
  const singleHtml = `
    <html><body><main>
      <div class="tender-card">
        <a class="tender-title" href="/tender/7">Реконструкция здания детского сада в Нарыне</a>
      </div>
    </main></body></html>`;

  const short = matchExample(cardsHtml, BASE, "Ремонт");
  const missing = matchExample(cardsHtml, BASE, "Поставка вертолётов для министерства обороны");
  const alone = matchExample(singleHtml, BASE, "Реконструкция здания детского сада в Нарыне");

  assert.equal(short.ok === false && short.reason, "too_short");
  assert.equal(missing.ok === false && missing.reason, "not_found");
  assert.equal(alone.ok === false && alone.reason, "single_item");
});

test("удачный разбор приходит размеченным так же, как и отказ", () => {
  const result = matchExample(cardsHtml, BASE, "Ремонт кровли школы №2 в городе Ош");

  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.candidate.selectors.item, "div.tender-card");
});
