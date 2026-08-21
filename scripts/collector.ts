/**
 * Домашний сборщик.
 *
 * Часть площадок (например, procurement.kg) отдаёт список тендеров обычному
 * посетителю, а серверным адресам показывает страницу проверки браузера. Этот
 * скрипт запускается на домашнем компьютере, качает такие страницы с обычного
 * адреса и отдаёт HTML боту. Разбор, отбор по ключевым словам, дедупликация и
 * рассылка остаются на сервере — здесь только загрузка и передача.
 *
 *   npm run collect
 *
 * Мы не притворяемся кем-то другим сверх обычных браузерных заголовков и не
 * обходим проверки: если пришла страница проверки браузера, скрипт честно
 * говорит об этом и просит открыть сайт в браузере.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------- типы ---------- */

/** Задание от бота: какую страницу нужно скачать. */
export type Job = {
  id: number;
  title: string;
  listUrl: string;
};

/** Тело запроса к боту с готовым HTML. */
export type IngestBody = {
  siteId: number;
  html: string;
  fetchedAt: string;
};

/**
 * Тело запроса к боту, когда страницы нет. Бот запишет причину в карточку
 * площадки — иначе там осталась бы дата последнего удачного сбора, и владелец
 * видел бы «проверено, ошибок нет» у площадки, которая молчит неделю.
 */
export type FailureBody = {
  siteId: number;
  error: string;
};

/** Ответ бота на отправленный HTML. */
export type IngestResult = {
  ok: boolean;
  found: number;
  fresh: number;
  notified: number;
  /** Первый сбор: бот пометил найденное просмотренным и ничего не разослал. */
  seeded: boolean;
};

/** Чем закончилась одна площадка. */
export type SiteOutcome = {
  title: string;
  url: string;
  /** `sent` — HTML ушёл боту; `blocked` — сайт показал проверку; `error` — не вышло. */
  status: "sent" | "blocked" | "error";
  bytes?: number;
  result?: IngestResult;
  reason?: string;
  /** Про неудачу успели сказать боту — значит, причина видна в карточке площадки. */
  reported?: boolean;
};

export type Config = {
  /** Адрес бота без завершающего слэша. */
  botUrl: string;
  secret: string;
};

/* ---------- настройки ---------- */

/** Обычный набор заголовков браузера — ровно то, что шлёт Chrome при переходе по ссылке. */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "cache-control": "max-age=0",
};

/** Потолок ожидания одной страницы площадки. Дома сеть медленнее серверной. */
const PAGE_TIMEOUT_MS = 30_000;

/** Потолок ожидания ответа самого бота. */
const BOT_TIMEOUT_MS = 60_000;

/** Пауза между площадками: несколько загрузок подряд не должны выглядеть как атака. */
const SITE_DELAY_MS = 2_000;

/**
 * Список тендеров всегда весит больше десятка килобайт. Страница проверки
 * браузера и заглушки — заметно меньше, это и есть признак.
 */
export const MIN_LIST_BYTES = 10_000;

/**
 * Потолок на скачиваемую страницу — тот же, что принимает бот. Качаем мы
 * недоверенные сайты: страница, которая льётся бесконечно, иначе съела бы
 * память домашнего компьютера, а страница на 6 МБ впустую прошла бы по сети,
 * чтобы бот отверг её кодом 413.
 */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/** Что сказать человеку про страницу, которая не влезла. */
export const PAGE_TOO_BIG_MESSAGE =
  `страница больше ${Math.round(MAX_PAGE_BYTES / (1024 * 1024))} МБ — ` +
  "на список тендеров не похоже, боту такое не отправляю";

/* ---------- чистые функции: настройки ---------- */

/**
 * Разбирает .env.local сам. Своим разбором, а не флагом `--env-file` у tsx:
 * по расписанию скрипт стартует не из терминала, файла может не быть вовсе, и
 * тогда флаг печатает человеку английское «.env.local not found» поверх нашего
 * объяснения. Читаем файл здесь — и говорим о нём одними своими словами.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

/** Свой же компьютер: только с ним разговор без шифрования безопасен. */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Приводит адрес бота к виду `https://host` без хвостового слэша.
 *
 * Без https по сети идёт секрет приёма страниц открытым текстом — прочитать
 * его сможет любой сосед по вай-фаю. Исключение одно: свой же компьютер
 * (`http://localhost:3000`), там сеть не участвует.
 */
export function normalizeBotUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") throw new Error("адрес бота пустой");

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`не похоже на адрес сайта: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`адрес бота должен начинаться с https://, а не с ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new Error(
      `адрес бота должен начинаться с https:// — поправьте строку BOT_URL: ${trimmed}`,
    );
  }
  return withScheme.replace(/\/+$/, "");
}

/**
 * Годится ли секрет для заголовка запроса.
 *
 * Заголовки HTTP умеют только однобайтовые символы. Русская буква в секрете
 * роняет сам `fetch` — до сети дело не доходит вовсе, — а человек читает
 * «Cannot convert argument to a ByteString because the character at index 7
 * has a value of 1089», из чего понять нельзя ровно ничего. Раньше секрет
 * уходил в адресе, где кириллица переживала кодирование, так что заметить это
 * можно было только после перехода на заголовок.
 */
export function headerSafeSecret(secret: string): boolean {
  return /^[\x20-\x7e]+$/.test(secret);
}

/** Что сказать человеку про секрет, который нельзя отправить. */
export const BAD_SECRET_MESSAGE =
  "в секрете есть русские буквы или другие непечатные знаки — такой секрет отправить " +
  "нельзя. Придумайте новый из латинских букв и цифр (например, командой " +
  "openssl rand -hex 32) и запишите одно и то же значение и в .env.local, и в " +
  "настройки проекта на сервере.";

/**
 * Берёт настройки сначала из окружения, затем из .env.local. Ничего из этого
 * не печатает: секрет не должен попасть ни в лог, ни на экран.
 */
export function resolveConfig(
  fromEnv: Record<string, string | undefined>,
  fromFile: Record<string, string> = {},
): Config {
  const pick = (name: string): string => {
    const value = fromEnv[name] ?? fromFile[name] ?? "";
    return value.trim();
  };

  const botUrl = pick("BOT_URL");
  // INGEST_SECRET умеет ровно одно — прислать боту страницу. CRON_SECRET
  // остаётся запасным вариантом ради уже настроенных установок: он же подпись
  // webhook Telegram и ключ от /api/setup, поэтому на домашнем компьютере ему
  // не место.
  const secret = pick("INGEST_SECRET") || pick("CRON_SECRET");

  const missing = [
    botUrl === "" ? "BOT_URL" : null,
    secret === "" ? "INGEST_SECRET (или CRON_SECRET)" : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new Error(
      `в файле .env.local не хватает строк: ${missing.join(", ")}. ` +
        "Добавьте их и запустите снова.",
    );
  }

  if (!headerSafeSecret(secret)) throw new Error(BAD_SECRET_MESSAGE);

  return { botUrl: normalizeBotUrl(botUrl), secret };
}

/** Адрес маршрута без секрета — только его и можно печатать. */
export function ingestEndpoint(botUrl: string): string {
  return `${botUrl}/api/ingest`;
}

/**
 * Секрет уходит заголовком, а не в адресе: Vercel пишет полный адрес запроса
 * в журнал, и `?secret=…` оставался бы там после каждого сбора — 96 записей в
 * сутки, доступных всем, у кого есть доступ к журналам проекта.
 */
export function authHeaders(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

/**
 * Убирает секрет из любого текста перед печатью: он может прилететь внутри
 * ошибки fetch. Заодно вырезает `?secret=...` из адресов — на случай, когда
 * сам секрет в этом месте кода недоступен.
 */
export function redact(text: string, secret: string): string {
  let safe = text.replace(/([?&]secret=)[^&\s"'<>]+/gi, "$1<секрет скрыт>");
  if (secret === "") return safe;

  for (const variant of [secret, encodeURIComponent(secret)]) {
    if (variant === "") continue;
    safe = safe.split(variant).join("<секрет скрыт>");
  }
  return safe;
}

/* ---------- чистые функции: разбор ответов бота ---------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Разбирает список заданий. Бот отдаёт массив, но терпим и к обёртке
 * `{ jobs: [...] }` — чтобы смена формы ответа не роняла сборщик у человека.
 */
export function parseJobs(payload: unknown): Job[] {
  let list: unknown = payload;

  if (!Array.isArray(list)) {
    const record = asRecord(payload);
    const nested = record?.jobs ?? record?.sites;
    if (Array.isArray(nested)) {
      list = nested;
    } else {
      const error = typeof record?.error === "string" ? record.error : null;
      throw new Error(error ?? "бот ответил не списком заданий");
    }
  }

  const jobs: Job[] = [];
  for (const entry of list as unknown[]) {
    const record = asRecord(entry);
    if (!record) continue;

    const id = Number(record.id);
    const listUrl = typeof record.listUrl === "string" ? record.listUrl.trim() : "";
    if (!Number.isFinite(id) || id <= 0 || listUrl === "") continue;

    const title = typeof record.title === "string" && record.title.trim() !== ""
      ? record.title.trim()
      : listUrl;

    jobs.push({ id, title, listUrl });
  }

  return jobs;
}

/** Разбирает ответ на отправленный HTML. Числа могут не прийти — считаем нулями. */
export function parseIngestResult(payload: unknown): IngestResult {
  const record = asRecord(payload);
  if (!record) throw new Error("бот ответил не тем, что ожидалось");

  if (record.ok === false || typeof record.error === "string") {
    const message = typeof record.error === "string" ? record.error : "бот отказался принять страницу";
    throw new Error(message);
  }

  const num = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };

  return {
    ok: true,
    found: num(record.found),
    fresh: num(record.fresh),
    notified: num(record.notified),
    seeded: record.seeded === true,
  };
}

/** Тело запроса с готовой страницей. */
export function buildIngestBody(job: Job, html: string, fetchedAt: Date): IngestBody {
  return { siteId: job.id, html, fetchedAt: fetchedAt.toISOString() };
}

/** Тело запроса с причиной неудачи: страницы нет, но молчать нельзя. */
export function buildFailureBody(job: Job, reason: string): FailureBody {
  return { siteId: job.id, error: reason };
}

/**
 * Готовое тело запроса — вместе с проверкой размера. Бот принимает не больше
 * 5 МБ, а в JSON страница занимает заметно больше, чем на диске: кавычки,
 * переводы строк и не-латиница там разрастаются. Проверяем до отправки, иначе
 * человек прочитал бы «бот не принял страницу: 413» после того, как мегабайты
 * впустую сходили по домашнему каналу.
 */
export function encodeBody(body: IngestBody | FailureBody): string {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, "utf8") > MAX_PAGE_BYTES) throw new Error(PAGE_TOO_BIG_MESSAGE);
  return json;
}

/* ---------- чистые функции: распознавание страницы проверки ---------- */

export type PageCheck = { blocked: false } | { blocked: true; reason: string };

/**
 * Признаки именно страницы проверки. Каждый из них встречается только на ней.
 *
 * Здесь намеренно нет `/cdn-cgi/challenge-platform`: этот адрес Cloudflare
 * вставляет своим сборщиком примет в КАЖДУЮ обычную страницу защищённого им
 * сайта, в том числе в настоящий список тендеров. С ним сборщик отвергал бы
 * ровно ту страницу, ради которой всё и написано, и советовал человеку открыть
 * сайт в браузере — что ничего бы не изменило.
 */
const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "проверка браузера",
  "enable javascript and cookies to continue",
  "cf-browser-verification",
  "cf_chl_opt",
  "attention required! | cloudflare",
];

/**
 * Отвечает на один вопрос: это список тендеров или страница проверки браузера.
 * Признаки — заголовок «Just a moment», заголовок ответа `cf-mitigated`
 * и подозрительно маленький размер там, где ожидается список.
 *
 * Обычная поломка сайта (404, 500) проверкой браузера не считается: про неё
 * человеку честнее сказать кодом ответа, а не советом открыть браузер.
 */
export function inspectPage(input: {
  status: number;
  cfMitigated?: string | null;
  html: string;
}): PageCheck {
  const html = input.html;
  const lower = html.toLowerCase();
  const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1]?.trim() ?? "";

  if (input.cfMitigated) {
    return {
      blocked: true,
      reason: `сайт включил проверку браузера (cf-mitigated: ${input.cfMitigated})`,
    };
  }

  if (/just a moment/i.test(title)) {
    return { blocked: true, reason: "сайт показал страницу проверки браузера («Just a moment…»)" };
  }

  if (CHALLENGE_MARKERS.some((needle) => lower.includes(needle))) {
    return { blocked: true, reason: "сайт показал страницу проверки браузера" };
  }

  if (input.status < 200 || input.status >= 300) {
    if (input.status === 403 || input.status === 429 || input.status === 503) {
      return { blocked: true, reason: `сайт ответил отказом (код ${input.status})` };
    }
    return { blocked: false };
  }

  const size = Buffer.byteLength(html, "utf8");
  if (size < MIN_LIST_BYTES) {
    return {
      blocked: true,
      reason: `вместо списка пришла страница на ${Math.max(1, Math.round(size / 1024))} КБ — на список тендеров не похоже`,
    };
  }

  return { blocked: false };
}

/* ---------- чистые функции: отчёт и код возврата ---------- */

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Строки отчёта по одной площадке — то, что человек читает в логе. */
export function formatOutcome(outcome: SiteOutcome): string[] {
  const lines: string[] = [];

  if (outcome.status === "sent" && outcome.result) {
    const { found, fresh, notified, seeded } = outcome.result;
    lines.push(`  скачано ${kilobytes(outcome.bytes ?? 0)}, отправлено боту`);
    lines.push(`  бот разобрал: найдено ${found}, новых ${fresh}, разослано ${notified}`);
    if (seeded) {
      lines.push(
        "  это был первый сбор: всё найденное помечено просмотренным,",
        "  дальше в Telegram придут только новые тендеры",
      );
    }
    return lines;
  }

  if (outcome.status === "blocked") {
    lines.push(`  не получилось: ${outcome.reason ?? "сайт не отдал список"}`);
    lines.push(`  что сделать: откройте ${outcome.url} в браузере на этом компьютере,`);
    lines.push("  дождитесь загрузки списка и запустите сборщик снова");
    if (outcome.reported) lines.push("  причину записал в карточку площадки в боте");
    return lines;
  }

  lines.push(`  ошибка: ${outcome.reason ?? "неизвестно"}`);
  if (outcome.reported) lines.push("  причину записал в карточку площадки в боте");
  return lines;
}

/** Итоговая строка запуска. */
export function formatSummary(outcomes: SiteOutcome[]): string {
  if (outcomes.length === 0) return "Заданий не было — бот не просил ничего скачивать.";
  const sent = outcomes.filter((outcome) => outcome.status === "sent").length;
  const blocked = outcomes.filter((outcome) => outcome.status === "blocked").length;
  const failed = outcomes.filter((outcome) => outcome.status === "error").length;

  const parts = [`Итог: обработано ${sent} из ${outcomes.length}`];
  if (blocked > 0) parts.push(`проверку браузера показали ${blocked}`);
  if (failed > 0) parts.push(`с ошибкой ${failed}`);
  return `${parts.join(", ")}.`;
}

/**
 * Ноль — если хоть одна площадка дошла до бота; единица — если не дошла ни одна.
 * По этому коду расписание отличает поломку от обычного прогона.
 */
export function exitCodeFor(outcomes: SiteOutcome[]): 0 | 1 {
  if (outcomes.length === 0) return 0;
  return outcomes.some((outcome) => outcome.status === "sent") ? 0 : 1;
}

/* ---------- работа с сетью ---------- */

/** Корень проекта: скрипт лежит в scripts/. */
function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readEnvFile(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(resolve(projectRoot(), ".env.local"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Читает ответ по кускам и обрывает чтение, как только он перевалил за лимит.
 * `arrayBuffer()` этого не умеет: он честно сложит в память всё, что льют, —
 * а качаем мы недоверенные сайты с домашнего компьютера.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > limit) throw new Error(PAGE_TOO_BIG_MESSAGE);
      chunks.push(value);
    }
  } finally {
    // Обрываем закачку: иначе сайт продолжал бы лить в никуда до таймаута.
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Декодирует ответ с учётом кодировки: площадки СНГ до сих пор отдают windows-1251. */
function decodeBody(buffer: Uint8Array, contentType: string | null): string {
  const headerCharset = /charset=([\w-]+)/i.exec(contentType ?? "")?.[1];
  const asUtf8 = new TextDecoder("utf-8").decode(buffer);
  const metaCharset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(asUtf8.slice(0, 2000))?.[1];
  const charset = (headerCharset ?? metaCharset ?? "utf-8").toLowerCase();

  if (charset === "utf-8" || charset === "utf8") return asUtf8;
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return asUtf8;
  }
}

type FetchedPage = {
  status: number;
  html: string;
  bytes: number;
  cfMitigated: string | null;
};

async function fetchPage(url: string): Promise<FetchedPage> {
  const response = await fetch(url, {
    headers: { ...BROWSER_HEADERS },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });

  // Заявленный размер отсекаем ещё до чтения, если сайт его назвал.
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(PAGE_TOO_BIG_MESSAGE);
  }

  const bytes = await readCapped(response.body, MAX_PAGE_BYTES);
  return {
    status: response.status,
    html: decodeBody(bytes, response.headers.get("content-type")),
    bytes: bytes.byteLength,
    cfMitigated: response.headers.get("cf-mitigated"),
  };
}

async function askForJobs(config: Config): Promise<Job[]> {
  const response = await fetch(ingestEndpoint(config.botUrl), {
    headers: { ...authHeaders(config.secret), accept: "application/json" },
    signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
  });

  if (response.status === 401) throw new Error(WRONG_SECRET_MESSAGE);
  if (!response.ok) {
    throw new Error(`бот ответил ${response.status} ${response.statusText}`);
  }

  return parseJobs(await response.json());
}

/** Один POST боту: тело либо со страницей, либо с причиной неудачи. */
async function postToBot(config: Config, body: IngestBody | FailureBody): Promise<unknown> {
  const response = await fetch(ingestEndpoint(config.botUrl), {
    method: "POST",
    headers: {
      ...authHeaders(config.secret),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: encodeBody(body),
    signal: AbortSignal.timeout(BOT_TIMEOUT_MS),
  });

  if (response.status === 401) throw new Error(WRONG_SECRET_MESSAGE);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`бот ответил ${response.status} без понятного ответа`);
  }

  if (!response.ok) {
    const record = asRecord(payload);
    const message = typeof record?.error === "string" ? record.error : `${response.status}`;
    throw new Error(`бот не принял страницу: ${message}`);
  }

  return payload;
}

async function sendPage(config: Config, body: IngestBody): Promise<IngestResult> {
  return parseIngestResult(await postToBot(config, body));
}

/**
 * Рассказывает боту, почему страницы не будет. Своя неудача тут не важна:
 * человек и так увидит причину в логе, а поверх неё сыпать ещё и «не смог
 * пожаловаться» — только путать.
 */
async function tellBotAboutFailure(config: Config, job: Job, reason: string): Promise<boolean> {
  try {
    // Причина уходит в карточку площадки, то есть в чат Telegram. Секрет туда
    // попасть не должен ни при каких обстоятельствах: текст ошибки приходит из
    // fetch и из ответа бота, и однажды в нём окажется адрес запроса целиком.
    await postToBot(config, buildFailureBody(job, redact(reason, config.secret)));
    return true;
  } catch {
    return false;
  }
}

/* ---------- запуск ---------- */

/**
 * Человеческий текст ошибки. Голое `fetch failed` человеку ничего не говорит:
 * настоящая причина (нет сети, отказ соединения, просроченный сертификат)
 * лежит уровнем ниже, в `cause`.
 */
/** Один и тот же текст на 401 от обоих запросов: подсказка человеку зависит от него. */
export const WRONG_SECRET_MESSAGE =
  "бот не узнал секрет: строка INGEST_SECRET (или CRON_SECRET) в .env.local " +
  "не совпадает с той, что записана в настройках проекта на сервере";

/** Что человеку делать после неудачного разговора с ботом. */
export function hintFor(message: string): string {
  return message === WRONG_SECRET_MESSAGE
    ? "Откройте .env.local и сверьте строку INGEST_SECRET (или CRON_SECRET) со значением на сервере."
    : "Проверьте интернет и строку BOT_URL в файле .env.local.";
}

export function explainError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === "TimeoutError" || error.name === "AbortError") return "ответ не пришёл вовремя";

  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";

  if (error.message === "fetch failed") {
    return causeText === "" ? "не удалось соединиться" : `не удалось соединиться (${causeText})`;
  }
  return error.message;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function handleJob(config: Config, job: Job): Promise<SiteOutcome> {
  const page = await fetchPage(job.listUrl);
  const check = inspectPage(page);

  if (check.blocked) {
    return { title: job.title, url: job.listUrl, status: "blocked", bytes: page.bytes, reason: check.reason };
  }
  if (!(page.status >= 200 && page.status < 300)) {
    return {
      title: job.title,
      url: job.listUrl,
      status: "error",
      reason: `сайт ответил ${page.status}`,
    };
  }

  const result = await sendPage(config, buildIngestBody(job, page.html, new Date()));
  return { title: job.title, url: job.listUrl, status: "sent", bytes: page.bytes, result };
}

export async function main(): Promise<number> {
  let config: Config;
  try {
    config = resolveConfig(process.env, readEnvFile());
  } catch (error) {
    console.error(`Не могу начать: ${explainError(error)}`);
    return 1;
  }

  const say = (line: string): void => console.log(redact(line, config.secret));
  const complain = (line: string): void => console.error(redact(line, config.secret));

  say(`Сборщик тендеров. Запуск ${new Date().toLocaleString("ru-RU")}`);
  say(`Спрашиваю бота (${ingestEndpoint(config.botUrl)}), какие площадки скачать...`);

  let jobs: Job[];
  try {
    jobs = await askForJobs(config);
  } catch (error) {
    const message = explainError(error);
    complain(`Не получилось связаться с ботом: ${message}`);
    complain(hintFor(message));
    return 1;
  }

  if (jobs.length === 0) {
    say(formatSummary([]));
    return 0;
  }

  say(`Заданий: ${jobs.length}`);
  const outcomes: SiteOutcome[] = [];

  for (const [index, job] of jobs.entries()) {
    if (index > 0) await sleep(SITE_DELAY_MS);
    say("");
    say(`[${index + 1}/${jobs.length}] ${job.title}`);
    say(`  качаю ${job.listUrl}`);

    let outcome: SiteOutcome;
    try {
      outcome = await handleJob(config, job);
    } catch (error) {
      outcome = { title: job.title, url: job.listUrl, status: "error", reason: explainError(error) };
    }

    // О неудаче говорим боту: иначе в карточке площадки навсегда останется
    // дата последнего удачного сбора, и владелец узнает о поломке только по
    // тому, что тендеры перестали приходить.
    if (outcome.status !== "sent") {
      const reported = await tellBotAboutFailure(
        config,
        job,
        outcome.reason ?? "сбор не удался",
      );
      outcome = { ...outcome, reported };
    }

    outcomes.push(outcome);
    for (const line of formatOutcome(outcome)) {
      if (outcome.status === "sent") say(line);
      else complain(line);
    }
  }

  say("");
  say(formatSummary(outcomes));
  return exitCodeFor(outcomes);
}

const entry = process.argv[1];
const runDirectly = entry !== undefined && pathToFileURL(entry).href === import.meta.url;

if (runDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(redact(error instanceof Error ? error.message : String(error), ""));
      process.exitCode = 1;
    });
}
