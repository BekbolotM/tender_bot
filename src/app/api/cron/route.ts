import { getBot } from "@/lib/bot";
import { runCheck } from "@/lib/checker";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Vercel Cron шлёт `Authorization: Bearer <CRON_SECRET>`; внешние планировщики — `?secret=`. */
function authorized(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (header === `Bearer ${env.cronSecret}`) return true;
  return new URL(request.url).searchParams.get("secret") === env.cronSecret;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const results = await runCheck(getBot().api);

  return Response.json({
    ok: true,
    tookMs: Date.now() - startedAt,
    results,
  });
}
