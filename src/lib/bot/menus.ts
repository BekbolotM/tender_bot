import { InlineKeyboard } from "grammy";
import { INVITE_TTL_HOURS } from "../invites.ts";
import { escapeHtml } from "../notify.ts";
import { page, PAGE_SIZE, type Page } from "../paginate.ts";
import type { Keyword, Site, SiteSearch } from "../types";
import { inviteButtons, inviteHint } from "./invitemenu.ts";
import {
  CB,
  lastErrorLine,
  localStaleLine,
  searchModeText,
  siteFieldsLine,
  VIA_LOCAL_LINE,
} from "./onboarding.ts";

export const MAIN_MENU_TEXT =
  "<b>Тендер-бот</b>\nСледит за площадками и присылает тендеры по ключевым словам.";

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🌐 Сайты", "sites").text("🔑 Ключевые слова", "kw").row()
    .text("▶️ Проверить сейчас", "check").text("📊 Статистика", "stats").row()
    .text("👤 Админы", "admins");
}

/** Строка «предыдущие/следующие» — добавляется только когда страниц больше одной. */
function pageRow<T>(keyboard: InlineKeyboard, all: T[], { items, from }: Page<T>, prefix: string): void {
  if (all.length <= PAGE_SIZE) return;
  if (from > 0) keyboard.text("⬅️ Предыдущие", `${prefix}:${Math.max(from - PAGE_SIZE, 0)}`);
  if (from + items.length < all.length) keyboard.text("Следующие ➡️", `${prefix}:${from + PAGE_SIZE}`);
  keyboard.row();
}

export function sitesMenu(sites: Site[], offset = 0): { text: string; keyboard: InlineKeyboard } {
  const shown = page(sites, offset);
  const keyboard = new InlineKeyboard();
  // Готовые площадки — первой кнопкой: человеку без опыта незачем начинать с
  // поиска ссылки и разбора чужой страницы, из каталога сайт добавляется двумя
  // нажатиями. Ручное добавление остаётся, но ниже.
  keyboard.text("⭐ Готовые площадки", CB.catalog).row();
  for (const site of shown.items) {
    keyboard.text(`${site.enabled ? "✅" : "⛔"} ${site.title}`, `site:${site.id}`).row();
  }
  pageRow(keyboard, sites, shown, "sites_page");
  keyboard
    .text("➕ Добавить сайт по ссылке", CB.siteAdd).row()
    .text("⬅️ Назад", "main");

  const text = sites.length
    ? `<b>Сайты</b> — ${sites.length} шт. Нажмите на сайт, чтобы настроить.${shown.note}`
    : [
        "<b>Сайты</b>",
        "Пока пусто.",
        "",
        "Проще всего начать с «⭐ Готовые площадки» — там сайты уже настроены.",
      ].join("\n");

  return { text, keyboard };
}

/**
 * Как режим поиска подписан в карточке сайта и в отчёте о добавлении. Имя
 * параметра формы человеку ничего не говорит, поэтому оно живёт в подробностях
 * для продвинутых, а здесь остаётся только смысл.
 */
export function searchModeLabel(search: SiteSearch): string {
  return searchModeText(search);
}

export function siteCard(
  site: Site,
  now: number = Date.now(),
): { text: string; keyboard: InlineKeyboard } {
  const checked = site.last_checked_at
    ? new Date(site.last_checked_at).toLocaleString("ru-RU", { timeZone: "UTC" }) + " UTC"
    : "ещё не проверялся";

  // Правила разбора отсюда убраны намеренно: строка вида `div.card > a` человеку
  // ничего не сообщает и пугает. Вместо неё — что бот умеет показывать.
  const lines = [
    `<b>${escapeHtml(site.title)}</b>`,
    `🔗 ${escapeHtml(site.list_url)}`,
    `Статус: ${site.enabled ? "включён" : "выключен"}`,
    `Проверен: ${checked}`,
    `Показываю: ${siteFieldsLine(site.selectors)}`,
    `Режим: ${searchModeLabel(site.search)}`,
  ];
  // Про способ обхода говорим только там, где он необычный: у остальных площадок
  // строка «читаю сам» ничего не добавляет, а карточку удлиняет.
  if (site.via_local) lines.push(VIA_LOCAL_LINE);
  if (site.last_error) lines.push(lastErrorLine(site.last_error));
  // Молчащий домашний сбор виден только здесь: сам он о себе не напомнит.
  const stale = localStaleLine(site, now);
  if (stale) lines.push(stale);

  const keyboard = new InlineKeyboard()
    .text(site.enabled ? "⛔ Выключить" : "✅ Включить", `site_toggle:${site.id}`)
    .text("🧪 Проверить", `site_test:${site.id}`).row();
  // Поиск на стороне площадки ведёт к её же страницам, а их бот и не открывает:
  // с вашего компьютера приходит только страница списка. Кнопка была бы обманом.
  if (!site.via_local) {
    keyboard.text(
      site.search.mode === "query" ? "🔁 Читать весь список" : "🔎 Искать через сайт",
      `site_search_toggle:${site.id}`,
    ).row();
  }
  // Площадка может начать показывать проверку браузера уже после добавления —
  // и наоборот. Без этой кнопки переключить способ обхода было бы нечем:
  // повторное добавление из каталога бот отсекает как дубль.
  keyboard
    .text(
      site.via_local ? "🌍 Читать без моего компьютера" : "💻 Читать с моего компьютера",
      `site_local:${site.id}`,
    ).row();
  keyboard
    .text("⚙️ Подробности для продвинутых", `site_raw:${site.id}`).row()
    .text("🗑 Удалить", `site_del:${site.id}`).row()
    .text("⬅️ К сайтам", "sites");

  return { text: lines.join("\n"), keyboard };
}

export function keywordsMenu(
  keywords: Keyword[],
  offset = 0,
): { text: string; keyboard: InlineKeyboard } {
  const shown = page(keywords, offset);
  const keyboard = new InlineKeyboard();
  for (const keyword of shown.items) {
    keyboard
      .text(`${keyword.is_negative ? "🚫" : "🔑"} ${keyword.word}  ✕`, `kw_del:${keyword.id}`)
      .row();
  }
  pageRow(keyboard, keywords, shown, "kw_page");
  keyboard.text("➕ Добавить", "kw_add").row().text("⬅️ Назад", "main");

  const text = keywords.length
    ? `<b>Ключевые слова</b>\nНажмите на слово, чтобы удалить.\n🔑 — искомое, 🚫 — минус-слово.${shown.note}`
    : "<b>Ключевые слова</b>\nСписок пуст — сейчас бот шлёт <i>все</i> новые тендеры.";

  return { text, keyboard };
}

/**
 * Подтверждение удаления админа. Отдельный шаг, потому что промах по строке
 * списка отбирает доступ мгновенно и без отмены, а заодно гасит выпущенные
 * этим админом ссылки — об этом лучше сказать до нажатия, а не после.
 */
export function adminDeleteConfirm(
  tgId: number,
  label: string,
): { text: string; keyboard: InlineKeyboard } {
  const text = [
    `<b>Удалить админа ${escapeHtml(label)}?</b>`,
    `id <code>${tgId}</code>`,
    "",
    "Он потеряет доступ к боту и уведомления о тендерах,",
    "а выпущенные им и ещё не использованные ссылки перестанут работать.",
  ].join("\n");

  const keyboard = new InlineKeyboard()
    .text("🗑 Да, удалить", `admin_del_yes:${tgId}`)
    .row()
    .text("⬅️ Отмена", "admins");

  return { text, keyboard };
}

export function adminsMenu(
  admins: { tg_id: number; username: string | null }[],
  owners: number[],
  offset = 0,
  activeInvites = 0,
): { text: string; keyboard: InlineKeyboard } {
  const shown = page(admins, offset);
  const keyboard = new InlineKeyboard();
  for (const admin of shown.items) {
    const label = admin.username ? `@${admin.username}` : String(admin.tg_id);
    keyboard.text(`👤 ${label}  ✕`, `admin_del:${admin.tg_id}`).row();
  }
  pageRow(keyboard, admins, shown, "admins_page");
  keyboard.text("➕ Добавить админа", "admin_add").row();
  for (const button of inviteButtons(activeInvites)) keyboard.text(button.text, button.data).row();
  keyboard.text("⬅️ Назад", "main");

  const text = [
    "<b>Админы</b>",
    `Владельцы (из настроек сервера): ${owners.join(", ") || "не заданы"}`,
    `Все они получают уведомления о найденных тендерах.${shown.note}`,
    "",
    inviteHint(activeInvites, INVITE_TTL_HOURS),
  ].join("\n");

  return { text, keyboard };
}
