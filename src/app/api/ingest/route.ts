import { getBot } from "@/lib/bot";
import { processScrapedItems, seedScrapedItems } from "@/lib/checker";
import { env } from "@/lib/env";
import {
  checkIngestSite,
  ingestAuthorized,
  ingestFailureReport,
  ingestFailureWarning,
  ingestJobs,
  ingestReport,
  ingestWarning,
  MAX_BODY_BYTES,
  parseIngestBody,
} from "@/lib/ingest";
import {
  countSeenItems,
  getSite,
  listKeywords,
  listLocalSites,
  markSiteChecked,
  notifyTargets,
} from "@/lib/repo";
import { extractItems } from "@/lib/scrape";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Приём страниц от домашнего сборщика.
 *
 * Часть площадок отдаёт тендеры только обычным посетителям: серверным адресам
 * они показывают проверку браузера, и с Vercel список не прочитать никак.
 * Такие площадки качает скрипт на компьютере владельца, а сюда присылает
 * готовый html. Всё остальное — разбор, отбор по ключевым словам,
 * дедупликация, рассылка — остаётся на сервере: логика мониторинга не должна
 * раздваиваться на «серверную» и «домашнюю».
 *
 *   GET  /api/ingest  → [{ id, title, listUrl }] — что качать
 *   POST /api/ingest  ← { siteId, html, fetchedAt? }
 *                     → { ok, found, fresh, notified, seeded }
 *   POST /api/ingest  ← { siteId, error }   — сбор не удался, причину в карточку
 *                     → { ok, noted }
 *
 * Секрет сборщик присылает заголовком `Authorization: Bearer …`: адрес с
 * `?secret=` оседал бы в журналах запросов Vercel при каждом сборе. Параметр
 * адреса остаётся принятым только ради уже настроенных установок.
 */

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request): Promise<Response> {
  if (!ingestAuthorized(request, env.ingestSecret)) return unauthorized();
  return Response.json(ingestJobs(await listLocalSites()));
}

export async function POST(request: Request): Promise<Response> {
  if (!ingestAuthorized(request, env.ingestSecret)) return unauthorized();

  // Заявленный размер отсекаем до чтения: гигабайт в память функции незачем
  // затягивать даже ради того, чтобы потом его отвергнуть.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json(
      { error: "страница слишком большая: принимаю не больше 5 МБ" },
      { status: 413 },
    );
  }

  const raw = await request.text();
  const parsed = parseIngestBody(raw);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  const checked = checkIngestSite(await getSite(parsed.value.siteId));
  if (!checked.ok) return Response.json({ error: checked.error }, { status: checked.status });

  const site = checked.value;

  // Сбор не удался. Пишем причину в карточку площадки и ничего не рассылаем:
  // иначе там осталась бы дата последнего удачного сбора — то есть «проверено,
  // ошибок нет» у площадки, которая уже неделю ничего не приносит.
  if (parsed.value.kind === "failure") {
    await markSiteChecked(site.id, ingestFailureWarning(parsed.value.error));
    return Response.json(ingestFailureReport());
  }

  // Ссылки достраиваем от адреса списка: сборщик качает ровно его.
  const items = extractItems(parsed.value.html, site.list_url, site.selectors);

  const [keywords, targets, seen] = await Promise.all([
    listKeywords(),
    notifyTargets(),
    countSeenItems(site.id),
  ]);

  // Первый сбор — это засев, а не находка: у обычных площадок ту же работу
  // делает seedSite при добавлении, а этой площадке сервер страницу взять не
  // может. Без засева установка сборщика заканчивалась бы пачкой сообщений про
  // тендеры, которые владелец и так видел на сайте.
  const seeded = seen === 0;
  const result = seeded
    ? await seedScrapedItems(site, items, keywords)
    : await processScrapedItems(site, items, keywords, targets, getBot().api);

  await markSiteChecked(site.id, ingestWarning(result.found));

  return Response.json(ingestReport({ ...result, seeded }));
}
