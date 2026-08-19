import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, MAX_ID_BYTES, catalogEntry, catalogList } from "../src/lib/catalog.ts";

/**
 * Каталог — это данные, а не код, и ломается он молча: опечатка в id уводит
 * кнопку в никуда, лишний пробел в адресе роняет проверку площадки. Живьём
 * площадки проверяются отдельным скриптом, здесь — только то, что можно
 * проверить без сети.
 */

/**
 * Приставки, с которыми id уезжает в `callback_data` кнопки (см. `bot/onboarding.ts`).
 * Продублированы намеренно: тест должен ловить слишком длинный id независимо от
 * того, как сейчас называются кнопки.
 */
const CALLBACK_PREFIXES = ["cat:", "cat_add:"];

/** Telegram считает `callback_data` в байтах, а не в символах. */
const TELEGRAM_CALLBACK_LIMIT = 64;

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

test("каталог не пустой", () => {
  assert.ok(CATALOG.length >= 1, "в каталоге должна быть хотя бы одна площадка");
});

test("идентификаторы уникальны", () => {
  const ids = CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, `дубли среди id: ${ids.join(", ")}`);
});

test("id и callback_data влезают в лимит Telegram", () => {
  for (const entry of CATALOG) {
    assert.ok(
      /^[a-z0-9-]+$/.test(entry.id),
      `id «${entry.id}» должен быть из латиницы, цифр и дефисов: он уезжает в callback_data`,
    );
    assert.ok(
      bytes(entry.id) <= MAX_ID_BYTES,
      `id «${entry.id}» — ${bytes(entry.id)} байт, а можно не больше ${MAX_ID_BYTES}`,
    );
    for (const prefix of CALLBACK_PREFIXES) {
      const callbackData = `${prefix}${entry.id}`;
      assert.ok(
        bytes(callbackData) <= TELEGRAM_CALLBACK_LIMIT,
        `кнопка «${callbackData}» — ${bytes(callbackData)} байт, Telegram примет не больше ${TELEGRAM_CALLBACK_LIMIT}`,
      );
    }
  }
});

test("у каждой площадки заполнены обязательные поля", () => {
  for (const entry of CATALOG) {
    assert.ok(entry.title.trim().length > 0, `${entry.id}: пустое название`);
    assert.ok(entry.country.trim().length > 0, `${entry.id}: не указана страна`);
    assert.ok(entry.selectors.item.trim().length > 0, `${entry.id}: нечем находить объявления`);
  }
});

test("адрес списка — рабочая https-ссылка", () => {
  for (const entry of CATALOG) {
    const url = new URL(entry.listUrl);
    assert.equal(url.protocol, "https:", `${entry.id}: адрес должен быть https`);
    assert.ok(url.hostname.includes("."), `${entry.id}: странное имя сайта ${url.hostname}`);
    assert.equal(entry.listUrl, entry.listUrl.trim(), `${entry.id}: пробелы по краям адреса`);
  }
});

test("настроенный поиск площадки заполнен целиком", () => {
  for (const entry of CATALOG) {
    if (!entry.search || entry.search.mode !== "query") continue;
    assert.ok(entry.search.action, `${entry.id}: у поиска нет адреса`);
    assert.ok(entry.search.param, `${entry.id}: у поиска нет поля для слова`);
    assert.equal(new URL(entry.search.action ?? "").protocol, "https:", `${entry.id}: поиск не по https`);
  }
});

test("пауза, о которой просит площадка, — положительное число", () => {
  for (const entry of CATALOG) {
    if (entry.crawlDelayMs === undefined) continue;
    assert.ok(
      Number.isFinite(entry.crawlDelayMs) && entry.crawlDelayMs > 0,
      `${entry.id}: пауза должна быть положительной, а не ${entry.crawlDelayMs}`,
    );
  }
});

test("предупреждения написаны человеческим языком", () => {
  // Человек, который добавляет площадку, не обязан знать слова из вёрстки.
  const jargon = /селектор|css|http\s?\d{3}|парсер|<[a-z]+>|item\b|robots\.txt/i;
  for (const entry of CATALOG) {
    if (!entry.note) continue;
    assert.ok(!jargon.test(entry.note), `${entry.id}: в предупреждении техническое слово — «${entry.note}»`);
  }
});

test("в списке для меню кыргызские площадки идут первыми", () => {
  const countries = catalogList().map((entry) => entry.country);
  const lastKg = countries.lastIndexOf("Кыргызстан");
  const firstOther = countries.findIndex((country) => country !== "Кыргызстан");

  assert.ok(lastKg >= 0, "в каталоге должна быть хотя бы одна кыргызская площадка");
  assert.ok(firstOther === -1 || lastKg < firstOther, `порядок стран нарушен: ${countries.join(", ")}`);
});

test("порядок в меню не зависит от порядка в самом каталоге", () => {
  // Сортировка устойчивая: внутри одной страны порядок остаётся исходным.
  const kg = CATALOG.filter((entry) => entry.country === "Кыргызстан").map((entry) => entry.id);
  const kgSorted = catalogList()
    .filter((entry) => entry.country === "Кыргызстан")
    .map((entry) => entry.id);
  assert.deepEqual(kgSorted, kg);
  assert.equal(catalogList().length, CATALOG.length, "из меню не должна пропадать ни одна площадка");
});

test("меню получает копию: переставить сам каталог оно не может", () => {
  const before = CATALOG.map((entry) => entry.id);
  catalogList().reverse();
  assert.deepEqual(CATALOG.map((entry) => entry.id), before);
});

test("площадка находится по идентификатору", () => {
  for (const entry of CATALOG) {
    assert.equal(catalogEntry(entry.id), entry, `${entry.id} должен находиться по своему id`);
  }
});

test("неизвестный идентификатор — это undefined, а не сбой", () => {
  // Кнопка могла остаться в сообщении от прошлой версии бота.
  assert.equal(catalogEntry("нет-такой-площадки"), undefined);
  assert.equal(catalogEntry(""), undefined);
  assert.equal(catalogEntry("KG-ZAKUPKI"), undefined, "регистр важен: id сравнивается как есть");
});
