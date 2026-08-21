import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authHeaders,
  BROWSER_HEADERS,
  buildFailureBody,
  buildIngestBody,
  encodeBody,
  exitCodeFor,
  explainError,
  formatOutcome,
  formatSummary,
  headerSafeSecret,
  hintFor,
  ingestEndpoint,
  inspectPage,
  MAX_PAGE_BYTES,
  MIN_LIST_BYTES,
  normalizeBotUrl,
  PAGE_TOO_BIG_MESSAGE,
  parseEnvFile,
  parseIngestResult,
  parseJobs,
  readCapped,
  redact,
  resolveConfig,
  type SiteOutcome,
  WRONG_SECRET_MESSAGE,
} from "../scripts/collector.ts";

/* ---------- настройки ---------- */

test("разбирает .env.local: кавычки, комментарии, export и знак = внутри значения", () => {
  const values = parseEnvFile(
    [
      "# комментарий",
      "",
      "BOT_URL=https://tenderbot-blond.vercel.app",
      'CRON_SECRET="секрет=с=равно"',
      "export DATABASE_URL='postgresql://user:pass@host/db?sslmode=require'",
      "  SPACED = значение с пробелами  ",
      "не переменная",
      "1BAD=пропустить",
    ].join("\n"),
  );

  assert.equal(values.BOT_URL, "https://tenderbot-blond.vercel.app");
  assert.equal(values.CRON_SECRET, "секрет=с=равно");
  assert.equal(values.DATABASE_URL, "postgresql://user:pass@host/db?sslmode=require");
  assert.equal(values.SPACED, "значение с пробелами");
  assert.equal(values["1BAD"], undefined);
});

test("адрес бота приводится к https без хвостового слэша", () => {
  assert.equal(normalizeBotUrl("tenderbot-blond.vercel.app"), "https://tenderbot-blond.vercel.app");
  assert.equal(normalizeBotUrl("https://tenderbot-blond.vercel.app/"), "https://tenderbot-blond.vercel.app");
  assert.equal(normalizeBotUrl("  http://localhost:3000//  "), "http://localhost:3000");
  assert.throws(() => normalizeBotUrl("   "), /пустой/);
});

test("http:// для чужого хоста не принимается — иначе секрет уйдёт открытым текстом", () => {
  // Заголовок Authorization читается любым, кто видит трафик: сосед по вай-фаю,
  // владелец точки доступа, провайдер. Сообщение рядом требует https — значит,
  // и код должен требовать, иначе сообщение врёт.
  assert.throws(() => normalizeBotUrl("http://tenderbot-blond.vercel.app"), /https/);
  assert.throws(() => normalizeBotUrl("http://192.168.1.10:3000"), /https/);

  // Свой же компьютер — исключение: сети между процессами там нет.
  assert.equal(normalizeBotUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");

  // Голое имя хоста без схемы достраивается до https, а не до http.
  assert.equal(normalizeBotUrl("bot.example"), "https://bot.example");
});

test("настройки берутся из окружения, а без него — из .env.local", () => {
  const fromFile = { BOT_URL: "https://from-file.example", CRON_SECRET: "file-secret" };

  const both = resolveConfig({ BOT_URL: "https://from-env.example", CRON_SECRET: "env-secret" }, fromFile);
  assert.equal(both.botUrl, "https://from-env.example");
  assert.equal(both.secret, "env-secret");

  const onlyFile = resolveConfig({}, fromFile);
  assert.equal(onlyFile.botUrl, "https://from-file.example");
  assert.equal(onlyFile.secret, "file-secret");
});

test("без BOT_URL и CRON_SECRET скрипт называет обе недостающие строки", () => {
  assert.throws(() => resolveConfig({}, {}), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /BOT_URL/);
    assert.match(message, /CRON_SECRET/);
    assert.match(message, /\.env\.local/);
    return true;
  });
});

test("секрет уходит заголовком, а в адресе его нет вовсе", () => {
  // Vercel пишет полный адрес запроса в журнал, а сбор идёт 96 раз в сутки:
  // `?secret=…` осел бы там навсегда, доступный всем, у кого есть журналы.
  const secret = "9f3c1a7e5b2d84c60ae1f79d3b5c82ea";

  assert.equal(ingestEndpoint("https://bot.example"), "https://bot.example/api/ingest");
  assert.ok(!ingestEndpoint("https://bot.example").includes(secret));
  assert.ok(!ingestEndpoint("https://bot.example").includes("secret"));

  assert.deepEqual(authHeaders(secret), { authorization: `Bearer ${secret}` });
});

test("секрет с русскими буквами отвергается до запроса, а не внутри fetch", () => {
  // Заголовки HTTP умеют только однобайтовые символы. Пока секрет уходил в
  // адресе, кириллица переживала кодирование; с переходом на заголовок такой
  // секрет роняет сам fetch, и человек читает «Cannot convert argument to a
  // ByteString because the character at index 7 has a value of 1089» — из
  // чего понять нельзя вообще ничего.
  assert.ok(headerSafeSecret("9f3c1a7e5b2d84c60ae1f79d3b5c82ea"));
  assert.ok(headerSafeSecret("a-b_c.d~e+f/g=h"));
  assert.ok(!headerSafeSecret("секрет"));
  assert.ok(!headerSafeSecret("secret-и-ещё-немного"));
  assert.ok(!headerSafeSecret("secret\nsecret"), "перевод строки в заголовке — это подделка запроса");
  assert.ok(!headerSafeSecret(""));

  const env = { BOT_URL: "https://bot.example", INGEST_SECRET: "мойсекрет" };
  assert.throws(() => resolveConfig(env, {}), (error: unknown) => {
    const message = error instanceof Error ? error.message : "";
    assert.match(message, /русские буквы/);
    assert.match(message, /openssl rand -hex 32/, "человеку нужна готовая команда, а не диагноз");
    assert.ok(!message.includes("мойсекрет"), "сам секрет печатать нельзя");
    return true;
  });

  // Обычный секрет по-прежнему проходит.
  assert.equal(
    resolveConfig({ BOT_URL: "https://bot.example", INGEST_SECRET: "abc123" }, {}).secret,
    "abc123",
  );
});

test("секрет вырезается из текста — и целиком, и закодированный, и в адресе", () => {
  const secret = "supersecret token";

  assert.equal(redact("сбой: supersecret token", secret), "сбой: <секрет скрыт>");
  assert.ok(!redact(`GET https://bot.example/api/ingest?secret=${encodeURIComponent(secret)}`, secret).includes("supersecret"));
  // Даже когда самого секрета в этом месте нет, `?secret=` из адреса не печатается.
  assert.equal(
    redact("https://bot.example/api/ingest?secret=abc123", ""),
    "https://bot.example/api/ingest?secret=<секрет скрыт>",
  );
});

/* ---------- ответы бота ---------- */

test("разбирает список заданий и достраивает заголовок из адреса", () => {
  const jobs = parseJobs([
    { id: 7, title: "Госзакупки", listUrl: "https://procurement.kg/tenders" },
    { id: 8, title: "  ", listUrl: "https://zakupki.example.kg/list" },
  ]);

  assert.deepEqual(jobs, [
    { id: 7, title: "Госзакупки", listUrl: "https://procurement.kg/tenders" },
    { id: 8, title: "https://zakupki.example.kg/list", listUrl: "https://zakupki.example.kg/list" },
  ]);
});

test("задания без адреса или с плохим id пропускаются, а не роняют запуск", () => {
  const jobs = parseJobs([
    { id: 1, title: "Ок", listUrl: "https://a.example/list" },
    { id: 0, title: "Без id", listUrl: "https://b.example/list" },
    { id: 2, title: "Без адреса", listUrl: "" },
    "мусор",
    null,
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 1);
});

test("список заданий принимается и в обёртке, а ответ с ошибкой становится понятным сбоем", () => {
  const wrapped = parseJobs({ jobs: [{ id: 3, title: "Т", listUrl: "https://c.example/list" }] });
  assert.equal(wrapped.length, 1);

  assert.throws(() => parseJobs({ error: "unauthorized" }), /unauthorized/);
  assert.throws(() => parseJobs("привет"), /списком заданий/);
});

test("ответ на отправленную страницу разбирается, пропуски считаются нулями", () => {
  assert.deepEqual(parseIngestResult({ ok: true, found: 32, fresh: 4, notified: 2 }), {
    ok: true,
    found: 32,
    fresh: 4,
    notified: 2,
    seeded: false,
  });

  assert.deepEqual(parseIngestResult({ ok: true }), {
    ok: true,
    found: 0,
    fresh: 0,
    notified: 0,
    seeded: false,
  });
});

test("первый сбор бот отмечает отдельно — сборщик обязан это заметить", () => {
  // Без этого признака человек увидел бы «новых 32, разослано 0» и решил,
  // что рассылка сломана, — хотя это засев, ровно то, чего мы и хотели.
  const seeded = parseIngestResult({ ok: true, found: 32, fresh: 32, notified: 0, seeded: true });
  assert.equal(seeded.seeded, true);
});

test("отказ бота превращается в ошибку с его текстом", () => {
  assert.throws(() => parseIngestResult({ ok: false, error: "сайт выключен" }), /сайт выключен/);
  assert.throws(() => parseIngestResult({ error: "нет такой площадки" }), /нет такой площадки/);
  assert.throws(() => parseIngestResult([1, 2, 3]), /не тем/);
});

test("тело запроса собирается по контракту: siteId, html, fetchedAt", () => {
  const body = buildIngestBody(
    { id: 12, title: "Госзакупки", listUrl: "https://procurement.kg/tenders" },
    "<html>список</html>",
    new Date("2026-08-20T09:30:00.000Z"),
  );

  assert.deepEqual(body, {
    siteId: 12,
    html: "<html>список</html>",
    fetchedAt: "2026-08-20T09:30:00.000Z",
  });
});

test("тело с причиной неудачи — без html: по нему бот и отличает одно от другого", () => {
  const body = buildFailureBody(
    { id: 12, title: "Госзакупки", listUrl: "https://procurement.kg/tenders" },
    "сайт показал страницу проверки браузера",
  );

  assert.deepEqual(body, { siteId: 12, error: "сайт показал страницу проверки браузера" });
  assert.ok(!("html" in body), "с полем html бот принял бы это за страницу");
});

test("страницу больше 5 МБ сборщик не отправляет — бот её всё равно отвергнет", () => {
  const job = { id: 12, title: "Т", listUrl: "https://a.example/list" };
  const ok = buildIngestBody(job, "<li>тендер</li>".repeat(20_000), new Date(0));
  assert.ok(typeof encodeBody(ok) === "string");

  // В JSON страница разрастается: кавычки экранируются, кириллица занимает по
  // два байта. Поэтому проверяем именно готовое тело, а не длину html.
  const huge = buildIngestBody(job, "я".repeat(MAX_PAGE_BYTES), new Date(0));
  assert.throws(() => encodeBody(huge), new RegExp(PAGE_TOO_BIG_MESSAGE.slice(0, 20)));
});

/* ---------- распознавание страницы проверки браузера ---------- */

const listPage = (): string =>
  `<html><head><title>Тендеры</title></head><body>${'<div class="card"><a href="/t/1">Ремонт кровли школы</a></div>'.repeat(
    400,
  )}</body></html>`;

test("нормальный список тендеров проходит", () => {
  const html = listPage();
  assert.ok(Buffer.byteLength(html, "utf8") > MIN_LIST_BYTES);
  assert.deepEqual(inspectPage({ status: 200, html }), { blocked: false });
});

test("заголовок cf-mitigated — это проверка браузера", () => {
  const check = inspectPage({ status: 403, cfMitigated: "challenge", html: listPage() });
  assert.equal(check.blocked, true);
  assert.match(check.blocked ? check.reason : "", /проверк/i);
});

test("страница «Just a moment…» распознаётся по заголовку", () => {
  const html = `<html><head><title>Just a moment...</title></head><body>${"<p>ждите</p>".repeat(2000)}</body></html>`;
  const check = inspectPage({ status: 503, html });
  assert.equal(check.blocked, true);
  assert.match(check.blocked ? check.reason : "", /Just a moment/);
});

test("страница проверки узнаётся и по её содержимому", () => {
  const html = `<html><head><title>Загрузка</title></head><body><div id="cf_chl_opt"></div>${"<span>.</span>".repeat(
    2000,
  )}</body></html>`;
  const check = inspectPage({ status: 200, html });
  assert.equal(check.blocked, true);
});

test("маленькая страница вместо списка считается заглушкой", () => {
  const check = inspectPage({ status: 200, html: "<html><body>Пусто</body></html>" });
  assert.equal(check.blocked, true);
  assert.match(check.blocked ? check.reason : "", /КБ/);
});

test("отказ 403 без признаков Cloudflare тоже останавливает отправку", () => {
  const check = inspectPage({ status: 403, html: listPage() });
  assert.equal(check.blocked, true);
  assert.match(check.blocked ? check.reason : "", /403/);
});

test("поломка сайта (500) проверкой браузера не считается", () => {
  assert.deepEqual(inspectPage({ status: 500, html: "<html><body>Ошибка сервера</body></html>" }), {
    blocked: false,
  });
});

test("скрипт Cloudflare на обычной странице проверкой браузера не считается", () => {
  // Самая дорогая ошибка в этом файле: `/cdn-cgi/challenge-platform` Cloudflare
  // вставляет в КАЖДУЮ страницу защищённого им сайта, включая настоящий список
  // тендеров. Признак по нему отвергал бы ровно ту страницу, ради которой
  // сборщик и написан, — и советовал бы человеку открыть сайт в браузере, что
  // ничего бы не изменило.
  const html = listPage().replace(
    "<body>",
    '<body><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>',
  );

  assert.deepEqual(inspectPage({ status: 200, html }), { blocked: false });
});

test("проверка браузера всё ещё узнаётся всеми четырьмя способами", () => {
  const big = (inner: string): string => `<html><head><title>Загрузка</title></head><body>${inner}${"<p>.</p>".repeat(3000)}</body></html>`;

  // 1. заголовок ответа cf-mitigated
  assert.equal(inspectPage({ status: 200, cfMitigated: "challenge", html: listPage() }).blocked, true);
  // 2. заголовок страницы «Just a moment»
  assert.equal(
    inspectPage({ status: 200, html: `<html><head><title>Just a moment…</title></head><body>${"<p>.</p>".repeat(3000)}</body></html>` }).blocked,
    true,
  );
  // 3. отказ кодом 403 / 429 / 503
  for (const status of [403, 429, 503]) {
    assert.equal(inspectPage({ status, html: listPage() }).blocked, true, `код ${status}`);
  }
  // 4. слишком маленькая страница там, где ждали список
  assert.equal(inspectPage({ status: 200, html: "<html><body>ok</body></html>" }).blocked, true);

  // И содержимое самой страницы проверки — без адреса скрипта Cloudflare.
  assert.equal(inspectPage({ status: 200, html: big('<div id="cf_chl_opt"></div>') }).blocked, true);
  assert.equal(inspectPage({ status: 200, html: big("Checking your browser before accessing") }).blocked, true);
});

/* ---------- ограничение размера скачиваемой страницы ---------- */

/** Поток из кусочков: ровно то, что отдаёт `response.body` у fetch. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("страница читается по кусочкам и целиком собирается обратно", async () => {
  const bytes = await readCapped(
    streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]),
    MAX_PAGE_BYTES,
  );

  assert.deepEqual([...bytes], [1, 2, 3, 4, 5]);
  assert.deepEqual([...(await readCapped(null, MAX_PAGE_BYTES))], []);
});

test("бесконечная страница обрывается на пределе, а не съедает память", async () => {
  // Качаем мы недоверенные сайты с домашнего компьютера: сломанный или
  // враждебный сервер может лить байты, пока не кончится оперативная память.
  let sent = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });

  await assert.rejects(() => readCapped(endless, 256 * 1024), new RegExp(PAGE_TOO_BIG_MESSAGE.slice(0, 20)));
  assert.ok(sent < 100, `чтение должно оборваться сразу за пределом, а прочитано кусков: ${sent}`);
});

/* ---------- отчёт и код возврата ---------- */

const sent: SiteOutcome = {
  title: "Госзакупки",
  url: "https://procurement.kg/tenders",
  status: "sent",
  bytes: 250_000,
  result: { ok: true, found: 32, fresh: 4, notified: 3, seeded: false },
};

const blocked: SiteOutcome = {
  title: "Госзакупки",
  url: "https://procurement.kg/tenders",
  status: "blocked",
  reason: "сайт показал страницу проверки браузера",
};

const failed: SiteOutcome = {
  title: "Другая площадка",
  url: "https://other.example/list",
  status: "error",
  reason: "сайт не ответил вовремя",
};

test("успешная площадка показывает найдено, новых и разослано", () => {
  const text = formatOutcome(sent).join("\n");
  assert.match(text, /найдено 32/);
  assert.match(text, /новых 4/);
  assert.match(text, /разослано 3/);
});

test("первый сбор объясняется словами, а не молчаливым «разослано 0»", () => {
  const text = formatOutcome({ ...sent, result: { ok: true, found: 32, fresh: 32, notified: 0, seeded: true } }).join("\n");

  assert.match(text, /первый сбор/);
  assert.match(text, /помечено просмотренным/);
});

test("при проверке браузера человеку предлагают открыть сайт в браузере", () => {
  const text = formatOutcome(blocked).join("\n");
  assert.match(text, /проверк/i);
  assert.match(text, /браузере/);
  assert.match(text, /https:\/\/procurement\.kg\/tenders/);
});

test("о неудаче, ушедшей в бота, человеку говорят прямо", () => {
  // Иначе он не знает, увидит ли причину в карточке площадки, и полезет
  // сверять логи с ботом руками.
  assert.match(formatOutcome({ ...blocked, reported: true }).join("\n"), /карточк/);
  assert.match(formatOutcome({ ...failed, reported: true }).join("\n"), /карточк/);
  assert.ok(!formatOutcome(failed).join("\n").includes("карточк"));
});

test("итог считает обработанные, заблокированные и упавшие площадки", () => {
  assert.match(formatSummary([sent, blocked, failed]), /обработано 1 из 3/);
  assert.match(formatSummary([sent, blocked, failed]), /проверку браузера показали 1/);
  assert.match(formatSummary([sent, blocked, failed]), /с ошибкой 1/);
  assert.match(formatSummary([]), /Заданий не было/);
});

test("код возврата: 0 если хоть одна площадка дошла до бота, иначе 1", () => {
  assert.equal(exitCodeFor([]), 0);
  assert.equal(exitCodeFor([sent]), 0);
  assert.equal(exitCodeFor([sent, blocked, failed]), 0);
  assert.equal(exitCodeFor([blocked, failed]), 1);
  assert.equal(exitCodeFor([failed]), 1);
});

test("«fetch failed» превращается в понятную причину", () => {
  assert.equal(
    explainError(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") })),
    "не удалось соединиться (connect ECONNREFUSED 127.0.0.1:443)",
  );
  assert.equal(explainError(new TypeError("fetch failed")), "не удалось соединиться");

  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(explainError(timeout), "ответ не пришёл вовремя");
  assert.equal(explainError("странное"), "странное");
});

test("подсказка зависит от причины: секрет или связь", () => {
  assert.match(hintFor(WRONG_SECRET_MESSAGE), /CRON_SECRET/);
  assert.match(hintFor("не удалось соединиться"), /BOT_URL/);
});

test("заголовки — обычный набор браузера, без выдумок", () => {
  assert.match(BROWSER_HEADERS["user-agent"], /Chrome\/\d/);
  assert.equal(BROWSER_HEADERS["sec-fetch-mode"], "navigate");
  assert.equal(BROWSER_HEADERS["upgrade-insecure-requests"], "1");
  assert.ok(BROWSER_HEADERS["accept-language"].startsWith("ru"));
});
