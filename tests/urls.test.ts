import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeUrl, parseUrl } from "../src/lib/urls.ts";

test("присланная ссылка распознаётся и без диалога", () => {
  // По ней бот сразу начинает разбор площадки, без похода в меню.
  assert.equal(looksLikeUrl("https://zakupki.gov.kg/popp/view/order/list"), true);
  assert.equal(looksLikeUrl("http://zakupki.gov.kg/list?page=2"), true);
  assert.equal(looksLikeUrl("zakupki.gov.kg/popp/view/order/list"), true);
  assert.equal(looksLikeUrl("  zakupki.gov.kg  "), true);
  assert.equal(looksLikeUrl("закупки.рф/тендеры"), true);
  assert.equal(looksLikeUrl("example.com:8080/list"), true);
});

test("обычный текст ссылкой не считается", () => {
  // parseUrl достраивает схему и принял бы каждое из этих слов за адрес,
  // поэтому за вход без диалога отвечает именно looksLikeUrl.
  for (const input of ["привет", "Ремонт кровли", "список тендеров", "1", "/cancel", ""]) {
    assert.equal(looksLikeUrl(input), false, input);
  }
  assert.equal(parseUrl("привет"), "https://xn--b1agh1afp/");
});

test("чужие протоколы входом не становятся", () => {
  for (const input of ["javascript:alert(1)", "ftp://example.com", "tg://resolve?domain=x"]) {
    assert.equal(looksLikeUrl(input), false, input);
  }
  assert.equal(parseUrl("javascript:alert(1)"), null);
});

test("parseUrl достраивает схему", () => {
  assert.equal(parseUrl("zakupki.gov.kg/list"), "https://zakupki.gov.kg/list");
  assert.equal(parseUrl("https://zakupki.gov.kg/list"), "https://zakupki.gov.kg/list");
  assert.equal(parseUrl(""), null);
});
