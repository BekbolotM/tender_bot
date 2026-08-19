import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeItems,
  fieldsSummary,
  guessFields,
  readFields,
  selectorFields,
} from "../src/lib/fieldguess.ts";
import { extractItems } from "../src/lib/scrape.ts";
import type { ScrapedItem } from "../src/lib/types.ts";

/** Список из `count` одинаковых по вёрстке карточек — как на настоящей площадке. */
function listOf(count: number, card: (n: number) => string): string {
  const cards = Array.from({ length: count }, (_, index) => `<div class="card">${card(index + 1)}</div>`);
  return `<html><body><div class="results">${cards.join("")}</div></body></html>`;
}

const title = (n: number) => `<a class="t" href="/tender/${n}">Ремонт кровли школы в городе Ош</a>`;

test("распознаёт дату публикации по классу и содержимому", () => {
  const html = listOf(5, (n) => `${title(n)}<span class="tender-date">0${n}.09.2026</span>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.date, "span.tender-date");
  assert.equal(guessed.deadline, undefined);
});

test("распознаёт дату, написанную словами и в формате ISO", () => {
  const words = listOf(4, (n) => `${title(n)}<span class="pub">${n} сентября 2026</span>`);
  const iso = listOf(4, (n) => `${title(n)}<span class="pub">2026-09-0${n}</span>`);

  assert.equal(guessFields(words, "div.card").date, "span.pub");
  assert.equal(guessFields(iso, "div.card").date, "span.pub");
});

test("отличает срок подачи от даты публикации по подписи «до»", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <span class="date">0${n}.09.2026</span>
    <span class="deadline">до 1${n}.09.2026</span>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.date, "span.date");
  assert.equal(guessed.deadline, "span.deadline");
});

test("подпись в соседнем элементе разводит дату и срок подачи без говорящих классов", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <div class="meta"><span class="cap">Опубликовано:</span><span class="v">0${n}.09.2026</span></div>
    <div class="meta"><span class="cap">Приём заявок до:</span><span class="v">1${n}.09.2026</span></div>`);

  const guessed = guessFields(html, "div.card");

  assert.ok(guessed.date, "дата публикации должна найтись");
  assert.ok(guessed.deadline, "срок подачи должен найтись");
  assert.notEqual(guessed.date, guessed.deadline);

  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "div.card",
    date: guessed.date,
  });
  assert.equal(items[0].date, "01.09.2026");
});

test("распознаёт цену в разных валютах", () => {
  for (const price of ["1 200 000 сом", "450 000 руб", "12 000 USD", "€ 9 500", "3 400 000 тенге"]) {
    const html = listOf(4, (n) => `${title(n)}<span class="cost">${price}</span>`);
    assert.equal(guessFields(html, "div.card").price, "span.cost", `не распознал «${price}»`);
  }
});

test("цена с неразрывными пробелами между разрядами распознаётся", () => {
  const html = listOf(4, (n) => `${title(n)}<span class="cost">1 200 000 сом</span>`);

  const guessed = guessFields(html, "div.card");
  assert.equal(guessed.price, "span.cost");

  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "div.card",
    price: guessed.price,
  });
  assert.match(items[0].price ?? "", /1\s200\s000\sсом/);
});

test("цена без валюты берётся по подписи «Сумма»", () => {
  const html = listOf(4, (n) => `
    ${title(n)}
    <div class="row"><span class="cap">Сумма:</span><span class="val">1 200 000</span></div>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.price, "span.val");
});

test("распознаёт номер закупки и номер лота", () => {
  const byNumber = listOf(5, (n) => `<span class="lot-number">№ 12${n}-45</span>${title(n)}`);
  const byLot = listOf(5, (n) => `<span class="num">Лот ${n}</span>${title(n)}`);

  assert.equal(guessFields(byNumber, "div.card").number, "span.lot-number");
  assert.equal(guessFields(byLot, "div.card").number, "span.num");
});

test("«№» внутри заголовка-ссылки не считается номером лота", () => {
  const html = listOf(5, (n) => `<a class="t" href="/tender/${n}">Ремонт школы №1${n}</a>`);

  assert.equal(guessFields(html, "div.card").number, undefined);
});

test("распознаёт заказчика по подписи рядом со значением", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <div class="org"><span class="cap">Заказчик:</span><span class="val">Мэрия города Ош</span></div>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.customer, "span.val");

  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "div.card",
    title: guessed.customer,
  });
  assert.equal(items[0].title, "Мэрия города Ош");
});

test("поле из одной карточки из пяти не засчитывается", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <span class="tender-date">0${n}.09.2026</span>
    ${n === 3 ? '<span class="tender-price">1 200 000 сом</span>' : ""}`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.price, undefined, "случайная цена в одной карточке — не колонка списка");
  assert.equal(guessed.date, "span.tender-date");
});

test("поле из трёх карточек из пяти засчитывается", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    ${n <= 3 ? '<span class="tender-price">1 200 000 сом</span>' : ""}`);

  assert.equal(guessFields(html, "div.card").price, "span.tender-price");
});

test("таблица без классов разбирается по позициям ячеек", () => {
  const rows = Array.from(
    { length: 5 },
    (_, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><a href="/tender/${index + 1}">Ремонт кровли школы в городе Ош</a></td>
        <td>0${index + 1}.09.2026</td>
        <td>1 200 000 сом</td>
      </tr>`,
  );
  const html = `<html><body><table class="results"><tbody>${rows.join("")}</tbody></table></body></html>`;

  const guessed = guessFields(html, "tbody tr");

  assert.equal(guessed.date, "td:nth-of-type(3)");
  assert.equal(guessed.price, "td:nth-of-type(4)");

  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "tbody tr",
    date: guessed.date,
    price: guessed.price,
  });
  assert.equal(items[0].date, "01.09.2026");
  assert.equal(items[0].price, "1 200 000 сом");
});

test("карточки без полей дают пустой результат и не роняют разбор", () => {
  const html = listOf(5, (n) => title(n));

  assert.deepEqual(guessFields(html, "div.card"), {});
  assert.deepEqual(guessFields(html, "div.nothing"), {});
  assert.deepEqual(guessFields("<html><body></body></html>", "div.card"), {});
});

test("кривой селектор не роняет разбор", () => {
  const html = listOf(3, (n) => title(n));

  assert.deepEqual(guessFields(html, "div.[]"), {});
});

const item = (over: Partial<ScrapedItem> = {}): ScrapedItem => ({
  title: "Ремонт кровли школы №12",
  url: "https://zakupki.example.kg/tender/1",
  date: "05.09.2026",
  price: "1 200 000 сом",
  text: "Ремонт кровли школы №12 1 200 000 сом",
  ...over,
});

test("describeItems показывает человеку значения, а не селекторы", () => {
  const items = Array.from({ length: 24 }, () => item());

  const text = describeItems(items);

  assert.match(text, /^Нашёл 24 позиции\. Вот что распознал в первой:/);
  assert.match(text, /📌 Название: Ремонт кровли школы №12/);
  assert.match(text, /📅 Дата: 05\.09\.2026/);
  assert.match(text, /💰 Цена: 1 200 000 сом/);
  assert.match(text, /🔗 Ссылка: https:\/\/zakupki\.example\.kg\/tender\/1/);
  assert.ok(!text.includes("span."), "селекторы человеку показывать нельзя");
});

test("describeItems перечисляет ненайденные поля и не называет это ошибкой", () => {
  const text = describeItems([item({ price: null, date: null, url: null })]);

  // «Не нашёл» требует родительного падежа: «даты», а не «дата».
  assert.match(text, /❓ Не нашёл: даты, цены\./);
  assert.match(text, /не ошибка/);
  assert.ok(!text.includes("💰"), "цены нет — строки о ней быть не должно");
  // Отсутствие ссылки — не такая же мелочь: без неё тендер не открыть.
  assert.match(text, /Ссылку на тендер найти не удалось/);
  assert.ok(!/Не нашёл:[^\n]*ссылк/.test(text), "ссылка не прячется в общий список");
});

test("describeItems экранирует содержимое чужой вёрстки", () => {
  const text = describeItems([item({ title: '<b>Ремонт</b> школы & "сада"' })]);

  assert.ok(text.includes("&lt;b&gt;Ремонт&lt;/b&gt;"));
  assert.ok(text.includes("&amp;"));
  assert.ok(!text.includes("<b>"));
});

test("describeItems не длиннее 900 символов даже на мусорных данных", () => {
  const text = describeItems([item({ title: "&".repeat(500), price: "сом ".repeat(200) })]);

  assert.ok(text.length <= 900, `длина ${text.length}`);
  assert.ok(!/&[a-z]{1,6}$/i.test(text), "обрезка не должна оставлять половину HTML-сущности");
});

test("describeItems не падает на пустом списке", () => {
  const text = describeItems([]);

  assert.match(text, /Не нашёл ни одной позиции/);
  assert.ok(text.length <= 900);
});

test("describeItems правильно склоняет число позиций", () => {
  assert.match(describeItems([item()]), /Нашёл 1 позицию/);
  assert.match(describeItems([item(), item(), item()]), /Нашёл 3 позиции/);
  assert.match(describeItems(Array.from({ length: 11 }, () => item())), /Нашёл 11 позиций/);
});

test("fieldsSummary перечисляет только то, что попадёт в уведомление", () => {
  // Заказчика бот распознал, но класть его в `Selectors` некуда — значит и
  // обещать нельзя.
  const summary = fieldsSummary({ date: "span.d", price: "span.p", customer: "span.c" });

  assert.equal(summary, "дата, цена");
});

test("fieldsSummary для пустого результата говорит, что останется", () => {
  assert.equal(fieldsSummary({}), "только название и ссылка");
});

/* ---------- поле должно быть колонкой списка, а не случайностью одной строки ---------- */

test("цена из одной строки таблицы колонкой не становится", () => {
  const rows = Array.from(
    { length: 6 },
    (_, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><a href="/tender/${index + 1}">Ремонт кровли школы в городе Ош</a></td>
        <td>0${index + 1}.09.2026</td>
        <td>${index === 2 ? "1 200 000 сом" : "по договору"}</td>
      </tr>`,
  );
  const html = `<html><body><table class="results"><tbody>${rows.join("")}</tbody></table></body></html>`;

  const guessed = guessFields(html, "tbody tr");

  // Ячейка есть в каждой строке, но ценой она является ровно в одной — в графе
  // «Цена» уведомлений оказалось бы «по договору».
  assert.equal(guessed.price, undefined);
  assert.equal(guessed.date, "td:nth-of-type(3)");
});

test("заказчик — это название организации, а не короткий сосед рядом", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <div class="organizer-block">
      <span class="a">Ош</span>
      <span class="b">Мэрия города Ош, управление образования</span>
    </div>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.customer, "span.b");

  const items = extractItems(html, "https://zakupki.example.kg/list", {
    item: "div.card",
    title: guessed.customer,
  });
  assert.equal(items[0].title, "Мэрия города Ош, управление образования");
});

test("слово «до» в коротком заголовке не превращает дату публикации в срок подачи", () => {
  const html = listOf(5, (n) => `
    <a class="t" href="/tender/${n}">Поставка угля до зимы</a>
    <span class="d">0${n}.09.2026</span>`);

  const guessed = guessFields(html, "div.card");

  assert.equal(guessed.date, "span.d");
  assert.equal(guessed.deadline, undefined);
});

/* ---------- экран подтверждения ---------- */

test("describeItems показывает значения угаданных полей, а не слово «есть»", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <span class="tender-date">0${n}.09.2026</span>
    <span class="cost">1 200 000 сом</span>`);
  const guessed = guessFields(html, "div.card");

  // Естественный порядок вызовов: позиции достали ДО подбора полей, поэтому
  // date и price в них пустые.
  const items = extractItems(html, "https://zakupki.example.kg/list", { item: "div.card" });
  assert.equal(items[0].date, null);

  const text = describeItems(items, guessed, readFields(html, "div.card", guessed));

  assert.match(text, /📅 Дата: 01\.09\.2026/);
  assert.match(text, /💰 Цена: 1 200 000 сом/);
  assert.ok(!text.includes(": есть"), text);
});

test("describeItems не обещает срок подачи, номер и заказчика", () => {
  const html = listOf(5, (n) => `
    ${title(n)}
    <span class="num">Лот ${n}</span>
    <span class="deadline">до 1${n}.09.2026</span>
    <div class="org"><span class="cap">Заказчик:</span><span class="val">Мэрия города Ош</span></div>`);
  const guessed = guessFields(html, "div.card");

  assert.ok(guessed.customer, "заказчик распознаётся — он нужен внутри разбора");

  const text = describeItems(
    extractItems(html, "https://zakupki.example.kg/list", { item: "div.card" }),
    guessed,
    readFields(html, "div.card", guessed),
  );

  // Положить эти поля в уведомление некуда, значит и обещать их нельзя.
  assert.ok(!text.includes("Срок подачи"), text);
  assert.ok(!text.includes("Номер"), text);
  assert.ok(!text.includes("Заказчик"), text);
});

test("describeItems не разрывает эмодзи пополам", () => {
  const lonely = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

  const long = describeItems([item({ title: `${"А".repeat(138)}🎯🎯` })]);
  const emoji = describeItems([item({ price: "💰".repeat(100) })]);

  assert.ok(!lonely.test(long), "обрезка заголовка оставила половину эмодзи");
  assert.ok(!lonely.test(emoji), "обрезка значения оставила половину эмодзи");
});

test("readFields не роняет разбор на кривом или пустом селекторе", () => {
  const html = listOf(3, (n) => `${title(n)}<span class="tender-date">0${n}.09.2026</span>`);

  assert.deepEqual(readFields(html, "div.[]", { date: "span.tender-date" }), {
    source: "first-card",
  });
  assert.deepEqual(readFields(html, "div.nothing", { date: "span.tender-date" }), {
    source: "first-card",
  });
  assert.deepEqual(readFields(html, "div.card", {}), { source: "first-card" });
});

test("selectorFields отдаёт только то, что Selectors умеет хранить", () => {
  const fields = selectorFields({
    date: "span.d",
    price: "span.p",
    deadline: "span.dl",
    number: "span.n",
    customer: "span.c",
  });

  assert.deepEqual(fields, { date: "span.d", price: "span.p" });
});

test("fieldsSummary не обещает ссылку, когда её у позиций нет", () => {
  assert.equal(fieldsSummary({}, false), "только название");
  assert.equal(fieldsSummary({}, true), "только название и ссылка");
});

test("распознанное, но пустое в первой позиции поле не обещают и не хоронят", () => {
  // У первой карточки даты нет, у остальных четырёх есть — поле засчитано.
  const html = listOf(5, (n) => `
    ${title(n)}
    ${n === 1 ? "" : `<span class="tender-date">0${n}.09.2026</span>`}`);
  const guessed = guessFields(html, "div.card");
  assert.equal(guessed.date, "span.tender-date");

  const items = extractItems(html, "https://zakupki.example.kg/list", { item: "div.card" });
  const text = describeItems(items, guessed, readFields(html, "div.card", guessed));

  assert.ok(!text.includes("есть"), "«есть» сверять не с чем");
  assert.ok(!/Не нашёл:[^\n]*дат/.test(text), "дату бот как раз нашёл — это неправда");
  assert.ok(!text.includes("📅"), text);
});
