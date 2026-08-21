function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

export const env = {
  get botToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  /**
   * Секрет приёма страниц от домашнего сборщика. Отдельный от кронового,
   * потому что живёт не на сервере, а на домашнем компьютере владельца, и
   * умеет ровно одно: прислать страницу площадки. Кроновый секрет — это ещё и
   * подпись webhook Telegram, ключ /api/setup и /api/probe; таскать его на
   * ноутбук незачем. Пока INGEST_SECRET не задан, работает старый — иначе
   * выкладка новой версии молча выключила бы уже настроенный сбор.
   */
  get ingestSecret() {
    const own = (process.env.INGEST_SECRET ?? "").trim();
    return own === "" ? required("CRON_SECRET") : own;
  },
  /** Владельцы бота — всегда админы, их нельзя удалить через интерфейс. */
  get ownerIds(): number[] {
    return (process.env.OWNER_TELEGRAM_ID ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
  },
};
