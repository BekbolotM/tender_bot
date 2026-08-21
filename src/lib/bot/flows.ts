import type { Context } from "grammy";
import { matchExample } from "../byexample";
import { seedSite, type SeedResult } from "../checker";
import { guessFields } from "../fieldguess";
import { env } from "../env";
import { detectFilterForms } from "../filters";
import { matchText } from "../match";
import { escapeHtml } from "../notify";
import { diagnosePage } from "../pagestate";
import {
  addAdmin,
  addKeyword,
  addSite,
  clearState,
  getSite,
  getState,
  listKeywords,
  setSiteEnabled,
  setSiteSelectors,
  setState,
} from "../repo";
import { detectSelectors, extractItems, fetchHtml } from "../scrape";
import { pickSearchForm, searchFromForm } from "../searchurl";
import type { Selectors, SiteSearch } from "../types";
import { looksLikeUrl, parseUrl } from "../urls";
import { parseAdminId } from "./access";
import { mainMenu, MAIN_MENU_TEXT, searchModeLabel, siteCard } from "./menus";
import {
  askExampleAgain,
  canTeachByExample,
  candidatesMessage,
  exampleFailedMessage,
  exampleFoundMessage,
  httpStatusFromError,
  learnByExampleMessage,
  localSiteAddedText,
  MANUAL_HINT,
  MANUAL_RETRY,
  NOT_A_LINK_TEXT,
  parseManualSelectors,
  searchOfferMessage,
} from "./onboarding.ts";

/** Состояния диалога. Хранятся в БД: у serverless нет памяти между запросами. */
export const STATES = {
  siteUrl: "site_url",
  siteName: "site_name",
  siteManual: "site_manual",
  /** Ждём название тендера, скопированное человеком со страницы. */
  siteExample: "site_example",
  keywordAdd: "kw_add",
  adminAdd: "admin_add",
} as const;

/**
 * Страница вместе с кодом ответа. Код нужен только `diagnosePage`, чтобы
 * объяснить человеку причину его же словами; наружу он никогда не выходит.
 */
export type LoadedPage = { html: string; status?: number };

/**
 * Качает страницу и не бросает: неответ площадки — это тоже её состояние, и
 * рассказать о нём человеку надо так же спокойно, как об открывшейся странице.
 */
export async function loadPage(url: string): Promise<LoadedPage> {
  try {
    return { html: await fetchHtml(url), status: 200 };
  } catch (error) {
    return { html: "", status: httpStatusFromError(error) };
  }
}

/** Режим поиска из состояния диалога: до нажатия кнопки — обычный обход. */
function readSearch(payload: Record<string, unknown>): SiteSearch {
  const search = payload.search as SiteSearch | undefined;
  return search?.mode === "query" ? search : { mode: "off" };
}

/** Payload переносим целиком: в нём уже может лежать выбранный режим поиска. */
export async function promptManual(
  ctx: Context,
  payload: Record<string, unknown>,
): Promise<void> {
  await setState(ctx.from!.id, STATES.siteManual, payload);
  await ctx.reply(MANUAL_HINT, { parse_mode: "HTML" });
}

/** Просьба прислать образец. Отдельно от разбора ссылки: её же шлёт кнопка «другой пример». */
export async function promptExample(
  ctx: Context,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = String(payload.url ?? "");
  await setState(ctx.from!.id, STATES.siteExample, payload);
  await ctx.reply(askExampleAgain(url), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** Обрабатывает обычное текстовое сообщение согласно текущему состоянию. */
export async function handleText(ctx: Context): Promise<void> {
  const tgId = ctx.from!.id;
  const input = (ctx.message?.text ?? "").trim();
  const { state, payload } = await getState(tgId);

  // Ссылка — сама по себе команда «разбери эту площадку»: заставлять человека
  // сперва пройти меню → «Сайты» → «Добавить сайт» незачем.
  if (!state) {
    if (looksLikeUrl(input)) {
      await handleSiteUrl(ctx, input);
      return;
    }
    await ctx.reply(MAIN_MENU_TEXT, { parse_mode: "HTML", reply_markup: mainMenu() });
    return;
  }

  if (input === "/cancel") {
    await clearState(tgId);
    await ctx.reply("Отменено.", { reply_markup: mainMenu() });
    return;
  }

  switch (state) {
    case STATES.siteUrl:
      await handleSiteUrl(ctx, input);
      return;
    case STATES.siteExample:
      await handleExample(ctx, input, payload);
      return;
    case STATES.siteManual:
      await handleManualSelectors(ctx, input, payload);
      return;
    case STATES.siteName:
      await handleSiteName(ctx, input, payload);
      return;
    case STATES.keywordAdd:
      await handleKeywords(ctx, input);
      return;
    case STATES.adminAdd:
      await handleAdmin(ctx, input);
      return;
    default:
      await clearState(tgId);
      await ctx.reply(MAIN_MENU_TEXT, { parse_mode: "HTML", reply_markup: mainMenu() });
  }
}

/**
 * Разбор присланной ссылки. Порядок шагов подчинён одному правилу: человек
 * должен уходить от бота с понятным следующим действием. Поэтому сначала мы
 * пробуем всё сами, при неудаче объясняем причину обычными словами и только
 * потом просим о помощи — и просим о том, что он может сделать глазами и мышкой.
 */
async function handleSiteUrl(ctx: Context, input: string): Promise<void> {
  const url = parseUrl(input);
  if (!url) {
    await ctx.reply(NOT_A_LINK_TEXT);
    return;
  }

  await ctx.reply("Открываю страницу и ищу список тендеров…");

  // Страницу качаем один раз: и списки, и поиск сайта ищем в этом же тексте.
  const page = await loadPage(url);
  const candidates = detectSelectors(page.html, url);
  const best = pickSearchForm(detectFilterForms(page.html, url));
  const offer = best ? searchFromForm(best) : null;
  // В состояние диалога кладём только мелочь — текст страницы туда не влезет.
  const base: Record<string, unknown> = offer ? { url, searchOffer: offer } : { url };

  if (candidates.length === 0) {
    const diagnosis = diagnosePage({ html: page.html, status: page.status, url, itemsFound: 0 });
    const { text, keyboard } = learnByExampleMessage(diagnosis, url);
    // Ждём образец только там, где он может сработать. Если сайт вообще не
    // отдал список, присланного заголовка на странице тоже не окажется —
    // человек остаётся на приёме ссылки и может прислать другую.
    await setState(
      ctx.from!.id,
      canTeachByExample(diagnosis) ? STATES.siteExample : STATES.siteUrl,
      base,
    );
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  await setState(ctx.from!.id, STATES.siteUrl, {
    ...base,
    candidates: candidates.map((c) => c.selectors),
  });

  // Считаем совпадения прямо здесь: страница уже на руках, сеть не нужна.
  const keywords = await listKeywords();
  const positives = keywords.filter((keyword) => !keyword.is_negative).length;
  const matched = candidates.map((candidate) =>
    positives === 0
      ? null
      : extractItems(page.html, url, candidate.selectors).filter(
          (item) => matchText(`${item.title} ${item.text}`, keywords).matched,
        ).length,
  );

  const { text, keyboard } = candidatesMessage(candidates, matched);
  // Без слов матчер пропускает всё, и цифра «подходит N» вводила бы в заблуждение.
  const hint =
    positives === 0
      ? "\n\nКлючевых слов пока нет — подойдёт всё; добавьте их в меню «🔑 Ключевые слова»."
      : "";
  await ctx.reply(text + hint, { parse_mode: "HTML", reply_markup: keyboard });
  if (offer) await sendSearchOffer(ctx);
}

/** Предложение искать через поиск площадки. Шлём только когда такой поиск найден. */
export async function sendSearchOffer(ctx: Context): Promise<void> {
  const { text, keyboard } = searchOfferMessage();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * Обучение по образцу: человек прислал название тендера, скопированное со
 * страницы. Текст страницы в состоянии диалога не хранится (там место только
 * под адрес), поэтому качаем её заново — зато человеку не нужно ничего знать
 * про устройство сайта.
 */
async function handleExample(
  ctx: Context,
  input: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = String(payload.url ?? "");
  if (!url) {
    await clearState(ctx.from!.id);
    await ctx.reply("Что-то пошло не так, начнём заново: /start");
    return;
  }

  // Вместо образца прислали новую ссылку — значит, эту страницу человек бросил.
  if (looksLikeUrl(input)) {
    await handleSiteUrl(ctx, input);
    return;
  }

  await ctx.reply("Ищу этот тендер на странице…");

  const page = await loadPage(url);
  if (!page.html) {
    const diagnosis = diagnosePage({ html: "", status: page.status, url, itemsFound: 0 });
    const { text, keyboard } = learnByExampleMessage(diagnosis, url);
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const result = matchExample(page.html, url, input);
  if (!result.ok) {
    const { text, keyboard } = exampleFailedMessage(result.reason);
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  const { selectors } = result.candidate;
  const items = extractItems(page.html, url, selectors);
  // Подтверждать пустую находку человеку нельзя: он нажал бы «да», а сайт
  // завёлся бы читающим пустоту и молчал бы неделями без единой причины.
  if (items.length === 0) {
    const failed = exampleFailedMessage("uneven");
    await ctx.reply(failed.text, { parse_mode: "HTML", reply_markup: failed.keyboard });
    return;
  }

  const guessed = guessFields(page.html, selectors.item);
  // Правила короткие, в состояние диалога помещаются; текст страницы — нет.
  await setState(ctx.from!.id, STATES.siteExample, { ...payload, selectors });

  const { text, keyboard } = exampleFoundMessage(items, guessed);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

async function handleManualSelectors(
  ctx: Context,
  input: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const selectors = parseManualSelectors(input);
  if (!selectors) {
    await ctx.reply(MANUAL_RETRY, { parse_mode: "HTML" });
    return;
  }

  // Правила правят у существующего сайта: второй сайт на тот же адрес завёл бы
  // свой список виденного и прислал бы все тендеры площадки заново.
  const siteId = payload.siteId;
  if (typeof siteId === "number") {
    await setSiteSelectors(siteId, selectors);
    await clearState(ctx.from!.id);
    const site = await getSite(siteId);
    if (!site) {
      await ctx.reply("Сайт уже удалён.", { reply_markup: mainMenu() });
      return;
    }
    const card = siteCard(site);
    await ctx.reply(`✅ Правила обновлены.\n\n${card.text}`, {
      parse_mode: "HTML",
      reply_markup: card.keyboard,
    });
    return;
  }

  await setState(ctx.from!.id, STATES.siteName, { ...payload, selectors });
  await ctx.reply("Как назвать этот сайт? Пришлите название или /skip, чтобы взять адрес.");
}

/**
 * Итог первого разбора. Показываем не только числа, но и сами заголовки:
 * по ним сразу видно, те ли позиции читает бот и работают ли ключевые слова.
 */
function formatSeedReport(seed: SeedResult): string {
  const lines = [`Найдено позиций: <b>${seed.found}</b>`];

  // При пустом списке слов матчер пропускает всё, и «подходит N» из N звучало бы
  // как работающий фильтр, которого на самом деле ещё нет.
  lines.push(
    seed.keywords === 0
      ? "Ключевых слов пока нет — подходит всё. Добавьте их в меню «🔑 Ключевые слова»."
      : `Подходит под ключевые слова: <b>${seed.matched}</b>`,
  );

  if (seed.fallback) {
    lines.push("", "⚠️ Через поиск сайта ничего не разобралось — читаю обычную страницу списка.");
  }

  if (seed.found === 0) {
    lines.push("", "Сейчас со страницы ничего не читается — нажмите «🧪 Проверить» в карточке сайта.");
    return lines.join("\n");
  }

  const preview = seed.preview.map((item) => {
    const title = escapeHtml(item.title.slice(0, 120));
    return item.url ? `• <a href="${escapeHtml(item.url)}">${title}</a>` : `• ${title}`;
  });
  if (preview.length) lines.push("", ...preview);

  lines.push("", "Всё найденное помечено просмотренным — дальше придут только новые позиции.");
  return lines.join("\n");
}

/**
 * Общий финал добавления: и для ссылки, и для готовой площадки из каталога.
 * Сайт создаём выключенным — пока идёт первичный разбор, параллельный крон
 * успел бы разослать всю историю площадки, ровно то, ради чего разбор и нужен.
 */
export async function finishSiteAdd(
  ctx: Context,
  params: {
    title: string;
    url: string;
    selectors: Selectors;
    search: SiteSearch;
    /** Площадку читает программа на компьютере владельца, а не бот. */
    viaLocal?: boolean;
  },
): Promise<void> {
  // Площадку домашнего сборщика включаем сразу: первый разбор ей делать нечем —
  // с сервера она не открывается, — а выключенная она не попадёт в задания
  // сборщику и не заработает даже после его установки.
  if (params.viaLocal) {
    await addSite(params.title, params.url, params.selectors, { mode: "off" }, true, true);
    await clearState(ctx.from!.id);
    // Владельцу показываем сами команды установки: идти за ними ему не к кому.
    await ctx.reply(localSiteAddedText(params.title, env.ownerIds.includes(ctx.from!.id)), {
      parse_mode: "HTML",
      reply_markup: mainMenu(),
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const site = await addSite(params.title, params.url, params.selectors, params.search, false);
  await clearState(ctx.from!.id);

  const progress =
    params.search.mode === "query"
      ? "Прогоняю ключевые слова через поиск сайта…"
      : "Читаю страницу…";
  await ctx.reply(
    `✅ Сайт «${escapeHtml(params.title)}» добавлен.\nРежим: ${searchModeLabel(
      params.search,
    )}.\n${progress}`,
    { parse_mode: "HTML" },
  );

  try {
    const seed = await seedSite(site);
    await setSiteEnabled(site.id, true);
    await ctx.reply(formatSeedReport(seed), {
      parse_mode: "HTML",
      reply_markup: mainMenu(),
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // Оставляем сайт выключенным: иначе первый же крон принял бы все старые
    // тендеры за новые и прислал их пачкой. Текст ошибки человеку не нужен —
    // ему нужно знать, что делать дальше.
    await ctx.reply(
      "Сайт добавлен, но прочитать его прямо сейчас не вышло — площадка не ответила.\n\n" +
        "Пока он выключен. Загляните в «🌐 Сайты» позже и включите его одной кнопкой.",
      { parse_mode: "HTML", reply_markup: mainMenu() },
    );
  }
}

async function handleSiteName(
  ctx: Context,
  input: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = String(payload.url ?? "");
  const selectors = payload.selectors as Selectors | undefined;
  if (!url || !selectors) {
    await clearState(ctx.from!.id);
    await ctx.reply("Что-то пошло не так, начните заново: /start");
    return;
  }

  const title = input === "/skip" || !input ? new URL(url).hostname : input.slice(0, 80);
  await finishSiteAdd(ctx, { title, url, selectors, search: readSearch(payload) });
}

async function handleKeywords(ctx: Context, input: string): Promise<void> {
  const words = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (words.length === 0) {
    await ctx.reply("Пришлите хотя бы одно слово.");
    return;
  }

  let positives = 0;
  let negatives = 0;
  for (const word of words) {
    const isNegative = word.startsWith("-");
    const bare = isNegative ? word.slice(1).trim() : word;
    if (!bare) continue;
    await addKeyword(bare.toLowerCase(), isNegative);
    if (isNegative) negatives += 1;
    else positives += 1;
  }

  await clearState(ctx.from!.id);
  await ctx.reply(`✅ Добавлено: ${positives} ключевых, ${negatives} минус-слов.`, {
    reply_markup: mainMenu(),
  });
}

async function handleAdmin(ctx: Context, input: string): Promise<void> {
  // Только голое число: раньше из строки вычёркивались нецифры, и вставленная
  // в чат ссылка-приглашение превращалась в «админа 38» — с ним потом падала
  // каждая рассылка крона.
  const tgId = parseAdminId(input);
  if (tgId === null) {
    await ctx.reply(
      "Нужен только числовой Telegram ID, без ника и ссылок — например 123456789.\n" +
        "Узнать его можно у @userinfobot, или /cancel.",
    );
    return;
  }

  await addAdmin(tgId, null);
  await clearState(ctx.from!.id);
  await ctx.reply(`✅ Админ ${tgId} добавлен.`, { reply_markup: mainMenu() });
}
