import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogEntry } from "../src/lib/catalog.ts";
import { siteCard } from "../src/lib/bot/menus.ts";
import {
  catalogLocalOnly,
  localCheckNote,
  localSiteAddedText,
  localStaleLine,
  VIA_LOCAL_LINE,
  viaLocalSwitchedText,
} from "../src/lib/bot/onboarding.ts";
import {
  checkIngestSite,
  ingestAuthorized,
  ingestFailureReport,
  ingestFailureWarning,
  ingestJobs,
  ingestReport,
  ingestWarning,
  MAX_BODY_BYTES,
  MAX_REASON_CHARS,
  parseIngestBody,
} from "../src/lib/ingest.ts";
import type { Site } from "../src/lib/types.ts";

/**
 * Приём страниц от домашнего сборщика. Здесь проверяется всё, что решается без
 * сети и базы: чужой секрет, кривое тело запроса, площадка не того рода.
 * Маршрут поверх этих функций только ходит в базу — ошибиться в нём почти негде.
 */

const SECRET = "s3cret";

function site(overrides: Partial<Site> = {}): Site {
  return {
    id: 12,
    title: "Все тендеры Кыргызстана",
    list_url: "https://procurement.example.kg/",
    selectors: { item: "li.card", title: "a", link: "a" },
    search: { mode: "off" },
    via_local: true,
    enabled: true,
    last_checked_at: null,
    last_error: null,
    ...overrides,
  };
}

const post = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: "POST", headers });

/* ---------- секрет ---------- */

test("секрет принимается и параметром адреса, и заголовком", () => {
  assert.ok(ingestAuthorized(post(`https://bot.example/api/ingest?secret=${SECRET}`), SECRET));
  assert.ok(
    ingestAuthorized(post("https://bot.example/api/ingest", { authorization: `Bearer ${SECRET}` }), SECRET),
  );
});

test("чужой и отсутствующий секрет не проходят", () => {
  assert.ok(!ingestAuthorized(post("https://bot.example/api/ingest?secret=nope"), SECRET));
  assert.ok(!ingestAuthorized(post("https://bot.example/api/ingest"), SECRET));
  assert.ok(
    !ingestAuthorized(post("https://bot.example/api/ingest", { authorization: SECRET }), SECRET),
    "голый секрет без Bearer — это не тот заголовок, что шлёт планировщик",
  );
});

test("пустой секрет в запросе не открывает приём", () => {
  assert.ok(!ingestAuthorized(post("https://bot.example/api/ingest?secret="), SECRET));
});

/* ---------- тело запроса ---------- */

test("нормальное тело разбирается, время сбора необязательно", () => {
  const parsed = parseIngestBody(JSON.stringify({ siteId: 12, html: "<li>тендер</li>" }));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, {
    kind: "page",
    siteId: 12,
    html: "<li>тендер</li>",
    fetchedAt: null,
  });

  const withTime = parseIngestBody(
    JSON.stringify({ siteId: 12, html: "<li>x</li>", fetchedAt: "2026-08-20T10:00:00.000Z" }),
  );
  assert.ok(withTime.ok);
  assert.equal(withTime.value.kind, "page");
  assert.equal(withTime.value.kind === "page" ? withTime.value.fetchedAt : null, "2026-08-20T10:00:00.000Z");
});

/* ---------- сообщение о неудаче ---------- */

test("сборщик может прислать причину вместо страницы", () => {
  // Без этого в карточке площадки навсегда осталась бы дата последнего удачного
  // сбора — то есть «проверено, ошибок нет» у площадки, которая молчит неделю.
  const parsed = parseIngestBody(
    JSON.stringify({ siteId: 12, error: "сайт показал страницу проверки браузера" }),
  );

  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, {
    kind: "failure",
    siteId: 12,
    error: "сайт показал страницу проверки браузера",
  });
});

test("опечатка в html не превращается молча в сообщение о неудаче", () => {
  // Отличаем по отсутствию ключа html, а не по его пустоте: иначе сборщик,
  // приславший пустую строку, тихо «пожаловался» бы вместо явной ошибки.
  const parsed = parseIngestBody(JSON.stringify({ siteId: 12, html: "", error: "что-то" }));
  assert.ok(!parsed.ok);
  assert.equal(parsed.status, 400);
});

test("пустая причина неудачи не принимается", () => {
  for (const error of ["", "   ", "\n\t"]) {
    const parsed = parseIngestBody(JSON.stringify({ siteId: 12, error }));
    assert.ok(!parsed.ok, `причина ${JSON.stringify(error)} не должна приниматься`);
    assert.equal(parsed.status, 400);
  }
});

test("причина укладывается в одну строку разумной длины", () => {
  const messy = parseIngestBody(
    JSON.stringify({ siteId: 12, error: "  сайт\nне\tответил   вовремя  " }),
  );
  assert.ok(messy.ok);
  assert.equal(messy.value.kind === "failure" ? messy.value.error : "", "сайт не ответил вовремя");

  // Длинный кусок чужого текста иначе затопил бы карточку площадки в Telegram.
  const long = parseIngestBody(JSON.stringify({ siteId: 12, error: "я".repeat(1000) }));
  assert.ok(long.ok);
  const reason = long.value.kind === "failure" ? long.value.error : "";
  assert.equal(reason.length, MAX_REASON_CHARS);
  assert.ok(reason.endsWith("…"));
});

test("причина неудачи в карточке подписана: кто это делал и что не вышло", () => {
  const line = ingestFailureWarning("сайт показал страницу проверки браузера");
  assert.match(line, /с вашего компьютера/);
  assert.match(line, /проверки браузера/);
});

test("на сообщение о неудаче бот отвечает «принято», а не числами прогона", () => {
  assert.deepEqual(ingestFailureReport(), { ok: true, noted: true });
});

test("не-JSON и не-объект отвергаются с кодом 400", () => {
  for (const raw of ["не json", "[]", '"строка"', "12"]) {
    const parsed = parseIngestBody(raw);
    assert.ok(!parsed.ok, `«${raw}» не должно приниматься`);
    assert.equal(parsed.status, 400);
    assert.ok(parsed.error.length > 0);
  }
});

test("номер площадки должен быть целым положительным числом", () => {
  for (const siteId of ["12", 0, -3, 1.5, null, undefined, Number.NaN]) {
    const parsed = parseIngestBody(JSON.stringify({ siteId, html: "<li>x</li>" }));
    assert.ok(!parsed.ok, `siteId ${String(siteId)} не должен приниматься`);
    assert.equal(parsed.status, 400);
    assert.match(parsed.error, /siteId/);
  }
});

test("пустая страница — это не страница", () => {
  for (const html of ["", "   ", 42, null]) {
    const parsed = parseIngestBody(JSON.stringify({ siteId: 12, html }));
    assert.ok(!parsed.ok, `html ${JSON.stringify(html)} не должен приниматься`);
    assert.equal(parsed.status, 400);
  }
});

test("слишком большое тело отвергается отдельным кодом и понятной причиной", () => {
  const huge = JSON.stringify({ siteId: 12, html: "я".repeat(MAX_BODY_BYTES) });
  const parsed = parseIngestBody(huge);

  assert.ok(!parsed.ok);
  assert.equal(parsed.status, 413, "413 отличает «слишком много» от «прислали ерунду»");
  assert.match(parsed.error, /5 МБ/);
});

test("страница обычного размера в лимит укладывается", () => {
  // Страница списка тендеров весит порядка 150 КБ — запас должен быть кратным.
  const page = JSON.stringify({ siteId: 12, html: "<li>тендер</li>".repeat(20_000) });
  assert.ok(page.length > 150_000, "проверяем именно реалистичный размер");
  assert.ok(parseIngestBody(page).ok);
});

/* ---------- какая площадка годится ---------- */

test("страница принимается только для включённой площадки домашнего сборщика", () => {
  assert.ok(checkIngestSite(site()).ok);
});

test("неизвестная площадка отвергается с объяснением", () => {
  const checked = checkIngestSite(null);
  assert.ok(!checked.ok);
  assert.equal(checked.status, 400);
  assert.match(checked.error, /нет/);
});

test("площадку, которую сервер обходит сам, приём не принимает", () => {
  const checked = checkIngestSite(site({ via_local: false }));
  assert.ok(!checked.ok);
  assert.equal(checked.status, 400);
  assert.match(checked.error, /сервер обходит сам/);
  assert.match(checked.error, /Все тендеры Кыргызстана/, "человек должен видеть, о какой площадке речь");
});

test("выключенная площадка страницы не принимает", () => {
  const checked = checkIngestSite(site({ enabled: false }));
  assert.ok(!checked.ok);
  assert.equal(checked.status, 400);
  assert.match(checked.error, /выключена/);
});

/* ---------- задания и ответ ---------- */

test("в задании сборщику только номер, название и адрес", () => {
  const jobs = ingestJobs([site(), site({ id: 13, title: "Вторая", list_url: "https://b.example/" })]);

  assert.deepEqual(jobs, [
    { id: 12, title: "Все тендеры Кыргызстана", listUrl: "https://procurement.example.kg/" },
    { id: 13, title: "Вторая", listUrl: "https://b.example/" },
  ]);
  assert.deepEqual(Object.keys(jobs[0]), ["id", "title", "listUrl"], "правила разбора остаются на сервере");
});

test("ответ сборщику — числа прогона и признак первого сбора", () => {
  const report = ingestReport({ found: 32, fresh: 4, notified: 2 });
  assert.deepEqual(report, { ok: true, found: 32, fresh: 4, notified: 2, seeded: false });

  // Первый сбор: всё найденное помечено просмотренным, рассылки не было.
  // Сборщик по этому признаку печатает человеку другой текст.
  assert.deepEqual(ingestReport({ found: 32, fresh: 32, notified: 0, seeded: true }), {
    ok: true,
    found: 32,
    fresh: 32,
    notified: 0,
    seeded: true,
  });
});

test("пустая страница отмечается предупреждением, непустая — нет", () => {
  assert.equal(ingestWarning(0)?.includes("не нашлось"), true);
  assert.equal(ingestWarning(32), null);
});

/* ---------- как это выглядит в боте ---------- */

test("procurement.kg в каталоге помечен как площадка домашнего сборщика", () => {
  const entry = catalogEntry("kg-procurement");
  assert.ok(entry, "запись должна быть в каталоге");
  assert.equal(entry.viaLocal, true);
  assert.equal(entry.listUrl, "https://procurement.kg/");
  assert.equal(entry.selectors.item, "li.min-w-0.border-t");
});

test("карточка такой площадки честно говорит, откуда идёт обход", () => {
  const { text, keyboard } = siteCard(site());
  assert.ok(text.includes(VIA_LOCAL_LINE), "человек должен видеть, что площадку читает его компьютер");

  const data = keyboard.inline_keyboard.flat().map((button) => ("callback_data" in button ? button.callback_data : ""));
  assert.ok(
    !data.some((value) => value.startsWith("site_search_toggle")),
    "поиск на стороне площадки для неё бессмыслен: бот её страниц не открывает",
  );
});

test("обычная площадка про обход ничего лишнего не пишет", () => {
  const { text } = siteCard(site({ via_local: false }));
  assert.ok(!text.includes(VIA_LOCAL_LINE));
});

test("площадка из каталога предупреждает про программу до добавления", () => {
  const entry = catalogEntry("kg-procurement");
  assert.ok(entry);
  const { text, keyboard } = catalogLocalOnly(entry);

  assert.match(text, /компьютер/);
  assert.match(text, /Добавляем эту площадку\?/);
  assert.equal(
    keyboard.inline_keyboard[0].map((b) => ("callback_data" in b ? b.callback_data : ""))[0],
    "cat_add:kg-procurement",
  );
});

test("после добавления бот не выглядит сломанным: объясняет, чего ждать", () => {
  const text = localSiteAddedText("Все тендеры Кыргызстана");
  assert.match(text, /добавлена/);
  assert.match(text, /компьютер/);
  assert.match(text, /Пока программы нет/);
});

test("владельца не отправляют ждать команд от самого себя", () => {
  // Раньше здесь стояло «готовые команды пришлёт тот, кто настраивал бота» —
  // и владелец, который и есть этот человек, упирался в тупик ровно там, где
  // инструкция нужнее всего.
  const forOwner = localSiteAddedText("Все тендеры Кыргызстана", true);

  assert.ok(!forOwner.includes("пришлёт"), `владельцу некуда идти за командами:\n${forOwner}`);
  assert.match(forOwner, /install-collector\.sh/, "команды должны быть прямо в сообщении");
  assert.match(forOwner, /cd ~\/tender_bot/);

  // Остальным по-прежнему говорим, что команды придут от владельца: сами они
  // ничего на его компьютер поставить не могут.
  assert.match(localSiteAddedText("Все тендеры Кыргызстана"), /пришлёт/);
});

test("переключение способа обхода объясняет, что теперь делать", () => {
  const toLocal = viaLocalSwitchedText("Все тендеры <КР>", true);
  assert.match(toLocal, /install-collector\.sh/, "включили обход с компьютера — нужна программа");
  assert.ok(toLocal.includes("&lt;КР&gt;"), "название площадки — ввод человека, его экранируем");

  const toServer = viaLocalSwitchedText("Площадка", false);
  assert.ok(!toServer.includes("install-collector.sh"), "программа больше не нужна — не зовём её ставить");
  assert.match(toServer, /по расписанию/);
});

test("молчащий домашний сбор виден в карточке площадки", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");
  const hours = (n: number): string => new Date(now - n * 3_600_000).toISOString();

  // Обычная площадка про домашний сбор молчит всегда.
  assert.equal(localStaleLine(site({ via_local: false, last_checked_at: hours(100) }), now), null);

  // Ни разу не приходило: программа, похоже, ещё не установлена.
  assert.match(localStaleLine(site({ last_checked_at: null }), now) ?? "", /не установлена/);

  // Свежий сбор — тишина: строка про поломку у здоровой площадки только пугает.
  assert.equal(localStaleLine(site({ last_checked_at: hours(1) }), now), null);

  // А вот это уже не «компьютер ненадолго уснул».
  assert.match(localStaleLine(site({ last_checked_at: hours(5) }), now) ?? "", /5 часов назад/);
  assert.match(localStaleLine(site({ last_checked_at: hours(48) }), now) ?? "", /2 дня назад/);
  assert.match(localStaleLine(site({ last_checked_at: hours(5) }), now) ?? "", /компьютер/);
});

test("испорченная дата проверки карточку не роняет", () => {
  assert.equal(localStaleLine(site({ last_checked_at: "не дата" })), null);
});

test("кнопка «Проверить сейчас» не молчит о площадках домашнего компьютера", () => {
  assert.equal(localCheckNote(0), null, "без таких площадок приписке взяться неоткуда");
  assert.match(localCheckNote(1) ?? "", /1 площадку/);
  assert.match(localCheckNote(2) ?? "", /2 площадки/);
  assert.match(localCheckNote(1) ?? "", /не входят/);
});

/**
 * Тексты для человека, а не для программиста: он не должен встретить в боте
 * ни одного слова, после которого решит, что чинить это может только специалист.
 */
test("в сообщениях про домашний сборщик нет технических слов", () => {
  // «http» целиком не запрещаем: адрес самой площадки человеку как раз нужен.
  const forbidden = ["http 4", "http 5", "json", "селектор", "скрипт", "демон", "терминал", "cloudflare"];
  const texts = [
    catalogLocalOnly(catalogEntry("kg-procurement")!).text,
    localSiteAddedText("Площадка"),
    VIA_LOCAL_LINE,
    siteCard(site()).text,
  ];

  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const word of forbidden) {
      assert.ok(!lower.includes(word), `«${word}» просочилось в текст для человека:\n${text}`);
    }
  }
});

test("владельцу можно сказать «Терминал» — но больше ничего технического", () => {
  // «Терминал» — название приложения в macOS: человек ищет его по этому слову
  // и открывает по нему же. Заменить его нечем, поэтому это единственное
  // исключение, и оно должно оставаться единственным.
  const forOwner = localSiteAddedText("Площадка", true);
  const stillForbidden = ["json", "селектор", "скрипт", "демон", "cloudflare", "http 4", "http 5"];

  for (const word of stillForbidden) {
    assert.ok(!forOwner.toLowerCase().includes(word), `«${word}» просочилось:\n${forOwner}`);
  }
  assert.match(forOwner, /Терминал/);
});
