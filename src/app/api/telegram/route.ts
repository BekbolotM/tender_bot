import { webhookCallback } from "grammy";
import { getBot } from "@/lib/bot";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Секрет из CRON_SECRET передаётся Telegram при setWebhook и приходит
 * обратно в заголовке — так посторонний не сможет слать боту апдейты.
 */
/**
 * Ждать ответа Telegram готов около минуты, дальше он присылает тот же апдейт
 * заново — и обработчик запускается вторым потоком. Поэтому держим запрос
 * заметно меньше этого окна, а долгая работа (проверка сайтов, первичный разбор)
 * ограничена собственными дедлайнами и укладывается в него.
 */
const WEBHOOK_TIMEOUT_MS = 55_000;

export async function POST(request: Request): Promise<Response> {
  const handler = webhookCallback(getBot(), "std/http", {
    secretToken: env.cronSecret,
    timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
    onTimeout: "return",
  });
  return handler(request);
}

export function GET(): Response {
  return new Response("Telegram webhook endpoint. Use POST.", { status: 405 });
}
