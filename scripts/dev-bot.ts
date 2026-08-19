/**
 * Локальный запуск бота через long polling — без публичного URL и webhook.
 * Тот же код, что и в проде; отличается только способ получения апдейтов.
 *
 *   npm run bot:local
 */
import { getBot } from "../src/lib/bot";
import { runCheck } from "../src/lib/checker";
import { migrate } from "../src/lib/db";

const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MINUTES ?? 15) * 60_000;

async function main() {
  await migrate();
  const bot = getBot();

  await bot.api.deleteWebhook({ drop_pending_updates: false });
  await bot.api.setMyCommands([
    { command: "menu", description: "Открыть меню" },
    { command: "check", description: "Проверить сайты сейчас" },
    { command: "cancel", description: "Отменить текущее действие" },
  ]);

  const timer = setInterval(() => {
    runCheck(bot.api).catch((error) => console.error("Ошибка планового обхода:", error));
  }, CHECK_INTERVAL_MS);

  process.once("SIGINT", () => {
    clearInterval(timer);
    void bot.stop();
  });

  console.log(`Бот запущен. Проверка сайтов каждые ${CHECK_INTERVAL_MS / 60_000} мин.`);
  await bot.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
