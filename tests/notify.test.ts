import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, formatItem, overflowMessage, partialCheckWarning } from "../src/lib/notify.ts";
import type { ScrapedItem, Site } from "../src/lib/types.ts";

const site: Site = {
  id: 1,
  title: "Госзакупки <КР>",
  list_url: "https://zakupki.example.kg/tenders",
  selectors: { item: "div.card" },
  search: { mode: "off" },
  via_local: false,
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

test("кавычки экранируются наравне со скобками", () => {
  // Тот же помощник подставляет чужой текст внутрь href="…". Кавычка из вёрстки
  // площадки закрывала бы атрибут раньше времени, и Telegram отверг бы всё
  // сообщение целиком — о найденном тендере никто бы не узнал.
  assert.equal(escapeHtml(`a"b'c&d<e>f`), "a&quot;b&#39;c&amp;d&lt;e&gt;f");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;", "амперсанд экранируется первым, иначе выйдет каша");
});

test("кавычка в ссылке не разрывает тег со ссылкой", () => {
  const text = formatItem(
    site,
    item({ url: `https://zakupki.example.kg/t/5?q="><script>` }),
    [],
  );

  // Открывающий тег обязан закончиться там, где мы его закрыли, — и ни одного
  // сырого `"` внутри значения атрибута.
  const href = /<a href="([^"]*)">/.exec(text);
  assert.ok(href, `ссылка должна остаться цельным тегом:\n${text}`);
  assert.ok(!href[1].includes('"'));
  assert.ok(!text.includes("<script>"));
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
