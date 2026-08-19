import { test } from "node:test";
import assert from "node:assert/strict";
import { page, PAGE_SIZE } from "../src/lib/paginate.ts";

const words = Array.from({ length: 153 }, (_, index) => `слово${index}`);

test("длинный список режется на страницы", () => {
  // Двести кнопок в одном сообщении Telegram отвергает, и меню переставало открываться.
  const first = page(words, 0);

  assert.equal(first.items.length, PAGE_SIZE);
  assert.equal(first.from, 0);
  assert.equal(first.items[0], "слово0");
  assert.match(first.note, /Показаны 1–20 из 153/);
});

test("страница берётся от переданного смещения", () => {
  const second = page(words, PAGE_SIZE);

  assert.equal(second.from, PAGE_SIZE);
  assert.equal(second.items[0], "слово20");
  assert.match(second.note, /Показаны 21–40 из 153/);
});

test("смещение за пределы списка прижимается к последней странице", () => {
  const beyond = page(words, 10_000);

  assert.equal(beyond.from, 140);
  assert.equal(beyond.items.length, 13);
  assert.deepEqual(page(words, -5).items, page(words, 0).items);
  assert.deepEqual(page(words, Number.NaN).items, page(words, 0).items);
});

test("короткий список умещается целиком и без подписи", () => {
  const short = page(words.slice(0, 5), 0);

  assert.equal(short.items.length, 5);
  assert.equal(short.note, "");
  assert.deepEqual(page([], 0), { items: [], from: 0, note: "" });
});
