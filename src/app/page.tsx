export const dynamic = "force-dynamic";

/** Служебная страница: подтверждает, что деплой жив и переменные заданы. */
export default function Home() {
  const configured = {
    "TELEGRAM_BOT_TOKEN": Boolean(process.env.TELEGRAM_BOT_TOKEN),
    "DATABASE_URL": Boolean(process.env.DATABASE_URL),
    "CRON_SECRET": Boolean(process.env.CRON_SECRET),
    "OWNER_TELEGRAM_ID": Boolean(process.env.OWNER_TELEGRAM_ID),
  };

  return (
    <main>
      <h1>Тендер-бот</h1>
      <p>Сервис работает. Управление — в Telegram, командой /menu.</p>
      <h2>Переменные окружения</h2>
      <ul>
        {Object.entries(configured).map(([name, ok]) => (
          <li key={name}>
            {ok ? "✅" : "❌"} <code>{name}</code>
          </li>
        ))}
      </ul>
      <p>
        После первого деплоя откройте <code>/api/setup?secret=CRON_SECRET</code> — создаст
        таблицы и подпишет бота на webhook.
      </p>
    </main>
  );
}
