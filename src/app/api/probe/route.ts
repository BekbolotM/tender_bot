import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Диагностика: показывает, что видит бот с сервера Vercel по заданному адресу.
 * Площадки часто ведут себя иначе с адресами дата-центров, и без такого
 * запроса причина отказа неотличима от поломки разбора.
 * Закрыт тем же секретом, что и крон, и ходит только по http/https.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (params.get("secret") !== env.cronSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const target = params.get("url");
  if (!target) return Response.json({ error: "нужен параметр url" }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: "плохой адрес" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json({ error: "только http и https" }, { status: 400 });
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(parsed, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "ru,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    const body = await response.text();
    return Response.json({
      status: response.status,
      finalUrl: response.url,
      tookMs: Date.now() - startedAt,
      size: body.length,
      title: /<title[^>]*>([^<]*)/i.exec(body)?.[1]?.slice(0, 120) ?? null,
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
      cfMitigated: response.headers.get("cf-mitigated"),
      head: body.slice(0, 400),
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
      tookMs: Date.now() - startedAt,
    });
  }
}
