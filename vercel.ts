import type { VercelConfig } from "@vercel/config/v1";

/**
 * Расписание проверки тендеров.
 *
 * На Hobby-плане Vercel Cron может срабатывать только раз в сутки, поэтому
 * здесь стоит ежедневный запуск — с ним деплой проходит на любом тарифе.
 * Для проверок раз в 10–15 минут есть два пути:
 *   1) Pro-тариф — поменяйте schedule на "*\/15 * * * *";
 *   2) любой внешний планировщик (например cron-job.org), который дёргает
 *      https://<домен>/api/cron?secret=<CRON_SECRET>
 */
export const config: VercelConfig = {
  framework: "nextjs",
  crons: [{ path: "/api/cron", schedule: "0 6 * * *" }],
};
