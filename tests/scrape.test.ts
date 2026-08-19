import { test } from "node:test";
import assert from "node:assert/strict";
import { detectSelectors, extractItems } from "../src/lib/scrape.ts";

const html = `
<html><body>
  <header><a href="/about">О площадке государственных закупок</a></header>
  <div class="tender-list">
    ${[1, 2, 3, 4, 5]
      .map(
        (n) => `
      <div class="tender-card">
        <a class="tender-title" href="/tender/${n}">Ремонт кровли школы №${n} в городе Ош</a>
        <span class="tender-date">0${n}.09.2026</span>
        <span class="tender-price">1 200 000 сом</span>
      </div>`,
      )
      .join("")}
  </div>
  <footer><a href="/contacts">Контакты службы поддержки площадки</a></footer>
</body></html>`;

test("извлекает позиции по заданным селекторам и делает ссылки абсолютными", () => {
  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "div.tender-card",
    title: "a.tender-title",
    link: "a.tender-title",
    date: "span.tender-date",
    price: "span.tender-price",
  });

  assert.equal(items.length, 5);
  assert.equal(items[0].title, "Ремонт кровли школы №1 в городе Ош");
  assert.equal(items[0].url, "https://zakupki.example.kg/tender/1");
  assert.equal(items[0].date, "01.09.2026");
  assert.equal(items[0].price, "1 200 000 сом");
});

test("автоподбор находит карточки, дату и цену", () => {
  const candidates = detectSelectors(html, "https://zakupki.example.kg/list");

  assert.ok(candidates.length >= 1, "должен быть хотя бы один кандидат");
  const best = candidates[0];
  assert.equal(best.count, 5);
  assert.equal(best.selectors.item, "div.tender-card");
  assert.equal(best.selectors.date, "span.tender-date");
  assert.equal(best.selectors.price, "span.tender-price");
  assert.match(best.preview[0].title, /Ремонт кровли школы/);
});

test("автоподбор игнорирует ссылки из header и footer", () => {
  const candidates = detectSelectors(html, "https://zakupki.example.kg/list");
  const titles = candidates.flatMap((c) => c.preview.map((p) => p.title));
  assert.ok(!titles.some((t) => t.includes("Контакты")));
});

test("страница без списка не даёт кандидатов", () => {
  const plain = "<html><body><p>Просто текст без списка тендеров вообще</p></body></html>";
  assert.deepEqual(detectSelectors(plain, "https://example.com"), []);
});

test("навигационные ссылки не становятся кандидатами", () => {
  const navHtml = `
    <html><body>
      <div class="dropdown-menu">
        ${[1, 2, 3, 4]
          .map((n) => `<a class="dropdown-item" href="/section/${n}">Раздел закупок номер ${n}</a>`)
          .join("")}
      </div>
      <ul class="pagination">
        ${[1, 2, 3]
          .map((n) => `<li><a class="page-link" href="/page/${n}">Страница результатов ${n}</a></li>`)
          .join("")}
      </ul>
    </body></html>`;

  assert.deepEqual(detectSelectors(navHtml, "https://example.kg"), []);
});

test("определяет страницы, где список рисует JavaScript", async () => {
  const { looksJavaScriptRendered } = await import("../src/lib/scrape.ts");
  const spa = `<html><body><div id="root"></div><script src="/react.js"></script></body></html>`;
  assert.equal(looksJavaScriptRendered(spa), true);
  assert.equal(looksJavaScriptRendered(html), false);
});

test("маркер PrimeFaces не отменяет таблицу, пришедшую с сервера", async () => {
  const { looksJavaScriptRendered } = await import("../src/lib/scrape.ts");

  // Так устроен zakupki.gov.kg: обвязка PrimeFaces грузится скриптами, а строки
  // таблицы лежат прямо в HTML. Заголовки тут не ссылки, поэтому «осмысленных»
  // ссылок мало — раньше это вместе с маркером давало ложное «нужен JavaScript».
  const primefaces = `
    <html><head>
      <script type="text/javascript" src="/popp/javax.faces.resource/core.js.xhtml?ln=primefaces&amp;v=6.1"></script>
    </head><body>
      <table><tbody class="ui-datatable-data">
        ${[1, 2, 3, 4, 5]
          .map(
            (n) => `
          <tr class="ui-widget-content ui-datatable-${n % 2 ? "odd" : "even"} ui-datatable-selectable">
            <td><span>№</span>2608195869486${n}</td>
            <td><span>Наименование закупки</span><span class="nameTender">Покупка канцелярских товаров для школы №${n}</span></td>
            <td><a href="view.xhtml?id=5869486${n}"><i class="fa fa-external-link"></i></a></td>
          </tr>`,
          )
          .join("")}
      </tbody></table>
    </body></html>`;

  assert.equal(looksJavaScriptRendered(primefaces), false);
  // Та же обвязка, но списка нет — вот это действительно страница, которую рисует JavaScript.
  const emptyPrimefaces = `
    <html><head>
      <script type="text/javascript" src="/popp/javax.faces.resource/core.js.xhtml?ln=primefaces&amp;v=6.1"></script>
    </head><body><div class="ui-datatable"></div></body></html>`;
  assert.equal(looksJavaScriptRendered(emptyPrimefaces), true);
});

test("ссылка-заглушка не попадает в уведомление", () => {
  const jsHtml = `<div class="card"><a href="javascript:void(0)" onclick="go(1)">Ремонт кровли школы №5</a></div>`;
  const [item] = extractItems(jsHtml, "https://ex.kg/list", { item: "div.card" });

  // Telegram отвергает всё сообщение целиком, если протокол ссылки не http(s).
  assert.equal(item.url, null);
  assert.equal(item.title, "Ремонт кровли школы №5");
  assert.equal(extractItems(`<div class="card"><a href="mailto:a@b.kg">Поставка мебели офисной</a></div>`, "https://ex.kg/list", { item: "div.card" })[0].url, null);
});

test("`-header` в конце класса не считается навигацией", () => {
  const cardsHtml = `
    <html><body><div id="content">
      ${[1, 2, 3, 4]
        .map(
          (n) => `
        <div class="search-result">
          <div class="search-result-header"><h2><a class="result-link" href="/notice/${n}">Строительство школы в районе номер ${n}</a></h2></div>
          <div class="search-result-entry">Закрытие 2${n}.08.2026</div>
        </div>`,
        )
        .join("")}
    </div></body></html>`;

  const [best] = detectSelectors(cardsHtml, "https://cf.example.uk/search");

  assert.ok(best, "карточки с классом search-result-header должны находиться");
  // Поднимаемся до самой внешней карточки, иначе дата и цена остаются за её пределами.
  assert.equal(best.selectors.item, "div.search-result");
  assert.equal(best.count, 4);
  assert.equal(best.selectors.date, "div.search-result-entry");
});

test("строки таблицы с иконкой вместо ссылки-заголовка находятся", () => {
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

  const [best] = detectSelectors(tableHtml, "https://zakupki.example.kg/popp/view/order/list.xhtml");

  assert.ok(best, "список в таблице должен находиться");
  assert.equal(best.count, 5);
  assert.equal(best.selectors.title, "span.nameTender");
  assert.match(best.preview[0].title, /^Ремонт кабинета/);
  assert.equal(
    best.preview[0].url,
    "https://zakupki.example.kg/popp/view/order/view.xhtml?id=58694861",
  );
});

test("карточки, где заголовок не ссылка, находятся и сужаются родителем", () => {
  const cardsHtml = `
    <html><body><main>
      <div class="boxEQH">
        ${[1, 2, 3, 4]
          .map(
            (n) => `
          <div class="row">
            <p class="lead">Ремонт систем водоснабжения объекта №${n}</p>
            <div class="list-desc"><span>ATM ID:</span><div class="list-desc-inner"><a href="/Atm/Show/${n}">S-EST1074${n}</a></div></div>
            <div class="list-desc"><span>Agency:</span><div class="list-desc-inner">Департамент строительства и жилищного хозяйства</div></div>
          </div>`,
          )
          .join("")}
      </div>
      <div class="row">Подвал страницы с посторонним текстом, не относящимся к списку</div>
    </main></body></html>`;

  const [best] = detectSelectors(cardsHtml, "https://tenders.example.au/atm");

  assert.ok(best, "карточки без ссылки-заголовка должны находиться");
  // Класс `row` встречается и вне списка, поэтому селектор сужается родителем.
  assert.equal(best.selectors.item, "div.boxEQH > div.row");
  assert.equal(best.count, 4);
  assert.equal(best.selectors.title, "p.lead");
  assert.equal(best.preview[0].url, "https://tenders.example.au/Atm/Show/1");
});

test("role=navigation на обёртке всей страницы не прячет список", () => {
  const wrapped = `
    <html><body><div class="pushmenu-push" role="navigation"><main>
      <div class="list">
        ${[1, 2, 3, 4]
          .map((n) => `<div class="card"><a class="t" href="/t/${n}">Поставка медикаментов для больницы №${n}</a></div>`)
          .join("")}
      </div>
    </main></div></body></html>`;

  const [best] = detectSelectors(wrapped, "https://ex.kg/list");

  assert.ok(best, "обёртка с role=navigation вокруг <main> не должна отменять список");
  assert.equal(best.count, 4);
});
