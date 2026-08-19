import { test } from "node:test";
import assert from "node:assert/strict";
import { formatItem, overflowMessage, partialCheckWarning } from "../src/lib/notify.ts";
import type { ScrapedItem, Site } from "../src/lib/types.ts";

const site: Site = {
  id: 1,
  title: "Госзакупки <КР>",
  list_url: "https://zakupki.example.kg/tenders",
  selectors: { item: "div.card" },
  search: { mode: "off" },
  enabled: true,
  last_checked_at: null,
  last_error: null,
};

const item = (overrides: Partial<ScrapedItem> = {}): ScrapedItem => ({
  title: "Ремонт кровли школы №5",
  url: "https://zakupki.example.kg/tender/5",
  date: null,
  price: null,
  text: "Ремонт кровли школы №5",
  ...overrides,
});

test("название сайта в сообщении о переполнении экранируется", () => {
  // Иначе Telegram отвечает 400 «can't parse entities», broadcast глотает ошибку,
  // и о потерянных совпадениях никто не узнаёт.
  const text = overflowMessage(site.title, 7);

  assert.equal(text, "… и ещё 7 совпадений на «Госзакупки &lt;КР&gt;»");
  assert.ok(!text.includes("<КР>"));
});

test("уведомление о тендере не содержит сырых угловых скобок", () => {
  const text = formatItem(site, item({ title: "Ремонт <кровли>", price: "1 000 000 сом" }), ["ремонт"]);

  assert.ok(text.includes("&lt;кровли&gt;"));
  assert.ok(text.includes('<a href="https://zakupki.example.kg/tender/5">'));
  assert.ok(text.includes("Госзакупки &lt;КР&gt;"));
});

test("позиция без ссылки уведомление не ломает", () => {
  const text = formatItem(site, item({ url: null }), []);

  assert.ok(!text.includes("<a href"));
  assert.ok(text.includes("Ремонт кровли школы №5"));
});

test("частичный отказ адресов не выглядит удачной проверкой", () => {
  // null означает «ошибок нет» и стирает прошлую ошибку из карточки сайта.
  assert.equal(partialCheckWarning({ failed: 0, total: 8, fallback: false }), null);
  assert.match(
    partialCheckWarning({ failed: 7, total: 8, fallback: false }) ?? "",
    /частично: 7 из 8/,
  );
  assert.match(
    partialCheckWarning({ failed: 8, total: 9, fallback: true }) ?? "",
    /через форму сайта ничего не разобралось/,
  );
});
