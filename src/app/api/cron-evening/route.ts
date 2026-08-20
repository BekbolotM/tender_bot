/**
 * Второй слот расписания. Vercel считает задания по пути, поэтому два крона
 * на один и тот же адрес схлопываются в одно — а на бесплатном тарифе каждое
 * задание срабатывает лишь раз в сутки. Отдельный путь даёт вторую проверку
 * за день; обработчик тот же самый.
 */
export { GET } from "../cron/route";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
