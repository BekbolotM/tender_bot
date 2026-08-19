import { getBot } from "@/lib/bot";
import { migrate } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Одноразовая инициализация: создаёт таблицы и подписывает бота на webhook.
 * Вызывается вручную после деплоя, поэтому закрыт тем же секретом, что и крон.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.cronSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  await migrate();

  const webhookUrl = `${url.origin}/api/telegram`;
  const bot = getBot();
  await bot.api.setWebhook(webhookUrl, {
    secret_token: env.cronSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  // Токен может быть от прежнего бота: сбрасываем его кнопку меню
  // (там могло висеть web-app «Туры/Бронь») на стандартный список команд.
  await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });

  await bot.api.setMyCommands([
    { command: "menu", description: "Открыть меню" },
    { command: "check", description: "Проверить сайты сейчас" },
    { command: "cancel", description: "Отменить текущее действие" },
  ]);

  const me = await bot.api.getMe();

  return Response.json({
    ok: true,
    migrated: true,
    webhook: webhookUrl,
    bot: { id: me.id, username: me.username, name: me.first_name },
  });
}
