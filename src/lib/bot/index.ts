import { Bot, type Context } from "grammy";
import { catalogEntry, catalogList } from "../catalog";
import { runCheck, targetUrls } from "../checker";
import { env } from "../env";
import { guessFields } from "../fieldguess";
import { detectFilterForms } from "../filters";
import {
  formatInviteMessage,
  INVITE_TTL_HOURS,
  inviteExpiresAt,
  inviteLink,
  newInviteToken,
  parseInvitePayload,
} from "../invites";
import { escapeHtml } from "../notify";
import {
  claimOwnership,
  clearState,
  countActiveInvites,
  createInvite,
  deleteKeyword,
  deleteSite,
  getSite,
  getState,
  inviteCreator,
  isAdmin,
  listActiveInvites,
  listAdmins,
  listKeywords,
  listLocalSites,
  listSites,
  redeemInvite,
  removeAdmin,
  revokeInvites,
  setSiteEnabled,
  setSiteSearch,
  setSiteSelectors,
  setSiteViaLocal,
  setState,
  stats,
} from "../repo";
import { diagnosePage } from "../pagestate";
import { detectSelectors, extractItems, fetchHtml } from "../scrape";
import { pickSearchForm, searchFromForm } from "../searchurl";
import type { Selectors, SiteSearch } from "../types";
import { accessDeniedText, adminDeletionError, revokeNote } from "./access";
import {
  finishSiteAdd,
  handleText,
  loadPage,
  promptExample,
  promptManual,
  sendSearchOffer,
  STATES,
} from "./flows";
import {
  adminDeleteConfirm,
  adminsMenu,
  keywordsMenu,
  mainMenu,
  MAIN_MENU_TEXT,
  siteCard,
  sitesMenu,
} from "./menus";
import {
  advancedDetails,
  ASK_URL_TEXT,
  candidatesMessage,
  CATALOG_ALREADY_ADDED,
  catalogFailed,
  catalogFound,
  catalogLocalOnly,
  catalogMenu,
  localCheckNote,
  sameListUrl,
  testFailedReport,
  testReport,
  viaLocalSwitchedText,
  VIA_LOCAL_TEST_TEXT,
} from "./onboarding";
import { startPayload } from "./startpayload";

let cached: Bot | null = null;

export function getBot(): Bot {
  if (cached) return cached;

  const bot = new Bot(env.botToken);

  // Бот полностью приватный: посторонним отвечаем их же id, чтобы владелец мог их добавить.
  bot.use(async (ctx, next) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const username = ctx.from?.username ?? null;

    // Приглашение разбираем ДО проверки прав: перешедший по собственной ссылке
    // админ иначе проходил бы гейтом, токен оставался бы живым все сутки, и
    // права получил бы любой, кому эта ссылка попадётся позже (скриншот,
    // пересланная переписка). Токен нигде не логируем и не повторяем в ответах —
    // он равен правам.
    const token = parseInvitePayload(startPayload(ctx.message?.text, ctx.me.username));
    const admin = await isAdmin(tgId);

    if (token && (await redeemInvite(token, tgId, username))) {
      // Клавиатуру прежнего бота снимаем этим же сообщением: отдельное
      // «убираю меню предыдущего бота» приглашённому непонятно — он видит
      // этого бота впервые.
      await ctx.reply(
        admin
          ? "🔗 Ссылка погашена — вы и так админ, больше она никому прав не даст."
          : "✅ Приглашение принято — вы стали админом этого бота.",
        { reply_markup: { remove_keyboard: true } },
      );
      // Состояние действующего админа не трогаем: он мог не закончить диалог.
      if (!admin) await setState(tgId, null, { keyboardCleaned: true });
      await notifyInviteCreator(ctx, token, tgId, username);
      // Дальше отработает обработчик /start и покажет главное меню.
      return next();
    }

    if (admin) return next();

    // Свежий деплой без заданного владельца: первый написавший забирает бота себе.
    if (env.ownerIds.length === 0 && (await claimOwnership(tgId, username))) {
      await ctx.reply(
        "👑 Вы стали владельцем этого бота — доступ для остальных закрыт.\n" +
          "Добавляйте других людей через меню «Админы».",
        { reply_markup: { remove_keyboard: true } },
      );
      await setState(tgId, null, { keyboardCleaned: true });
      return next();
    }

    const denied = accessDeniedText(tgId, token !== null, INVITE_TTL_HOURS);
    // Алертом, а не исчезающим тостом: у снятого админа на экране осталось
    // открытое меню, и по кнопке он должен увидеть и причину, и свой id —
    // иначе попросить доступ обратно ему нечем.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: denied.plain, show_alert: true });
    else await ctx.reply(denied.html, { parse_mode: "HTML" });
  });

  // Сбой в обработчике кнопки (например, таблицы нет — /api/setup после деплоя
  // не вызывали) иначе остаётся только в логах: ответ на callback не уходит,
  // Telegram крутит спиннер, и кнопка выглядит просто мёртвой.
  bot.on("callback_query", async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      try {
        await ctx.answerCallbackQuery({
          text: "Сбой на стороне бота — попробуйте ещё раз или откройте меню заново: /menu",
          show_alert: true,
        });
      } catch {
        // Ответить можно один раз и только пока callback не протух — тогда молчим.
      }
      throw error; // Разбор ошибки остаётся за bot.catch.
    }
  });

  bot.command(["start", "menu"], async (ctx) => {
    const tgId = ctx.from!.id;

    // Токен мог достаться от прежнего бота, и в чате осталась его
    // reply-клавиатура (Telegram хранит её на своей стороне, а не в коде).
    // Убираем её один раз — дальше всё управление на inline-кнопках.
    const { payload } = await getState(tgId);
    if (!payload.keyboardCleaned) {
      await ctx.reply("♻️ Убираю меню предыдущего бота.", {
        reply_markup: { remove_keyboard: true },
      });
    }

    await setState(tgId, null, { keyboardCleaned: true });
    await ctx.reply(MAIN_MENU_TEXT, { parse_mode: "HTML", reply_markup: mainMenu() });
  });

  bot.command("cancel", async (ctx) => {
    await clearState(ctx.from!.id);
    await ctx.reply("Отменено.", { reply_markup: mainMenu() });
  });

  bot.command("check", async (ctx) => {
    await ctx.reply("Запускаю проверку…");
    await replyWithCheckResults(ctx);
  });

  registerCallbacks(bot);

  bot.on("message:text", handleText);

  bot.catch((error) => console.error("Ошибка бота:", error));

  cached = bot;
  return bot;
}

/**
 * Сообщает выпустившему ссылку, кто по ней вошёл: иначе о новом админе он
 * узнаёт только по незнакомому нику в списке — а ссылку могли и переслать
 * не тому. Отправка не должна ронять вход: создателя могли уже удалить,
 * он мог заблокировать бота или никогда ему не писать.
 */
async function notifyInviteCreator(
  ctx: Context,
  token: string,
  tgId: number,
  username: string | null,
): Promise<void> {
  try {
    const createdBy = await inviteCreator(token, tgId);
    // Себе о собственном переходе не пишем — он и так только что его сделал.
    if (createdBy === null || createdBy === tgId) return;
    const who = username ? `@${escapeHtml(username)}` : "пользователь без ника";
    await ctx.api.sendMessage(
      createdBy,
      `🔗 По вашей ссылке-приглашению вошёл ${who} — id <code>${tgId}</code>.\n` +
        "Если это не тот, кого вы звали, снимите его в меню «👤 Админы».",
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("Не удалось сообщить о входе по приглашению:", error);
  }
}

/**
 * Проверка по кнопке идёт внутри webhook-запроса, а Telegram, не дождавшись
 * ответа примерно за минуту, шлёт тот же апдейт заново — и проверка запускается
 * вторым потоком. Поэтому ручной прогон короче кроновского: он должен успеть
 * ответить. Недообойдённые сайты достанутся ближайшему крону.
 */
const MANUAL_CHECK_DEADLINE_MS = 45_000;

async function replyWithCheckResults(ctx: Context): Promise<void> {
  const results = await runCheck(ctx.api, MANUAL_CHECK_DEADLINE_MS);
  // Площадки домашнего сборщика в прогон не входят: их приносит программа с
  // компьютера владельца. Промолчать о них нельзя — иначе кнопка выглядела бы
  // так, будто она их проверила и ничего не нашла.
  const note = localCheckNote((await listLocalSites()).length);

  if (results.length === 0) {
    await ctx.reply(note ?? "Нет включённых сайтов.", { reply_markup: mainMenu() });
    return;
  }

  const lines = results.map((result) =>
    result.error
      ? `⚠️ ${escapeHtml(result.site)}: ${escapeHtml(result.error)}`
      : `✅ ${escapeHtml(result.site)}: найдено ${result.found}, новых ${result.fresh}, подошло ${result.notified}` +
        (result.warning ? `\n   ⚠️ ${escapeHtml(result.warning)}` : ""),
  );
  if (note) lines.push("", note);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: mainMenu() });
}

/**
 * Достаёт конфиг поиска со страницы сайта. Нужен, когда режим включают из
 * карточки: форму при добавлении могли не выбирать, а страница с тех пор
 * могла и поменяться.
 */
async function detectSiteSearch(listUrl: string): Promise<SiteSearch | null> {
  try {
    const form = pickSearchForm(detectFilterForms(await fetchHtml(listUrl), listUrl));
    return form ? searchFromForm(form) : null;
  } catch {
    return null;
  }
}

function registerCallbacks(bot: Bot): void {
  /**
   * Отвечаем на callback уже после правки сообщения: иначе спиннер гаснет, а
   * провалившееся редактирование (устаревшее или удалённое сообщение) остаётся
   * только в логах, и для человека кнопка выглядит мёртвой.
   */
  /**
   * Снимает кнопки с уже отработавшего сообщения, чтобы по ним нельзя было
   * нажать второй раз. Старое сообщение Telegram править отказывается — но это
   * не повод обрывать начатое действие, поэтому ошибку глушим.
   */
  const hideButtons = async (ctx: Context): Promise<void> => {
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Сообщение слишком старое или уже без кнопок — и не нужно.
    }
  };

  const show = async (ctx: Context, text: string, keyboard: unknown) => {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reply_markup: keyboard as any,
      });
      await ctx.answerCallbackQuery();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Повторное нажатие той же кнопки: показывать нечего, но это и не ошибка.
      if (/message is not modified/i.test(message)) {
        await ctx.answerCallbackQuery();
        return;
      }
      await ctx.answerCallbackQuery({
        text: "Не удалось обновить сообщение — откройте меню заново: /menu",
        show_alert: true,
      });
    }
  };

  bot.callbackQuery("main", async (ctx) => {
    await clearState(ctx.from.id);
    await show(ctx, MAIN_MENU_TEXT, mainMenu());
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await clearState(ctx.from.id);
    await show(ctx, "Отменено.\n\n" + MAIN_MENU_TEXT, mainMenu());
  });

  /* ---------- сайты ---------- */

  bot.callbackQuery("sites", async (ctx) => {
    const { text, keyboard } = sitesMenu(await listSites());
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^sites_page:(\d+)$/, async (ctx) => {
    const { text, keyboard } = sitesMenu(await listSites(), Number(ctx.match[1]));
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery("site_add", async (ctx) => {
    await setState(ctx.from.id, STATES.siteUrl, {});
    await ctx.answerCallbackQuery();
    await ctx.reply(ASK_URL_TEXT);
  });

  /* ---------- готовые площадки ---------- */

  /** Адреса уже добавленных сайтов: по ним каталог помечает площадки галочкой. */
  const addedUrls = async (): Promise<string[]> => (await listSites()).map((site) => site.list_url);

  bot.callbackQuery("catalog", async (ctx) => {
    const { text, keyboard } = catalogMenu(catalogList(), await addedUrls());
    await show(ctx, text, keyboard);
  });

  /**
   * Площадку из каталога проверяем вживую, а не показываем обещание: правила
   * разбора стареют вместе с вёрсткой площадок, и человек должен увидеть
   * сегодняшние заголовки до того, как нажмёт «Добавить».
   */
  bot.callbackQuery(/^cat:([\w-]+)$/, async (ctx) => {
    const entry = catalogEntry(ctx.match[1]);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Такой площадки больше нет в списке" });
      return;
    }

    if ((await addedUrls()).some((url) => sameListUrl(url, entry.listUrl))) {
      await ctx.answerCallbackQuery({ text: CATALOG_ALREADY_ADDED, show_alert: true });
      return;
    }

    // Площадку домашнего сборщика живьём не проверить: с сервера бот увидит не
    // список, а проверку браузера, и человек решил бы, что она сломана.
    if (entry.viaLocal) {
      await ctx.answerCallbackQuery();
      const local = catalogLocalOnly(entry);
      await ctx.reply(local.text, {
        parse_mode: "HTML",
        reply_markup: local.keyboard,
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Проверяю площадку…" });

    const page = await loadPage(entry.listUrl);
    const items = page.html ? extractItems(page.html, entry.listUrl, entry.selectors) : [];

    if (items.length === 0) {
      const diagnosis = diagnosePage({
        html: page.html,
        status: page.status,
        url: entry.listUrl,
        itemsFound: 0,
      });
      const failed = catalogFailed(entry, diagnosis);
      await ctx.reply(failed.text, {
        parse_mode: "HTML",
        reply_markup: failed.keyboard,
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const found = catalogFound(entry, items, guessFields(page.html, entry.selectors.item));
    await ctx.reply(found.text, {
      parse_mode: "HTML",
      reply_markup: found.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.callbackQuery(/^cat_add:([\w-]+)$/, async (ctx) => {
    const entry = catalogEntry(ctx.match[1]);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Такой площадки больше нет в списке" });
      return;
    }

    if ((await addedUrls()).some((url) => sameListUrl(url, entry.listUrl))) {
      await ctx.answerCallbackQuery({ text: CATALOG_ALREADY_ADDED, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Добавляю…" });
    await hideButtons(ctx);
    await finishSiteAdd(ctx, {
      title: entry.title,
      url: entry.listUrl,
      selectors: entry.selectors,
      search: entry.search ?? { mode: "off" },
      viaLocal: entry.viaLocal,
    });
  });

  /* ---------- обучение по образцу ---------- */

  bot.callbackQuery("ex_ok", async (ctx) => {
    const { payload } = await getState(ctx.from.id);
    const selectors = payload.selectors as Selectors | undefined;
    if (!selectors) {
      await ctx.answerCallbackQuery({ text: "Пример устарел, пришлите его заново" });
      return;
    }

    await setState(ctx.from.id, STATES.siteName, payload);
    await ctx.answerCallbackQuery();
    await hideButtons(ctx);
    await ctx.reply("Как назвать этот сайт? Пришлите название или /skip, чтобы взять адрес.");
    if (payload.searchOffer) await sendSearchOffer(ctx);
  });

  bot.callbackQuery("ex_retry", async (ctx) => {
    const { payload } = await getState(ctx.from.id);
    await ctx.answerCallbackQuery();
    await hideButtons(ctx);
    await promptExample(ctx, payload);
  });

  bot.callbackQuery(/^site_pick:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match[1]);
    const { payload } = await getState(ctx.from.id);
    const candidates = (payload.candidates as Selectors[] | undefined) ?? [];
    const selectors = candidates[index];

    if (!selectors) {
      await ctx.answerCallbackQuery({ text: "Вариант устарел, начните заново" });
      return;
    }

    // Варианты предложены тестом уже существующего сайта: обновляем его строку.
    // Второй сайт на тот же адрес завёл бы свой список виденного и слал дубли.
    const siteId = payload.siteId;
    if (typeof siteId === "number") {
      await setSiteSelectors(siteId, selectors);
      await clearState(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "Готово, теперь читаю этот список" });
      const site = await getSite(siteId);
      if (site) {
        const { text, keyboard } = siteCard(site);
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
      }
      return;
    }

    // Payload переносим целиком: в нём может лежать уже выбранный режим поиска.
    await setState(ctx.from.id, STATES.siteName, { ...payload, selectors });
    await ctx.answerCallbackQuery();
    await ctx.reply("Как назвать этот сайт? Пришлите название или /skip, чтобы взять адрес.");
  });

  bot.callbackQuery("site_manual", async (ctx) => {
    const { payload } = await getState(ctx.from.id);
    await ctx.answerCallbackQuery();
    await promptManual(ctx, payload);
  });

  /** Состояния, в которых сайт ещё не создан и режим поиска можно выбрать кнопкой. */
  const ADD_STATES: string[] = [
    STATES.siteUrl,
    STATES.siteExample,
    STATES.siteManual,
    STATES.siteName,
  ];

  /**
   * Выбор режима поиска при добавлении сайта. Состояние диалога не трогаем:
   * кнопку могут нажать и до, и после выбора списка. А вот когда добавление уже
   * закончилось, обе кнопки одинаково бесполезны — запись в состояние ничего не
   * поменяет в самом сайте, поэтому отвечаем, где режим переключается на самом деле.
   */
  const chooseSearch = async (ctx: Context, on: boolean): Promise<void> => {
    const { state, payload } = await getState(ctx.from!.id);
    const offer = payload.searchOffer as SiteSearch | undefined;

    if (!state || !ADD_STATES.includes(state)) {
      await ctx.answerCallbackQuery({ text: "Настройка уже завершена" });
      await hideButtons(ctx);
      await ctx.reply(
        "Сайт уже добавлен — режим переключается кнопкой в его карточке: «🌐 Сайты» → сайт.",
      );
      return;
    }

    if (on && !offer) {
      await ctx.answerCallbackQuery({ text: "Страница устарела, пришлите ссылку заново" });
      return;
    }

    await setState(ctx.from!.id, state, { ...payload, search: on ? offer : { mode: "off" } });
    await ctx.answerCallbackQuery({
      text: on ? "Буду искать через поиск сайта" : "Буду читать весь список",
    });
    await hideButtons(ctx);
  };

  bot.callbackQuery("site_search_on", (ctx) => chooseSearch(ctx, true));
  bot.callbackQuery("site_search_off", (ctx) => chooseSearch(ctx, false));

  bot.callbackQuery(/^site:(\d+)$/, async (ctx) => {
    const site = await getSite(Number(ctx.match[1]));
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }
    const { text, keyboard } = siteCard(site);
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^site_toggle:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const site = await getSite(id);
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }
    await setSiteEnabled(id, !site.enabled);
    const updated = await getSite(id);
    const { text, keyboard } = siteCard(updated!);
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^site_search_toggle:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const site = await getSite(id);
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }

    let answered = false;
    if (site.search.mode === "query") {
      // Конфиг формы не стираем — обратно режим включится одной кнопкой, без загрузки страницы.
      await setSiteSearch(id, { ...site.search, mode: "off" });
    } else if (site.search.action && site.search.param) {
      await setSiteSearch(id, { ...site.search, mode: "query" });
    } else {
      // Форму при добавлении могли и не выбирать — тогда ищем её сейчас.
      await ctx.answerCallbackQuery({ text: "Ищу поиск на сайте…" });
      answered = true;
      const search = await detectSiteSearch(site.list_url);
      if (!search) {
        await ctx.reply("Поиска на этой странице я не нашёл — буду читать весь список.");
        return;
      }
      await setSiteSearch(id, search);
    }

    const { text, keyboard } = siteCard((await getSite(id))!);
    // Второй ответ на тот же callback Telegram не примет, поэтому шлём карточку отдельно.
    if (answered) await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
    else await show(ctx, text, keyboard);

    // Относительные ссылки в выдаче поиска и на странице списка достраиваются от
    // разных адресов, поэтому часть позиций после смены режима бот увидит впервые.
    await ctx.reply("Учтите: после смены режима часть уже виденных тендеров может прийти ещё раз.");
  });

  /**
   * Переключает способ обхода площадки: читает её сервер или программа на
   * компьютере владельца.
   *
   * Кнопка нужна потому, что площадка может начать показывать проверку браузера
   * уже после добавления — и наоборот, перестать. Без неё починить такую
   * площадку было бы нечем: повторное добавление из каталога бот отсекает как
   * дубль, и строка навсегда осталась бы с прежним способом обхода — крон ходил
   * бы на неё каждый прогон и каждый раз писал ошибку в карточку.
   */
  bot.callbackQuery(/^site_local:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const site = await getSite(id);
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }

    const next = !site.via_local;
    await setSiteViaLocal(id, next);
    await ctx.answerCallbackQuery();

    const { text, keyboard } = siteCard((await getSite(id))!);
    await show(ctx, text, keyboard);
    await ctx.reply(viaLocalSwitchedText(site.title, next), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  /**
   * Правила разбора за отдельной кнопкой. На главном пути их не показываем —
   * строка вида `div.card > a` человеку ничего не говорит, — но при разборе
   * сложной площадки без них не обойтись.
   */
  bot.callbackQuery(/^site_raw:(\d+)$/, async (ctx) => {
    const site = await getSite(Number(ctx.match[1]));
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }
    const { text, keyboard } = advancedDetails(site);
    await show(ctx, text, keyboard);
  });

  /** Переписать правила у существующего сайта — тоже путь для продвинутых. */
  bot.callbackQuery(/^site_manual_edit:(\d+)$/, async (ctx) => {
    const site = await getSite(Number(ctx.match[1]));
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }
    await ctx.answerCallbackQuery();
    await promptManual(ctx, { url: site.list_url, siteId: site.id });
  });

  bot.callbackQuery(/^site_del:(\d+)$/, async (ctx) => {
    await deleteSite(Number(ctx.match[1]));
    const { text, keyboard } = sitesMenu(await listSites());
    await show(ctx, `🗑 Сайт удалён.\n\n${text}`, keyboard);
  });

  /**
   * Проверка площадки по кнопке. Показываем то же, что при добавлении: сколько
   * позиций и что бот из них понял. Если не читается — причину человеческими
   * словами и предложение выбрать список заново, а не строку правил.
   */
  bot.callbackQuery(/^site_test:(\d+)$/, async (ctx) => {
    const site = await getSite(Number(ctx.match[1]));
    if (!site) {
      await ctx.answerCallbackQuery({ text: "Сайт не найден" });
      return;
    }

    // Такую площадку бот сам не открывает: список ему показывают только с
    // компьютера владельца. Пробовать — значит показать человеку отказ площадки
    // и оставить его думать, что всё сломалось.
    if (site.via_local) {
      await ctx.answerCallbackQuery();
      await ctx.reply(VIA_LOCAL_TEST_TEXT, { parse_mode: "HTML" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Проверяю…" });

    // Проверяем ровно тот адрес, который читает крон: в режиме поиска это
    // выдача формы, и её страница может выглядеть иначе, чем список.
    const testUrl = targetUrls(site, await listKeywords())[0] ?? site.list_url;
    const page = await loadPage(testUrl);
    const items = page.html ? extractItems(page.html, testUrl, site.selectors) : [];

    if (items.length > 0) {
      await ctx.reply(testReport(site, testUrl, items, guessFields(page.html, site.selectors.item)), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const diagnosis = diagnosePage({
      html: page.html,
      status: page.status,
      url: testUrl,
      itemsFound: 0,
    });
    await ctx.reply(testFailedReport(site, testUrl, diagnosis), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    // Страница могла просто перерисоваться — тогда предлагаем выбрать список
    // заново по заголовкам, это человек может сделать глазами.
    const candidates = page.html ? detectSelectors(page.html, testUrl) : [];
    if (candidates.length === 0) return;

    const { state } = await getState(ctx.from.id);
    // Чужой незаконченный диалог не перебиваем: иначе присланные следом
    // ключевые слова уйдут в разбор ссылки и потеряются.
    const busy = state !== null && state !== STATES.siteUrl;
    if (!busy) {
      await setState(ctx.from.id, STATES.siteUrl, {
        url: site.list_url,
        siteId: site.id,
        candidates: candidates.map((c) => c.selectors),
      });
    }

    const { text, keyboard } = candidatesMessage(candidates);
    await ctx.reply(
      busy
        ? `Кое-что похожее на список я всё-таки вижу, но у вас не закончен другой разговор — завершите его или /cancel:\n\n${text}`
        : `Похоже, список на странице переехал. Выберите, что теперь читать:\n\n${text}`,
      { parse_mode: "HTML", reply_markup: busy ? undefined : keyboard },
    );
  });

  /* ---------- ключевые слова ---------- */

  bot.callbackQuery("kw", async (ctx) => {
    const { text, keyboard } = keywordsMenu(await listKeywords());
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^kw_page:(\d+)$/, async (ctx) => {
    const { text, keyboard } = keywordsMenu(await listKeywords(), Number(ctx.match[1]));
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery("kw_add", async (ctx) => {
    await setState(ctx.from.id, STATES.keywordAdd, {});
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "Пришлите ключевые слова, по одному в строке:",
        "",
        "<code>ремонт</code> — точное слово",
        "<code>ремонт*</code> — по началу слова (ремонта, ремонтные)",
        "<code>поставка мебели</code> — фраза целиком",
        "<code>-аварийный</code> — минус-слово, отменяет совпадение",
        "",
        "/cancel — отмена",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery(/^kw_del:(\d+)$/, async (ctx) => {
    await deleteKeyword(Number(ctx.match[1]));
    const { text, keyboard } = keywordsMenu(await listKeywords());
    await show(ctx, text, keyboard);
  });

  /* ---------- админы ---------- */

  const admins = async (offset = 0) =>
    adminsMenu(await listAdmins(), env.ownerIds, offset, await countActiveInvites());

  bot.callbackQuery("admins", async (ctx) => {
    const { text, keyboard } = await admins();
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^admins_page:(\d+)$/, async (ctx) => {
    const { text, keyboard } = await admins(Number(ctx.match[1]));
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery("admin_add", async (ctx) => {
    await setState(ctx.from.id, STATES.adminAdd, {});
    await ctx.answerCallbackQuery();
    await ctx.reply("Пришлите Telegram ID нового админа (узнать: @userinfobot).\n\n/cancel — отмена");
  });

  /** Кого удаляем: подпись строки берём из того же списка, что и меню. */
  const adminLabel = (
    rows: { tg_id: number; username: string | null }[],
    tgId: number,
  ): string => {
    const found = rows.find((row) => row.tg_id === tgId);
    return found?.username ? `@${found.username}` : String(tgId);
  };

  /**
   * Перед удалением спрашиваем подтверждение: промах по соседней строке
   * мгновенно и без отмены отбирает доступ — в том числе у владельца, если
   * OWNER_TELEGRAM_ID не задан и он лежит в admins обычной строкой.
   */
  bot.callbackQuery(/^admin_del:(\d+)$/, async (ctx) => {
    const target = Number(ctx.match[1]);
    const rows = await listAdmins();
    const error = adminDeletionError(
      target,
      ctx.from.id,
      rows.map((row) => row.tg_id),
      env.ownerIds,
    );
    if (error) {
      await ctx.answerCallbackQuery({ text: error, show_alert: true });
      return;
    }

    const { text, keyboard } = adminDeleteConfirm(target, adminLabel(rows, target));
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery(/^admin_del_yes:(\d+)$/, async (ctx) => {
    const target = Number(ctx.match[1]);
    // Проверяем повторно: между показом подтверждения и нажатием список админов
    // мог измениться — например, второго админа успел удалить кто-то ещё.
    const error = adminDeletionError(
      target,
      ctx.from.id,
      (await listAdmins()).map((row) => row.tg_id),
      env.ownerIds,
    );
    if (error) {
      await ctx.answerCallbackQuery({ text: error, show_alert: true });
      return;
    }

    await removeAdmin(target);
    const { text, keyboard } = await admins();
    await show(ctx, `🗑 Админ удалён, его невыданные ссылки погашены.\n\n${text}`, keyboard);
  });

  bot.callbackQuery("admin_invite", async (ctx) => {
    // Кнопку могли нажать поверх незаконченного «➕ Добавить админа»: иначе
    // следующее сообщение — хоть бы и сама ссылка — уйдёт в разбор Telegram ID.
    await clearState(ctx.from.id);

    const expiresAt = inviteExpiresAt(new Date());
    const token = newInviteToken();
    // Ссылку собираем до записи: на кривом имени бота inviteLink бросает
    // исключение, и незачем оставлять в базе живой токен, которого никто не видел.
    const link = inviteLink(ctx.me.username, token);
    await createInvite(token, ctx.from.id, expiresAt);

    // Отдельным сообщением: меню перерисовывается, а ссылку нужно найти в чате позже.
    await ctx.reply(formatInviteMessage(link, expiresAt), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    const { text, keyboard } = await admins();
    await show(ctx, text, keyboard);
  });

  bot.callbackQuery("admin_revoke", async (ctx) => {
    await clearState(ctx.from.id);

    // Считаем чужие ссылки до отзыва: кнопка гасит все сразу, и нажавший
    // должен видеть, что оборвал и уже разосланное кем-то приглашение.
    const byOthers = (await listActiveInvites()).filter(
      (invite) => invite.created_by !== ctx.from.id,
    ).length;
    const revoked = await revokeInvites();

    const { text, keyboard } = await admins();
    await show(ctx, `${revokeNote(revoked, byOthers)}\n\n${text}`, keyboard);
  });

  /* ---------- прочее ---------- */

  bot.callbackQuery("stats", async (ctx) => {
    const data = await stats();
    const text = [
      "<b>Статистика</b>",
      `Сайтов: ${data.sites}`,
      `Ключевых слов: ${data.keywords}`,
      `Всего позиций обработано: ${data.seen}`,
      `Из них подошло: ${data.matched}`,
      `За последние сутки: ${data.last24h}`,
    ].join("\n");
    await show(ctx, text, mainMenu());
  });

  bot.callbackQuery("check", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Запускаю проверку…" });
    await replyWithCheckResults(ctx);
  });
}
