import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

/**
 * Почему со страницы не удалось получить список тендеров.
 * Отдельный модуль нужен, чтобы человеку в Telegram уходило объяснение
 * («сайт пускает только своих»), а не техническая правда вроде «403».
 */
export type PageDiagnosis =
  | { kind: "ok" }
  | { kind: "login_required" }
  | { kind: "captcha" }
  | { kind: "blocked" }
  | { kind: "javascript" }
  | { kind: "not_found" }
  | { kind: "empty_list" }
  | { kind: "site_down" }
  | { kind: "unknown" };

export type DiagnosisInput = {
  html: string;
  /** Код ответа сайта, если он известен. */
  status?: number;
  /** Адрес, с которого пришёл html: после перехода на страницу входа он тоже подсказка. */
  url: string;
  /** Сколько позиций удалось вытащить со страницы. */
  itemsFound: number;
};

/* ---------- признаки ---------- */

/** Слова, которыми страница входа представляется человеку. */
const LOGIN_WORDS = [
  "войти",
  "вход",
  "авторизац",
  "логин",
  "личный кабинет",
  "sign in",
  "signin",
  "log in",
  "login",
];

/**
 * Слова, которым верим только внутри самой формы с паролем. По странице целиком
 * их искать нельзя: «пароль» упоминается в любой инструкции для поставщика,
 * а рядом с полем пароля это уже подпись поля, то есть настоящий признак входа.
 */
const LOGIN_FORM_WORDS = [...LOGIN_WORDS, "парол", "пользовател", "password", "user name"];

/** Адреса, на которые сайт уводит гостя вместо запрошенного раздела. */
const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|authorize|account\/login|user\/login)\b/i;

/** Поле, куда вводят имя пользователя: стоит рядом с паролем на любой форме входа. */
const IDENTITY_FIELD_RE = /(user|login|email|mail|account|логин|почт|пользоват)/i;

/**
 * Виджеты проверки «вы не робот». Ищем их именно в дереве страницы, а не в
 * тексте html: иначе за капчу сойдёт и закомментированный кусок разметки.
 */
const CAPTCHA_WIDGET_SELECTOR = [
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "[data-sitekey]",
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
].join(", ");

/** Слова проверки на робота — на случай, если виджет дорисовывается уже в браузере. */
const CAPTCHA_TEXT_MARKERS = [
  "i'm not a robot",
  "i am not a robot",
  "не робот",
  "подтвердите, что вы человек",
];

/**
 * Технические следы антибот-защит. Таких строк не бывает в обычной вёрстке,
 * поэтому их можно искать прямо в html — даже на большой странице это защита.
 */
const BLOCK_INFRA_MARKERS = [
  "cdn-cgi/challenge-platform",
  "cf-browser-verification",
  "incapsula",
  "error code: 1020",
  "cloudflare ray id",
  "ddos protection by",
];

/**
 * Фразы с заглушек защиты. Их проверяем только по видимому тексту и только на
 * короткой странице: те же слова попадаются в подписях внутри скриптов и в
 * подвале живого списка, и из-за этого рабочая площадка объявлялась закрытой.
 */
const BLOCK_TEXT_MARKERS = [
  "attention required",
  "checking your browser",
  "just a moment",
  "access denied",
  "you don't have permission to access",
  "request unsuccessful",
  "доступ запрещён",
  "доступ запрещен",
  "в доступе отказано",
  "доступ к сайту заблокирован",
];

/** Идентификатор блокировки Akamai: «Reference #18.abcd1234.…». */
const AKAMAI_REFERENCE_RE = /reference\s*#\d+\.[0-9a-f]+/i;

/** Тексты «страницы нет» — именно про страницу, а не про пустой результат поиска. */
const NOT_FOUND_MARKERS = [
  "страница не найдена",
  "страница не существует",
  "такой страницы нет",
  "запрашиваемая страница",
  "page not found",
  "404 not found",
  "not found",
];

/** Тексты «искали, но ничего нет» — страница при этом рабочая. */
const EMPTY_LIST_MARKERS = [
  "ничего не найдено",
  "ничего не нашлось",
  "не найдено ни одного",
  "результатов не найдено",
  "нет результатов",
  "нет данных",
  "данные отсутствуют",
  "записи отсутствуют",
  "список пуст",
  "по вашему запросу ничего",
  "no results",
  "nothing found",
  "no records",
];

/** Скрипты фреймворков, которые рисуют список уже в браузере. */
const FRAMEWORK_SCRIPT_RE =
  /<script[^>]*(primefaces|jsf\.js|javax\.faces\.resource|react|vue|angular|nuxt|__NEXT_DATA__|_next\/static)/i;

/** Оболочка, в которую приложение вставляет содержимое уже в браузере. */
const APP_SHELL_SELECTOR = "#root, #app, [data-reactroot], [ng-app]";

/** Осмысленного текста меньше — страница пустая, обсуждать на ней нечего. */
const MIN_CONTENT_TEXT = 40;

/** Столько текста ещё считается пустой заготовкой приложения, а не готовым списком. */
const EMPTY_SHELL_TEXT = 200;

/** Ссылка с такой подписью что-то значит: из них складывается список объявлений,
 * а «Войти», «Наверх», «RSS» — нет. */
const MEANINGFUL_LINK_TEXT = 15;

/** Столько содержательных ссылок — это уже перечень. Страница с ними не может
 * быть ни формой входа, ни проверкой на робота, ни заглушкой защиты. */
const CONTENT_LINKS = 5;

/** Столько текста вне блока — странице есть что показать и кроме него. */
const CONTENT_TEXT = 400;

/** Заглушка защиты почти не содержит текста; всё длиннее — обычная страница. */
const STUB_TEXT = 600;

/** Видимый текст узла одной строкой. Принимаем что угодно с `text()` — так
 * не приходится подстраивать сигнатуру под типы cheerio на каждом вызове. */
function plainText(node: { text(): string }): string {
  return node.text().replace(/\s+/g, " ").trim();
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Что мы уже знаем о странице: считаем один раз и передаём проверкам. */
type PageFacts = {
  $: cheerio.CheerioAPI;
  /** Исходный html: нужен там, где важны сами теги, а не текст. */
  html: string;
  bodyText: string;
  /** Видимый человеку текст в нижнем регистре: заголовок вкладки плюс страница. */
  visibleLower: string;
  /** Страница — пара строк без перечня: только на такой верят словам-заглушкам. */
  stub: boolean;
};

function meaningfulLinks($: cheerio.CheerioAPI, scope: cheerio.Cheerio<AnyNode>): number {
  return scope
    .find("a[href]")
    .toArray()
    .filter((element) => plainText($(element)).length >= MEANINGFUL_LINK_TEXT).length;
}

/**
 * Сколько содержательного останется на странице, если вычесть из неё блок.
 * Это главный вопрос ко всем «страшным» признакам: форма входа, капча и пустая
 * оболочка приложения бывают и сбоку от живого списка, и тогда они ничего не
 * значат. Виноваты они только если, кроме них, на странице ничего нет.
 */
function contentOutside(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<AnyNode>,
): { textLength: number; links: number } {
  const body = $("body");
  return {
    textLength: Math.max(0, plainText(body).length - plainText(scope).length),
    links: Math.max(0, meaningfulLinks($, body) - meaningfulLinks($, scope)),
  };
}

/** Кроме этого блока на странице ничего нет — значит, он и есть вся страница. */
function isOnlyContent($: cheerio.CheerioAPI, scope: cheerio.Cheerio<AnyNode>): boolean {
  const outside = contentOutside($, scope);
  return outside.links < CONTENT_LINKS && outside.textLength < CONTENT_TEXT;
}

/** Страница-заглушка: пара строк текста и ни одного перечня ссылок. */
function isStubPage($: cheerio.CheerioAPI, bodyText: string): boolean {
  return bodyText.length < STUB_TEXT && meaningfulLinks($, $("body")) < CONTENT_LINKS;
}

/**
 * Страница входа — это форма с паролем, которая занимает собой всю страницу.
 * Одного поля пароля мало: форма входа висит в шапке или в боковой колонке у
 * множества живых площадок, и обычный список из-за неё не должен объявляться
 * закрытым. Поэтому нужны два условия: признак именно входа (поле логина рядом,
 * подпись поля, слова про вход, адрес вида /login) и отсутствие содержимого
 * вокруг формы.
 */
function looksLoginPage(page: PageFacts, url: string): boolean {
  const { $, visibleLower, bodyText } = page;
  const password = $('input[type="password"]').first();
  if (password.length === 0) return false;

  const form = password.closest("form");
  // Без формы берём ближайший контейнер поля: по нему тоже видно, есть ли
  // рядом что-то кроме входа.
  const scope = form.length > 0 ? form : password.parent();
  if (scope.length === 0) return false;

  const hasIdentityField = scope
    .find("input")
    .toArray()
    .some((element) => {
      const attribs = element.attribs ?? {};
      const type = (attribs.type ?? "text").toLowerCase();
      if (type === "password" || type === "hidden" || type === "submit") return false;
      return IDENTITY_FIELD_RE.test(
        `${attribs.name ?? ""} ${attribs.id ?? ""} ${attribs.placeholder ?? ""} ${attribs.autocomplete ?? ""}`,
      );
    });

  // Имена полей бывают любые («usr», «pwd»), а подпись рядом с полем человек
  // читает всегда — по ней вход узнаётся даже с непривычными атрибутами.
  const hasIdentityLabel = IDENTITY_FIELD_RE.test(plainText(scope.find("label")));

  const scopeText = plainText(scope).toLowerCase();
  const hasLoginWords =
    includesAny(scopeText, LOGIN_FORM_WORDS) || includesAny(visibleLower, LOGIN_WORDS);

  const looksLikeLogin =
    hasIdentityField || hasIdentityLabel || hasLoginWords || LOGIN_URL_RE.test(url);
  if (!looksLikeLogin) return false;

  // Форма без обёртки прямо в body: вычитать её из страницы бессмысленно,
  // поэтому смотрим на страницу целиком — она должна быть короткой.
  if (scope.is("body")) return isStubPage($, bodyText);

  return isOnlyContent($, scope);
}

/**
 * Проверка «вы не робот» вместо списка. Виджет капчи часто висит на форме
 * обратной связи в подвале обычной страницы, поэтому диагноз ставим только
 * когда, кроме этой проверки, на странице ничего нет.
 */
function looksCaptchaPage(page: PageFacts): boolean {
  const { $, visibleLower, stub } = page;
  const widget = $(CAPTCHA_WIDGET_SELECTOR);
  if (widget.length > 0 && isOnlyContent($, widget)) return true;
  // Виджет мог не дорисоваться, но короткая страница целиком про проверку
  // узнаётся и по словам.
  return stub && includesAny(visibleLower, CAPTCHA_TEXT_MARKERS);
}

/**
 * Список рисуется уже в браузере. Признаём это только когда списка на странице
 * действительно нет (иначе виноваты не скрипты, а неподошедшие селекторы) и при
 * этом видно, чем страница собирается заполняться: пустой оболочкой приложения,
 * вокруг которой пусто, или скриптом фреймворка.
 */
function rendersInBrowser(page: PageFacts): boolean {
  if (!page.stub) return false;
  return hasEmptyAppShell(page) || FRAMEWORK_SCRIPT_RE.test(page.html);
}

/**
 * Пустая оболочка приложения. Маленький `#app` бывает и у виджета поиска рядом
 * с обычным списком, поэтому мало найти контейнер — нужно, чтобы вне него на
 * странице ничего не было.
 */
function hasEmptyAppShell({ $ }: PageFacts): boolean {
  const shells = $(APP_SHELL_SELECTOR);
  if (shells.length === 0) return false;
  if (plainText(shells).length >= EMPTY_SHELL_TEXT) return false;
  return isOnlyContent($, shells);
}

/**
 * Определяет причину, по которой список не собрался. Порядок проверок —
 * от самой определённой причины к самой общей: сперва то, что сайт говорит
 * прямо (форма входа, проверка на робота, технические следы защиты, надписи
 * «страницы нет» и «ничего не найдено»), и только потом догадки по виду
 * страницы. Прямая надпись всегда точнее вывода по разметке, иначе общая
 * причина перебивает точную и человек получает неверный совет.
 */
export function diagnosePage(input: DiagnosisInput): PageDiagnosis {
  const { html, status, url, itemsFound } = input;

  // Позиции есть — значит страница отдалась как надо. Ссылка «Войти» в шапке
  // или счётчик с капчей в подвале в этом случае ничего не меняют.
  if (itemsFound > 0) return { kind: "ok" };

  const $ = cheerio.load(html);
  // Код и оформление — не текст страницы. Без этого строка «Access denied» из
  // подписей внутри <script> читалась бы как заглушка защиты.
  $("script, style, noscript, template").remove();

  const lowerHtml = html.toLowerCase();
  const bodyText = plainText($("body"));
  // Заголовок вкладки человек тоже видит, и заглушки защит часто говорят всё
  // именно в нём («Just a moment…»), оставляя в теле одну строку ожидания.
  const visibleLower = `${plainText($("title"))} ${bodyText}`.toLowerCase();

  const page: PageFacts = {
    $,
    html,
    bodyText,
    visibleLower,
    stub: isStubPage($, bodyText),
  };

  // 401 — прямой ответ сайта «сначала представьтесь».
  if (status === 401) return { kind: "login_required" };
  if (looksLoginPage(page, url)) return { kind: "login_required" };

  if (looksCaptchaPage(page)) return { kind: "captcha" };

  if (status === 403 || status === 429) return { kind: "blocked" };
  if (includesAny(lowerHtml, BLOCK_INFRA_MARKERS)) return { kind: "blocked" };

  // Код 404 сайт называет сам, и это точнее любых догадок про скрипты.
  if (status === 404 || status === 410) return { kind: "not_found" };
  if (includesAny(visibleLower, NOT_FOUND_MARKERS)) return { kind: "not_found" };

  // «Ничего не найдено» — тоже слова самого сайта, поэтому идут раньше вывода
  // «рисуется в браузере»: иначе пустому отбору на портале с фреймворком мы бы
  // навсегда отключили повторные проверки.
  const statusIsFine = status === undefined || (status >= 200 && status < 300);
  if (statusIsFine && bodyText.length >= MIN_CONTENT_TEXT && includesAny(visibleLower, EMPTY_LIST_MARKERS)) {
    return { kind: "empty_list" };
  }

  if (rendersInBrowser(page)) return { kind: "javascript" };

  // Обиходные фразы вроде «just a moment» читаем в последнюю очередь и только
  // на короткой странице: на живом списке такие слова ничего не значат.
  if (page.stub && includesAny(visibleLower, BLOCK_TEXT_MARKERS)) return { kind: "blocked" };
  if (page.stub && AKAMAI_REFERENCE_RE.test(bodyText)) return { kind: "blocked" };

  // Сайт ответил своей ошибкой или не ответил вовсе. Это поломка площадки, а не
  // беда ссылки, поэтому человеку нельзя говорить «страница открылась» и просить
  // прислать другой адрес — надо просто зайти позже.
  if (status !== undefined && status >= 500) return { kind: "site_down" };
  if (html.trim().length === 0) return { kind: "site_down" };

  return { kind: "unknown" };
}

/* ---------- объяснение для человека ---------- */

/**
 * Экранируем и кавычку тоже: адрес уходит в href, и одна кавычка внутри него
 * порвала бы разметку — Telegram тогда отклонит сообщение целиком.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Ссылку показываем только для http(s): заглушки вроде `javascript:void(0)`
 * Telegram не принимает и отвергает всё сообщение, а без строки со ссылкой
 * объяснение всё равно дойдёт.
 */
function linkLine(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return `<a href="${escapeHtml(url)}">Открыть ссылку в браузере</a>`;
}

type Explanation = { icon: string; headline: string; why: string; step: string; canRetry: boolean };

/**
 * Тексты пишем так, как объяснили бы знакомому: что случилось и что делать
 * дальше. Никаких кодов ответа и названий защит — человеку они не помогают,
 * а только пугают. И никакой вины на человеке там, где сломался сайт.
 */
const EXPLANATIONS: Record<PageDiagnosis["kind"], Explanation> = {
  ok: {
    icon: "✅",
    headline: "Страница читается",
    why: "Объявления с неё видны, можно следить за новыми.",
    step: "Ничего делать не нужно.",
    canRetry: true,
  },
  login_required: {
    icon: "🔒",
    headline: "Сайт показывает тендеры только своим пользователям",
    why: "Всем остальным он отдаёт страницу с полями для имени и пароля, поэтому объявлений на ней просто нет.",
    step: "Пришлите адрес раздела, который открывается без входа, или давайте добавим другую площадку — подскажу, какие открыты для всех.",
    canRetry: false,
  },
  captcha: {
    icon: "🧩",
    headline: "Сайт просит подтвердить, что страницу открывает человек",
    why: "Вместо списка он показывает проверку с картинкой, а пройти её вместо вас я не могу.",
    step: "Попробуйте прислать другой раздел этого сайта или добавьте площадку, которая такую проверку не показывает.",
    canRetry: false,
  },
  blocked: {
    icon: "⛔",
    headline: "Сайт не пускает меня на эту страницу",
    why: "Вас он пустит, а мне вместо объявлений показывает предупреждение — так настроено на самой площадке.",
    step: "Иногда выручает адрес другого раздела того же сайта, но чаще проще взять другую площадку.",
    canRetry: false,
  },
  javascript: {
    icon: "⏳",
    headline: "Тендеры подгружаются уже после открытия страницы",
    why: "Мне достаётся только пустая заготовка: готового перечня объявлений в ней ещё нет.",
    step: "Пришлите ссылку на страницу, где список виден сразу, — обычно это версия «для печати», выгрузка в файл или раздел «Все объявления».",
    canRetry: false,
  },
  not_found: {
    icon: "🔎",
    headline: "Такой страницы на сайте нет",
    why: "Сайт отвечает, что страница не найдена: возможно, адрес поменялся или в нём потерялся кусочек.",
    step: "Откройте нужный раздел на сайте и пришлите адрес из адресной строки целиком.",
    canRetry: false,
  },
  empty_list: {
    icon: "📭",
    headline: "Страница открылась, но объявлений в ней сейчас нет",
    why: "Сайт отвечает, что по этим условиям ничего не нашлось — так бывает, когда отбор слишком узкий или новых тендеров пока не публиковали.",
    step: "Можно подождать и проверить позже или прислать адрес раздела без дополнительных условий отбора.",
    canRetry: true,
  },
  site_down: {
    icon: "⏱️",
    headline: "Сайт сейчас не отвечает",
    why: "Так бывает, когда у площадки неполадки или на ней идут работы. С вашей ссылкой это не связано — она в порядке.",
    step: "Делать ничего не нужно: я проверю ещё раз позже и сообщу, когда объявления снова будут видны.",
    canRetry: true,
  },
  unknown: {
    icon: "🤔",
    headline: "Не получилось узнать список на этой странице",
    why: "Страница открылась, но привычного перечня объявлений в ней не видно.",
    step: "Пришлите ссылку на раздел, где тендеры идут списком друг под другом, или попробуйте ещё раз чуть позже.",
    canRetry: true,
  },
};

/**
 * Готовое сообщение для Telegram: причина обычными словами, понятный
 * следующий шаг и ссылка, чтобы человек мог глянуть страницу сам.
 */
export function explainDiagnosis(
  d: PageDiagnosis,
  url: string,
): { text: string; canRetry: boolean } {
  const explanation = EXPLANATIONS[d.kind];
  const lines = [
    `${explanation.icon} <b>${explanation.headline}</b>`,
    explanation.why,
    "",
    explanation.step,
  ];

  const link = linkLine(url);
  if (link) lines.push("", link);

  return { text: lines.join("\n"), canRetry: explanation.canRetry };
}
