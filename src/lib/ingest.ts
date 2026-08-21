/**
 * Приём страниц от домашнего сборщика — всё, что можно проверить без сети и
 * базы. Сам маршрут (`/api/ingest`) остаётся тонким: он только ходит в базу и
 * зовёт разбор, а решения о теле запроса принимаются здесь и покрыты тестами.
 *
 * Зачем сборщик вообще нужен: часть площадок пускает только обычных
 * посетителей, а серверным адресам показывает проверку браузера. Такую
 * площадку качает скрипт на компьютере владельца и присылает сюда готовую
 * страницу; разбор, отбор по ключевым словам и рассылка остаются на сервере.
 */

import type { Site } from "./types";

/**
 * Потолок на тело запроса. Страница списка тендеров весит порядка 150 КБ,
 * так что пяти мегабайт хватает с многократным запасом; всё, что больше, —
 * это либо не та страница, либо сломанный сборщик, и разбирать его незачем:
 * тело запроса целиком лежит в памяти функции.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Длина причины неудачи, которая помещается в карточку площадки. */
export const MAX_REASON_CHARS = 200;

/** Страница площадки: какая площадка, её html и когда сборщик её скачал. */
export type IngestPage = {
  kind: "page";
  siteId: number;
  html: string;
  /** Время сбора со стороны сборщика. На разбор не влияет, полезно в логах. */
  fetchedAt: string | null;
};

/**
 * Сбор не удался: компьютер был в сети, но страницу забрать не вышло.
 * Без этого сообщения карточка площадки показывала бы прошлый удачный сбор,
 * то есть «проверено, ошибок нет», хотя тендеры уже неделю не приходят.
 */
export type IngestFailure = {
  kind: "failure";
  siteId: number;
  error: string;
};

/** Что сборщик прислал: готовую страницу или причину, по которой её нет. */
export type IngestPayload = IngestPage | IngestFailure;

/** Разбор чужого ввода: либо значение, либо готовый ответ с кодом и причиной. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

/** Задание сборщику: что скачать. Ничего лишнего — правила разбора остаются на сервере. */
export type IngestJob = { id: number; title: string; listUrl: string };

/** Ответ на принятую страницу: сборщик печатает эти числа человеку. */
export type IngestReport = {
  ok: true;
  found: number;
  fresh: number;
  notified: number;
  /** Первый сбор: найденное помечено просмотренным, рассылки не было. */
  seeded: boolean;
};

/** Ответ на сообщение о неудаче: принято и записано в карточку площадки. */
export type IngestFailureReport = { ok: true; noted: true };

/**
 * Секрет проверяем так же, как в кроне: заголовком или параметром адреса.
 * Сборщику удобнее параметр — он живёт в одной строке настроек.
 */
export function ingestAuthorized(request: Request, secret: string): boolean {
  if (request.headers.get("authorization") === `Bearer ${secret}`) return true;
  try {
    return new URL(request.url).searchParams.get("secret") === secret;
  } catch {
    return false;
  }
}

/** Размер тела в байтах: русский текст в UTF-8 занимает вдвое больше, чем символов. */
export function bodyBytes(raw: string): number {
  return Buffer.byteLength(raw, "utf8");
}

/**
 * Причина неудачи попадает в карточку площадки, то есть в сообщение Telegram.
 * Оставляем одну строку разумной длины: переводы строк и служебные символы в
 * карточке ни к чему, а длинный кусок чужого текста её просто затопит.
 */
export function cleanFailureReason(raw: string): string {
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REASON_CHARS
    ? `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…`
    : oneLine;
}

/**
 * Разбирает тело POST-запроса. Всё, что пришло снаружи, — недоверенное:
 * siteId должен быть целым положительным числом (он уходит в запрос к базе
 * параметром), html — непустой строкой.
 *
 * Тело бывает двух видов: страница (`{ siteId, html }`) и сообщение о неудаче
 * (`{ siteId, error }`). Второе нужно, чтобы владелец увидел причину в карточке
 * площадки, а не гадал, почему тендеры перестали приходить.
 */
export function parseIngestBody(raw: string): Parsed<IngestPayload> {
  if (bodyBytes(raw) > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `страница слишком большая: принимаю не больше ${Math.round(
        MAX_BODY_BYTES / (1024 * 1024),
      )} МБ`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "тело запроса не разобралось как JSON" };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "ожидаю объект { siteId, html }" };
  }

  const record = body as Record<string, unknown>;
  const { siteId, html, fetchedAt, error } = record;

  if (typeof siteId !== "number" || !Number.isSafeInteger(siteId) || siteId <= 0) {
    return { ok: false, status: 400, error: "siteId должен быть целым положительным числом" };
  }

  // Сообщение о неудаче: страницы нет, но причина есть. Отличаем по тому, что
  // html не прислали вовсе, — иначе опечатка в теле молча стала бы «неудачей».
  if (!("html" in record) && typeof error === "string") {
    const reason = cleanFailureReason(error);
    if (reason === "") {
      return { ok: false, status: 400, error: "error должен быть непустой строкой" };
    }
    return { ok: true, value: { kind: "failure", siteId, error: reason } };
  }

  if (typeof html !== "string" || html.trim() === "") {
    return { ok: false, status: 400, error: "html должен быть непустой строкой" };
  }

  return {
    ok: true,
    value: {
      kind: "page",
      siteId,
      html,
      fetchedAt: typeof fetchedAt === "string" ? fetchedAt : null,
    },
  };
}

/**
 * Годится ли площадка для приёма. Отказ объясняем словами: сборщик печатает
 * этот текст владельцу, а он не программист и должен понять, что делать.
 */
export function checkIngestSite(site: Site | null): Parsed<Site> {
  if (!site) {
    return { ok: false, status: 400, error: "такой площадки в боте нет — проверьте список заданий" };
  }
  if (!site.via_local) {
    return {
      ok: false,
      status: 400,
      error: `площадку «${site.title}» сервер обходит сам — страницы от сборщика для неё не нужны`,
    };
  }
  if (!site.enabled) {
    return {
      ok: false,
      status: 400,
      error: `площадка «${site.title}» выключена в боте — включите её в меню «Сайты»`,
    };
  }
  return { ok: true, value: site };
}

/** Список заданий сборщику. Отдаём ровно три поля: остальное ему не нужно. */
export function ingestJobs(sites: Site[]): IngestJob[] {
  return sites.map((site) => ({ id: site.id, title: site.title, listUrl: site.list_url }));
}

/**
 * Что записать в карточку площадки. Пустая страница — не успех: либо сборщику
 * тоже показали проверку браузера, либо вёрстка площадки поменялась, и владелец
 * должен увидеть это в боте, а не гадать, почему тендеры перестали приходить.
 */
export function ingestWarning(found: number): string | null {
  return found === 0 ? "страница пришла с вашего компьютера, но тендеров в ней не нашлось" : null;
}

/**
 * Что записать в карточку площадки, когда сбор не удался. Текст сборщика
 * сам по себе не говорит, кто и что делал, — а владелец читает карточку
 * через неделю и должен понять с одного взгляда.
 */
export function ingestFailureWarning(reason: string): string {
  return `сбор с вашего компьютера не удался: ${reason}`;
}

/** Ответ сборщику: он печатает эти числа человеку после каждого сбора. */
export function ingestReport(result: {
  found: number;
  fresh: number;
  notified: number;
  seeded?: boolean;
}): IngestReport {
  return {
    ok: true,
    found: result.found,
    fresh: result.fresh,
    notified: result.notified,
    seeded: result.seeded === true,
  };
}

/** Ответ на сообщение о неудаче: причина записана в карточку площадки. */
export function ingestFailureReport(): IngestFailureReport {
  return { ok: true, noted: true };
}
