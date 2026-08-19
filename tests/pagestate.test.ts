import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosePage, explainDiagnosis, type PageDiagnosis } from "../src/lib/pagestate.ts";

const LIST_URL = "https://www.tenders.kg/Announcements_list.php?f=all";

/** Так выглядит tenders.kg для гостя: весь сайт закрыт формой входа. */
const loginPageHtml = `
<html><head><title>Вход в систему</title></head><body>
  <div class="login-wrapper">
    <h1>Авторизация</h1>
    <form action="/login.php" method="post">
      <label for="u">Имя пользователя</label>
      <input id="u" type="text" name="username">
      <label for="p">Пароль</label>
      <input id="p" type="password" name="password">
      <button type="submit">Войти</button>
    </form>
    <a href="/register.php">Зарегистрироваться на площадке</a>
  </div>
</body></html>`;

/** Нормальный список объявлений, у которого в шапке есть ссылка «Войти». */
const listWithLoginLinkHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <header class="site-header">
    <a href="/">Главная страница площадки</a>
    <a href="/login.php">Войти</a>
  </header>
  <main>
    ${[1, 2, 3, 4, 5, 6, 7, 8]
      .map(
        (n) => `
    <div class="tender-card">
      <a class="tender-title" href="/tender/${n}">Ремонт кровли школы №${n} в городе Ош</a>
      <span class="tender-date">0${n}.09.2026</span>
    </div>`,
      )
      .join("")}
  </main>
</body></html>`;

/** Строки живого списка: у каждой ссылки осмысленная подпись, как на площадке. */
function tenderRows(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `
    <div class="tender-card">
      <a class="tender-title" href="/tender/${i + 1}">Ремонт кровли школы №${i + 1} в городе Ош</a>
      <span class="tender-date">0${(i % 9) + 1}.09.2026</span>
    </div>`,
  ).join("");
}

/** Живой список, у которого форма входа висит в шапке: так устроены многие площадки. */
const listWithLoginFormHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <header class="site-header">
    <form action="/auth" method="post">
      <input type="text" name="username" placeholder="Логин">
      <input type="password" name="password" placeholder="Пароль">
      <button type="submit">Войти</button>
    </form>
  </header>
  <main>${tenderRows(12)}</main>
</body></html>`;

/** Живой список, где ошибки для человека заранее описаны внутри скрипта. */
const listWithScriptMessagesHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <script>var MSG = { denied: "Access denied", wait: "Just a moment", forbidden: "Доступ запрещён" };</script>
  <main>${tenderRows(12)}</main>
</body></html>`;

/** Живой список с обычной оговоркой в подвале про документы для гостей. */
const listWithRestrictedFooterHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <main>${tenderRows(6)}</main>
  <footer>Раздел «Документы»: доступ ограничен для незарегистрированных посетителей площадки.</footer>
</body></html>`;

/** Живой список, у которого в подвале форма обратной связи с проверкой на робота. */
const listWithFooterCaptchaHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <main>${tenderRows(12)}</main>
  <footer>
    <form action="/feedback"><textarea name="msg"></textarea>
      <div class="g-recaptcha" data-sitekey="6LcAbCdEfGhIjKlMnOpQrStUvWxYz"></div>
    </form>
  </footer>
</body></html>`;

/** Живой список, рядом с которым маленький виджет поиска с идентификатором приложения. */
const listWithSearchWidgetHtml = `
<html><head><title>Объявления о закупках</title></head><body>
  <div id="app"><input placeholder="Поиск"></div>
  <main>${tenderRows(12)}</main>
</body></html>`;

/** Заготовка приложения, которая честно пишет, что список ещё грузится. */
const spaLoadingHtml = `
<html><head><title>Портал закупок</title></head><body>
  <div id="root">Just a moment, loading tenders…</div>
  <script src="/static/js/main.9f2a1c.js"></script>
</body></html>`;

/** Портал на фреймворке, который сам сообщил: по отбору ничего нет. */
const vueEmptyResultHtml = `
<html><head><title>Результаты</title></head><body>
  <div id="app">
    <h1>Результаты</h1>
    <p>По вашему запросу ничего не найдено.</p>
  </div>
  <script src="/js/vue.min.js"></script>
</body></html>`;

/** Страница входа с непривычными именами полей: узнать её можно только по подписям. */
const unusualLoginPageHtml = `
<html><head><title>Кабинет</title></head><body>
  <form action="/enter.php" method="post">
    <label for="usr">Имя пользователя</label>
    <input id="usr" type="text" name="usr">
    <label for="pwd">Пароль</label>
    <input id="pwd" type="password" name="pwd">
    <button type="submit">Отправить</button>
  </form>
</body></html>`;

const recaptchaHtml = `
<html><head><title>Проверка</title></head><body>
  <h1>Подтвердите, что вы не робот</h1>
  <div class="g-recaptcha" data-sitekey="6LcAbCdEfGhIjKlMnOpQrStUvWxYz"></div>
</body></html>`;

/** Turnstile-страница Cloudflare: признак капчи точнее общей заглушки. */
const turnstileHtml = `
<html><head><title>Just a moment...</title></head><body>
  <div class="cf-turnstile" data-sitekey="0x4AAAAAAADnPIDROrmt1Wwj"></div>
</body></html>`;

/** Та же защита, но без виджета: одна заглушка «подождите». */
const cloudflareHtml = `
<html><head><title>Just a moment...</title></head><body>
  <div id="cf-wrapper"><h1>Please wait while we verify your request</h1></div>
</body></html>`;

const spaHtml = `
<html><head><title>Портал закупок</title></head><body>
  <div id="root"></div>
  <script src="/static/js/main.9f2a1c.js"></script>
</body></html>`;

const primefacesHtml = `
<html><head><title>Реестр объявлений</title></head><body>
  <a href="/">Главная</a>
  <form id="mainForm" method="post">
    <div id="mainForm:tenderTable" class="ui-datatable"></div>
  </form>
  <script src="/javax.faces.resource/primefaces.js.xhtml?ln=primefaces"></script>
</body></html>`;

const emptyResultHtml = `
<html><head><title>Результаты поиска</title></head><body>
  <header><a href="/">Электронная площадка государственных закупок</a></header>
  <main>
    <h1>Результаты поиска по объявлениям</h1>
    <p>По вашему запросу ничего не найдено. Измените условия отбора и попробуйте снова.</p>
  </main>
</body></html>`;

const notFoundHtml = `
<html><head><title>Ошибка</title></head><body>
  <h1>Страница не найдена</h1>
  <p>Возможно, она была удалена или адрес введён неверно.</p>
</body></html>`;

/** Обычная содержательная страница, на которой просто нет списка тендеров. */
const articleHtml = `
<html><head><title>Новости площадки</title></head><body>
  <article>
    <h1>Как участвовать в электронных торгах</h1>
    <p>Пошаговая инструкция для новых поставщиков, желающих участвовать в закупках.</p>
    <a href="/news/1">Изменения в правилах проведения торгов с сентября</a>
    <a href="/news/2">Итоги работы электронной площадки за полугодие</a>
    <a href="/news/3">Как подготовить документы для участия в закупке</a>
    <a href="/news/4">Ответы на частые вопросы поставщиков площадки</a>
    <a href="/news/5">Обучающий вебинар для новых участников торгов</a>
    <a href="/news/6">Расписание работы службы поддержки площадки</a>
  </article>
</body></html>`;

const ALL_KINDS: PageDiagnosis["kind"][] = [
  "ok",
  "login_required",
  "captcha",
  "blocked",
  "javascript",
  "not_found",
  "empty_list",
  "site_down",
  "unknown",
];

/** Виды, при которых страница до человека вообще не дошла: обещать ему
 * «страница открылась» здесь нельзя — это перекладывает вину на его ссылку. */
const KINDS_WITHOUT_PAGE: PageDiagnosis["kind"][] = [
  "login_required",
  "captcha",
  "blocked",
  "javascript",
  "not_found",
  "site_down",
];

test("страница входа вместо списка распознаётся как закрытый сайт", () => {
  const d = diagnosePage({ html: loginPageHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "login_required" });
});

test("ссылка «Войти» в шапке при живом списке — это не закрытый сайт", () => {
  const d = diagnosePage({ html: listWithLoginLinkHtml, status: 200, url: LIST_URL, itemsFound: 8 });
  assert.deepEqual(d, { kind: "ok" });
});

test("ссылка «Войти» без поля пароля не делает страницу закрытой даже без позиций", () => {
  const d = diagnosePage({ html: listWithLoginLinkHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.notEqual(d.kind, "login_required");
  assert.equal(d.kind, "unknown");
});

test("код 401 сам по себе означает, что нужен вход", () => {
  const d = diagnosePage({ html: "<html><body>Unauthorized</body></html>", status: 401, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "login_required" });
});

test("reCAPTCHA распознаётся как проверка на робота", () => {
  const d = diagnosePage({ html: recaptchaHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "captcha" });
});

test("Turnstile важнее общей заглушки: это тоже проверка на робота", () => {
  const d = diagnosePage({ html: turnstileHtml, status: 503, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "captcha" });
});

test("заглушка «Just a moment» без виджета — это блокировка", () => {
  const d = diagnosePage({ html: cloudflareHtml, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "blocked" });
});

test("отказ 403 — блокировка автоматических запросов", () => {
  const d = diagnosePage({
    html: "<html><body><h1>Forbidden</h1></body></html>",
    status: 403,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.deepEqual(d, { kind: "blocked" });
});

test("ответ 429 — тоже блокировка", () => {
  const d = diagnosePage({
    html: "<html><body><p>Слишком много обращений, попробуйте позже</p></body></html>",
    status: 429,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.deepEqual(d, { kind: "blocked" });
});

test("заглушка Incapsula считается блокировкой", () => {
  const d = diagnosePage({
    html: "<html><body>Request unsuccessful. Incapsula incident ID: 123-456</body></html>",
    status: 200,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.deepEqual(d, { kind: "blocked" });
});

test("код 404 — страницы нет", () => {
  const d = diagnosePage({ html: notFoundHtml, status: 404, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "not_found" });
});

test("текст «страница не найдена» при обычном ответе — тоже «страницы нет»", () => {
  const d = diagnosePage({ html: notFoundHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "not_found" });
});

test("пустая заготовка приложения — список рисуется уже в браузере", () => {
  const d = diagnosePage({ html: spaHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "javascript" });
});

test("страница PrimeFaces без готового списка — список рисуется уже в браузере", () => {
  const d = diagnosePage({ html: primefacesHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "javascript" });
});

test("«ничего не найдено» при рабочей странице — пустой список, а не поломка", () => {
  const d = diagnosePage({ html: emptyResultHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "empty_list" });
});

test("содержательная страница без списка остаётся неопознанной", () => {
  const d = diagnosePage({ html: articleHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "unknown" });
});

test("найденные позиции всегда важнее любых тревожных признаков на странице", () => {
  for (const html of [loginPageHtml, cloudflareHtml, recaptchaHtml, spaHtml, notFoundHtml]) {
    assert.deepEqual(diagnosePage({ html, status: 200, url: LIST_URL, itemsFound: 3 }), { kind: "ok" });
  }
  // даже когда сайт ответил отказом, но разбор что-то дал
  assert.deepEqual(
    diagnosePage({ html: cloudflareHtml, status: 403, url: LIST_URL, itemsFound: 5 }),
    { kind: "ok" },
  );
});

test("пустой ответ не роняет разбор", () => {
  assert.doesNotThrow(() => diagnosePage({ html: "", status: 200, url: LIST_URL, itemsFound: 0 }));
});

test("объяснение обходится без технических слов", () => {
  // Из проверки убираем сами теги: адрес живёт внутри href и человеку не виден.
  const forbiddenLatin =
    /\b(http|https|403|404|401|429|500|dom|css|xml|json|api|url|uri|javascript|js|html|ajax|spa|cloudflare|captcha|recaptcha|turnstile|user-agent)\b/i;
  // «Заглушка», «сервер», «запрос» — слова из разговора разработчиков: человек
  // на них спотыкается, а переспросить ему негде.
  const forbiddenRussian =
    /(селектор|парс|рендер|скрипт|разметк|редирект|бэкенд|токен|куки|cookie|дом-дерев|заглушк|сервер|запрос|защит[аы] от)/i;

  for (const kind of ALL_KINDS) {
    const { text } = explainDiagnosis({ kind } as PageDiagnosis, LIST_URL);
    const visible = text.replace(/<[^>]*>/g, " ");
    assert.ok(!forbiddenLatin.test(visible), `${kind}: техническое слово в «${visible}»`);
    assert.ok(!forbiddenRussian.test(visible), `${kind}: техническое слово в «${visible}»`);
  }
});

test("объяснение есть для каждой причины и говорит, что делать дальше", () => {
  for (const kind of ALL_KINDS) {
    const { text } = explainDiagnosis({ kind } as PageDiagnosis, LIST_URL);
    assert.ok(text.length > 60, `${kind}: объяснение слишком короткое`);
    assert.ok(text.includes("<b>"), `${kind}: нет заголовка`);
    assert.ok(text.includes(LIST_URL.replace(/&/g, "&amp;")), `${kind}: нет ссылки`);
  }
});

test("повторять попытку предлагаем только там, где это может помочь", () => {
  assert.equal(explainDiagnosis({ kind: "login_required" }, LIST_URL).canRetry, false);
  assert.equal(explainDiagnosis({ kind: "blocked" }, LIST_URL).canRetry, false);
  assert.equal(explainDiagnosis({ kind: "captcha" }, LIST_URL).canRetry, false);
  assert.equal(explainDiagnosis({ kind: "empty_list" }, LIST_URL).canRetry, true);
  assert.equal(explainDiagnosis({ kind: "unknown" }, LIST_URL).canRetry, true);
});

test("закрытому сайту объясняем причину и предлагаем выход", () => {
  const { text, canRetry } = explainDiagnosis({ kind: "login_required" }, LIST_URL);
  assert.equal(canRetry, false);
  assert.match(text, /вход|парол|пользоват/i);
  assert.match(text, /пришлите|давайте|добав/i);
});

test("адрес со спецсимволами экранируется, иначе сообщение не уйдёт", () => {
  const tricky = 'https://site.kg/list.php?f=all&t=<b>&q="ремонт"';
  const { text } = explainDiagnosis({ kind: "blocked" }, tricky);

  assert.ok(text.includes("?f=all&amp;t=&lt;b&gt;&amp;q=&quot;ремонт&quot;"));
  assert.ok(!text.includes("<b>&"));
  assert.ok(!/href="[^"]*"[^>]*"/.test(text), "кавычка внутри адреса порвала бы ссылку");
});

test("для адреса без обычной схемы ссылку не показываем, объяснение остаётся", () => {
  const { text } = explainDiagnosis({ kind: "unknown" }, "javascript:void(0)");
  assert.ok(!text.includes("<a href"));
  assert.ok(text.includes("<b>"));
});

/* ---------- форма входа рядом с живым списком ---------- */

test("форма входа в шапке при живом списке — это не закрытый сайт", () => {
  const d = diagnosePage({ html: listWithLoginFormHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.notEqual(d.kind, "login_required");
  assert.equal(d.kind, "unknown");
  assert.equal(explainDiagnosis(d, LIST_URL).canRetry, true);
});

test("страница входа с непривычными именами полей узнаётся по подписям", () => {
  const d = diagnosePage({ html: unusualLoginPageHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "login_required" });
});

/* ---------- слова защиты вне заглушки ---------- */

test("слова про отказ внутри скриптов не делают живой список заблокированным", () => {
  const d = diagnosePage({
    html: listWithScriptMessagesHtml,
    status: 200,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.notEqual(d.kind, "blocked");
  assert.equal(d.kind, "unknown");
});

test("оговорка в подвале про доступ для гостей не делает площадку закрытой", () => {
  const d = diagnosePage({
    html: listWithRestrictedFooterHtml,
    status: 200,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.notEqual(d.kind, "blocked");
  assert.equal(d.kind, "unknown");
});

test("надпись «подождите» в пустой заготовке — это не блокировка, а подгрузка", () => {
  const d = diagnosePage({ html: spaLoadingHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "javascript" });
});

/* ---------- капча рядом с живым списком ---------- */

test("проверка на робота в форме обратной связи не отменяет список", () => {
  const d = diagnosePage({
    html: listWithFooterCaptchaHtml,
    status: 200,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.notEqual(d.kind, "captcha");
  assert.equal(d.kind, "unknown");
});

/* ---------- «рисуется в браузере» не должно перебивать слова сайта ---------- */

test("маленький виджет рядом со списком не значит, что список рисуется в браузере", () => {
  const d = diagnosePage({
    html: listWithSearchWidgetHtml,
    status: 200,
    url: LIST_URL,
    itemsFound: 0,
  });
  assert.notEqual(d.kind, "javascript");
  assert.equal(d.kind, "unknown");
});

test("«ничего не найдено» важнее фреймворка: это пустой отбор, а не подгрузка", () => {
  const d = diagnosePage({ html: vueEmptyResultHtml, status: 200, url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "empty_list" });
  assert.equal(explainDiagnosis(d, LIST_URL).canRetry, true);
});

/* ---------- поломка на стороне сайта ---------- */

test("ошибка сайта 5xx — это не беда ссылки, а неполадка площадки", () => {
  for (const status of [500, 502, 503]) {
    const d = diagnosePage({
      html: "<html><body><h1>502 Bad Gateway</h1></body></html>",
      status,
      url: LIST_URL,
      itemsFound: 0,
    });
    assert.deepEqual(d, { kind: "site_down" }, `код ${status}`);
    assert.equal(explainDiagnosis(d, LIST_URL).canRetry, true, `код ${status}`);
  }
});

test("пустой ответ означает, что сайт не ответил", () => {
  const d = diagnosePage({ html: "", url: LIST_URL, itemsFound: 0 });
  assert.deepEqual(d, { kind: "site_down" });
  assert.equal(explainDiagnosis(d, LIST_URL).canRetry, true);
});

test("там, где страница не открылась, не обещаем человеку, что она открылась", () => {
  for (const kind of KINDS_WITHOUT_PAGE) {
    const { text } = explainDiagnosis({ kind } as PageDiagnosis, LIST_URL);
    assert.ok(!/Страница открылась/.test(text), `${kind}: обещаем открывшуюся страницу`);
  }
});

test("поломку сайта не выдаём за ошибку человека", () => {
  const { text } = explainDiagnosis({ kind: "site_down" }, LIST_URL);
  assert.match(text, /позже|позднее/i);
  assert.ok(!/пришлите/i.test(text), "просить другую ссылку из-за поломки сайта нельзя");
});
