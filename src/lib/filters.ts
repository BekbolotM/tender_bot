import * as cheerio from "cheerio";
import type { ChildNode, Element } from "domhandler";
import type { FilterField, FilterForm } from "./types";

const MAX_FORMS = 20;
const MAX_CONTROLS = 200;
const MAX_FIELDS = 60;
const MAX_OPTIONS = 50;
const MAX_LABEL_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 400;

/** Насколько высоко от поля искать блок фильтров, когда он лежит вне <form>. */
const MAX_CLIMB = 5;
/** Node.TEXT_NODE: сравниваем по числу, чтобы не тащить enum из domhandler. */
const TEXT_NODE = 3;

/** Типы input, из которых получается поле фильтра. submit, file, password фильтром не бывают. */
const INPUT_KINDS: Record<string, FilterField["kind"] | undefined> = {
  text: "text",
  search: "text",
  date: "date",
  "datetime-local": "date",
  month: "date",
  hidden: "hidden",
  checkbox: "checkbox",
  radio: "radio",
};

/** Имена полей, которые почти всегда и есть строка поиска по ключевым словам. */
const SEARCH_NAMES = new Set([
  "q",
  "query",
  "search",
  "keyword",
  "keywords",
  "text",
  "name",
  "title",
  "subject",
  "поиск",
  "наименование",
]);

/** Те же признаки, но кусками: подходят для имён вида `ctl00$txtSearch` или `searchString`. */
const SEARCH_PARTS = ["search", "query", "keyword", "поиск", "наименование", "ключев", "найти"];

/** Поля формы входа или подписки — по ним видно, что это не фильтр списка. */
const AUTH_FIELD_RE =
  /(password|passwd|pwd|log[-_]?in|sign[-_]?in|user[-_]?name|e[-_]?mail|newsletter|subscri|парол|логин|почт|подпис)/i;

/** Те же признаки на самой форме: action, id, class. */
const AUTH_FORM_RE =
  /(log[-_]?in|log[-_]?on|sign[-_]?in|sign[-_]?up|register|registration|subscribe|newsletter|\bauth\b|вход|регистрац|подпис)/i;

/** Поиск по всему сайту: он рабочий, но ищет не только тендеры — доверия меньше. */
const SITE_SEARCH_RE = /(^|[-_ ])(site|top|global|header|main|nav)[-_ ]?search/i;

/** Потолок оценки для поиска по всему сайту. */
const SITE_SEARCH_SCORE_CAP = 0.5;

/**
 * Сортировка и постраничная навигация приходят такими же полями, но фильтром
 * не являются: форма из одного `sort` не должна получать оценку настоящего
 * фильтра и вставать в выдаче рядом с ним.
 */
const PAGING_FIELD_RE =
  /(^|[-_])(sort|sorting|order|orderby|order_by|direction|rpp|per_page|pagesize|page|limit|offset|view|display)([-_]|$)/i;

/**
 * Имена вида `tv1:search-field-e`, `ctl00$txtSearch`, `j_idt100` генерирует
 * фреймворк: как подпись они бесполезны и в сообщении выглядят мусором.
 */
const GENERATED_NAME_RE = /[:$]|j_idt|ctl\d{2}/i;

const NO_LABEL = "без подписи";

/** Подпись — это короткая строка рядом с полем, а не текст справки или кнопки. */
const MAX_NEIGHBOUR_LABEL_LENGTH = 40;

function compact(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Подписи уходят в Telegram и в кнопки меню — убираем разметку и режем длину. */
function clean(value: string | undefined | null): string {
  return compact(value).replace(/[<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

function absoluteUrl(href: string | undefined, baseUrl: string): string {
  const trimmed = compact(href);
  if (!trimmed) return baseUrl;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-zа-я])([A-ZА-Я])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function isControl(node: ChildNode): boolean {
  const tag = (node as Element).tagName;
  return tag === "input" || tag === "select" || tag === "textarea" || tag === "button";
}

/** Собственный текст узла, без содержимого вложенных элементов. */
function ownText($: cheerio.CheerioAPI, element: Element): string {
  return $(element)
    .contents()
    .toArray()
    .filter((node) => node.nodeType === TEXT_NODE)
    .map((node) => $(node).text())
    .join(" ");
}

/** Текст подписи без содержимого контрола: <label>Регион <select>…</select></label>. */
function labelText($: cheerio.CheerioAPI, label: Element): string {
  return clean(ownText($, label)) || clean($(label).text());
}

/** Подписи, найденные на странице: по `label[for]` и по ссылкам `aria-labelledby`. */
type LabelMaps = { forId: Map<string, string>; byId: Map<string, string> };

/**
 * Собираем карты один раз: искать `label[for="…"]` или `#id` селектором опасно —
 * id на живых страницах бывает с кавычками, двоеточиями и скобками.
 */
function collectLabels($: cheerio.CheerioAPI): LabelMaps {
  const forId = new Map<string, string>();
  $("label[for]").each((_, element) => {
    const target = compact($(element).attr("for"));
    if (target && !forId.has(target)) forId.set(target, labelText($, element));
  });

  const referenced = new Set<string>();
  $("[aria-labelledby]").each((_, element) => {
    for (const id of compact($(element).attr("aria-labelledby")).split(/\s+/)) {
      if (id) referenced.add(id);
    }
  });

  const byId = new Map<string, string>();
  if (referenced.size > 0) {
    $("[id]").each((_, element) => {
      const id = compact($(element).attr("id"));
      if (referenced.has(id) && !byId.has(id)) byId.set(id, clean($(element).text()));
    });
  }

  return { forId, byId };
}

/** Текст справки или кнопки соседом не считаем: подпись поля короткая и не вопрос. */
function looksLikeLabel(text: string): boolean {
  return text.length > 0 && text.length <= MAX_NEIGHBOUR_LABEL_LENGTH && !text.includes("?");
}

/** Подпись часто просто стоит слева: «Регион: <select>» или в соседней ячейке. */
function neighbourText($: cheerio.CheerioAPI, element: Element): string {
  let sibling: ChildNode | null = element.prev;
  for (let step = 0; step < 4 && sibling; step += 1) {
    if (isControl(sibling)) break;
    const tag = (sibling as Element).tagName;
    // В <script> лежит инициализация виджетов, в <button> — надпись на кнопке.
    if (tag === "script" || tag === "style" || tag === "button") {
      sibling = sibling.prev;
      continue;
    }
    const text = compact($(sibling).text()).replace(/[:*]+$/, "").trim();
    if (text) return looksLikeLabel(text) ? text : "";
    sibling = sibling.prev;
  }
  const parent = element.parent as Element | null;
  const own = parent && parent.tagName ? compact(ownText($, parent)).replace(/[:*]+$/, "").trim() : "";
  return looksLikeLabel(own) ? own : "";
}

function labelFor(
  $: cheerio.CheerioAPI,
  labels: LabelMaps,
  element: Element,
  name: string,
): string {
  const node = $(element);

  const id = compact(node.attr("id"));
  const byFor = id ? labels.forId.get(id) : undefined;
  if (byFor) return byFor;

  for (const target of compact(node.attr("aria-labelledby")).split(/\s+/)) {
    const referenced = labels.byId.get(target);
    if (referenced) return referenced;
  }

  for (const attribute of ["placeholder", "aria-label", "title"]) {
    const value = clean(node.attr(attribute));
    if (value) return value;
  }

  const wrapping = node.closest("label").toArray()[0];
  if (wrapping) {
    const text = labelText($, wrapping as Element);
    if (text) return text;
  }

  // Сгенерированное фреймворком имя как подпись хуже честного «без подписи».
  return clean(neighbourText($, element)) || (GENERATED_NAME_RE.test(name) ? NO_LABEL : name);
}

function optionsOf($: cheerio.CheerioAPI, select: Element): { value: string; label: string }[] {
  return $(select)
    .find("option")
    .toArray()
    .slice(0, MAX_OPTIONS)
    .map((option) => {
      const text = $(option).text();
      // Без атрибута value браузер отправляет текст пункта — повторяем это правило.
      return { value: $(option).attr("value") ?? compact(text), label: clean(text) || compact(text) };
    });
}

/** Поле плюс строка признаков (`name`, `id`, `placeholder`) для поиска строки запроса. */
type DetectedField = {
  field: FilterField;
  hint: string;
};

function buildField(
  $: cheerio.CheerioAPI,
  labels: LabelMaps,
  element: Element,
  name: string,
): DetectedField | null {
  const node = $(element);
  const tag = (element.tagName ?? "").toLowerCase();
  const label = labelFor($, labels, element, name);
  const hint = `${name} ${node.attr("id") ?? ""} ${node.attr("placeholder") ?? ""}`.toLowerCase();

  if (tag === "select") {
    const field: FilterField = { name, label, kind: "select", options: optionsOf($, element) };
    const selected = node.find("option[selected]").first().attr("value");
    if (selected !== undefined) field.defaultValue = selected;
    return { field, hint };
  }

  if (tag === "textarea") {
    return { field: { name, label, kind: "text" }, hint };
  }

  const kind = INPUT_KINDS[(node.attr("type") ?? "text").toLowerCase()];
  if (!kind) return null;

  if (kind === "checkbox" || kind === "radio") {
    const value = node.attr("value") ?? "on";
    const field: FilterField = { name, label, kind, options: [{ value, label }] };
    if (node.attr("checked") !== undefined) field.defaultValue = value;
    return { field, hint };
  }

  const field: FilterField = { name, label, kind };
  const value = compact(node.attr("value"));
  if (value) field.defaultValue = value;
  return { field, hint };
}

/** Радиокнопки и чекбоксы с общим name — это одно поле с набором вариантов. */
function mergeGroup(
  $: cheerio.CheerioAPI,
  target: FilterField,
  extra: FilterField,
  element: Element,
): void {
  if (!extra.options?.length) return;
  target.options = [...(target.options ?? []), ...extra.options].slice(0, MAX_OPTIONS);
  // Подписи у вариантов разные, поэтому у самого поля остаётся общая: legend или name.
  target.label = clean($(element).closest("fieldset").find("legend").first().text()) || target.name;
  if (extra.defaultValue !== undefined) target.defaultValue = extra.defaultValue;
}

function collectFields(
  $: cheerio.CheerioAPI,
  labels: LabelMaps,
  controls: Element[],
): DetectedField[] {
  const byName = new Map<string, DetectedField>();

  for (const element of controls) {
    const name = compact($(element).attr("name"));
    if (!name) continue; // без name поле не уходит на сервер — для фильтра его нет

    const detected = buildField($, labels, element, name);
    if (!detected) continue;

    const existing = byName.get(name);
    if (existing) {
      mergeGroup($, existing.field, detected.field, element);
      continue;
    }

    byName.set(name, detected);
    if (byName.size >= MAX_FIELDS) break;
  }

  return [...byName.values()];
}

/** Строка ключевых слов — единственное поле, которое бот заполняет сам. */
function pickSearchField(detected: DetectedField[]): string | null {
  let best: { name: string; weight: number } | null = null;

  for (const { field, hint } of detected) {
    if (field.kind !== "text") continue;
    const tokens = tokenize(hint);
    const weight = tokens.some((token) => SEARCH_NAMES.has(token))
      ? 2
      : SEARCH_PARTS.some((part) => hint.includes(part))
        ? 1
        : 0;
    if (weight > 0 && (!best || weight > best.weight)) best = { name: field.name, weight };
  }

  return best?.name ?? null;
}

function looksLikeAuth($: cheerio.CheerioAPI, scope: Element, controls: Element[]): boolean {
  const node = $(scope);
  const marks = ["action", "id", "class", "name"].map((a) => node.attr(a) ?? "").join(" ");
  if (AUTH_FORM_RE.test(marks)) return true;

  return controls.some((element) => {
    const control = $(element);
    const type = (control.attr("type") ?? "").toLowerCase();
    if (type === "password" || type === "email") return true;
    const marks = ["name", "id", "placeholder"].map((a) => control.attr(a) ?? "").join(" ");
    return AUTH_FIELD_RE.test(marks);
  });
}

function isSiteWideSearch($: cheerio.CheerioAPI, scope: Element): boolean {
  const node = $(scope);
  if (node.closest("header, nav, [role=banner], [role=navigation], [role=search]").length > 0) {
    return true;
  }
  return SITE_SEARCH_RE.test(`${node.attr("id") ?? ""} ${node.attr("class") ?? ""}`);
}

/**
 * Насколько форма похожа на фильтр списка тендеров. Опорные признаки: есть куда
 * подставить ключевое слово, полей столько же, сколько у обычной панели фильтров,
 * и среди них есть списки выбора (регион, категория) и даты.
 */
function scoreOf(fields: FilterField[], searchField: string | null): number {
  const visible = fields.filter(
    (field) => field.kind !== "hidden" && (field.name === searchField || !PAGING_FIELD_RE.test(field.name)),
  );
  if (visible.length === 0) return 0;

  let score = searchField ? 0.35 : 0;

  if (visible.length >= 2 && visible.length <= 12) score += 0.3;
  else if (visible.length === 1) score += 0.1;
  else if (visible.length < 30) score += 0.15;
  // 30+ полей — это уже анкета или форма заявки, а не фильтр: не добавляем ничего.

  const lists = visible.filter(
    (field) => field.kind === "select" && (field.options?.length ?? 0) >= 2,
  ).length;
  if (lists >= 1) score += 0.2;
  if (lists >= 3) score += 0.05;
  if (visible.some((field) => field.kind === "date")) score += 0.1;

  return Math.min(1, Math.round(score * 100) / 100);
}

function buildForm(
  $: cheerio.CheerioAPI,
  labels: LabelMaps,
  scope: Element,
  baseUrl: string,
  standalone: boolean,
): FilterForm | null {
  const all = $(scope).find("input, select, textarea").toArray();
  // Блок без <form> мог захватить внутрь настоящую форму — её поля туда не пишем,
  // иначе получится несуществующая форма из склеенных чужих полей.
  const controls = (standalone ? all.filter((el) => $(el).closest("form").length === 0) : all).slice(
    0,
    MAX_CONTROLS,
  );
  const detected = collectFields($, labels, controls);
  const fields = detected.map((item) => item.field);
  if (fields.length === 0) return null;

  // Блок вне <form> считаем фильтром, только если в нём есть по чему искать:
  // строка ввода или выбор из заметного списка.
  if (standalone) {
    const usable =
      fields.some((field) => field.kind === "text") ||
      fields.some((field) => field.kind === "select" && (field.options?.length ?? 0) >= 3);
    if (!usable) return null;
  }

  const searchField = pickSearchField(detected);
  const auth = looksLikeAuth($, scope, controls);
  let score = auth ? 0 : scoreOf(fields, searchField);
  if (score > 0 && isSiteWideSearch($, scope)) score = Math.min(score, SITE_SEARCH_SCORE_CAP);

  const method = (compact($(scope).attr("method")).toLowerCase() === "post" ? "post" : "get") as
    | "get"
    | "post";

  return {
    // Панель без <form> отправляет запрос туда же, где сама лежит.
    action: standalone ? absoluteUrl(undefined, baseUrl) : absoluteUrl($(scope).attr("action"), baseUrl),
    method: standalone ? "get" : method,
    fields,
    searchField,
    score,
  };
}

function isDescendant(node: Element, ancestor: Element): boolean {
  let current = node.parent as Element | null;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent as Element | null;
  }
  return false;
}

/**
 * Панели фильтров сплошь и рядом живут без <form>: div с полями и кнопкой, а запрос
 * собирает скрипт. Поднимаемся от каждого поля вверх до ближайшего блока, где таких
 * полей уже несколько, — он и есть панель.
 */
function standaloneGroups($: cheerio.CheerioAPI): Element[] {
  const orphans = $("input, select, textarea")
    .toArray()
    .slice(0, MAX_CONTROLS)
    // Поле без name на сервер ничего не отправляет: как фильтра его нет, и
    // считать по нему «панель фильтров» тоже нельзя — так рождались формы-призраки.
    .filter((element) => compact($(element).attr("name")) !== "")
    .filter((element) => $(element).closest("form").length === 0);
  if (orphans.length < 2) return [];

  const orphanSet = new Set(orphans);
  const groups = new Set<Element>();

  for (const control of orphans) {
    let node = control.parent as Element | null;
    for (let depth = 0; depth < MAX_CLIMB && node && node.tagName; depth += 1) {
      const inside = $(node)
        .find("input, select, textarea")
        .toArray()
        .filter((element) => orphanSet.has(element)).length;
      if (inside >= 2) {
        // Блок, внутри которого есть настоящая <form>, — это обёртка страницы, а не панель.
        const wrapsForm = $(node).find("form").length > 0;
        if (!wrapsForm && node.tagName !== "body" && node.tagName !== "html") groups.add(node);
        break;
      }
      node = node.parent as Element | null;
    }
  }

  // Вложенные блоки выкидываем, иначе одни и те же поля вернутся дважды.
  const all = [...groups];
  return all.filter((group) => !all.some((other) => other !== group && isDescendant(group, other)));
}

/**
 * Ищет на странице списка формы поиска и фильтров: и настоящие <form>, и блоки
 * без них. Работает от строки HTML, без сети, — так результат легко проверить.
 */
export function detectFilterForms(html: string, baseUrl: string): FilterForm[] {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  const labels = collectLabels($);
  const forms: FilterForm[] = [];

  // Вложенные <form> парсер схлопывает сам, поэтому обход верхнего уровня полный.
  $("form")
    .slice(0, MAX_FORMS)
    .each((_, element) => {
      const form = buildForm($, labels, element as Element, baseUrl, false);
      if (form) forms.push(form);
    });

  for (const group of standaloneGroups($).slice(0, MAX_FORMS)) {
    const form = buildForm($, labels, group, baseUrl, true);
    if (form) forms.push(form);
  }

  return dedupe(forms.filter((form) => form.score > 0)).sort(
    (a, b) => b.score - a.score || b.fields.length - a.fields.length,
  );
}

/**
 * Одна и та же форма нередко продублирована на странице (мобильная и обычная
 * вёрстка), а показываем мы всего три — дубли съедали бы места настоящих.
 * Оставляем самую полную: у неё больше фильтров, которые админ может задать.
 */
function dedupe(forms: FilterForm[]): FilterForm[] {
  const best = new Map<string, FilterForm>();
  for (const form of forms) {
    const key = `${form.method} ${form.action} ${form.searchField ?? ""}`;
    const kept = best.get(key);
    if (!kept || form.score > kept.score || (form.score === kept.score && form.fields.length > kept.fields.length)) {
      best.set(key, form);
    }
  }
  return [...best.values()];
}

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/** Короткое описание формы для сообщения в Telegram: обычный текст, без разметки. */
export function describeForm(form: FilterForm): string {
  const visible = form.fields.filter((field) => field.kind !== "hidden");
  const search = form.fields.find((field) => field.name === form.searchField);

  const head = `Полей: ${visible.length}. Поиск: ${
    search ? `«${search.label}» (${search.name})` : "нет"
  }.`;

  const rest = visible
    .filter((field) => field.name !== form.searchField)
    // Поле без подписи и без вариантов в описании ничего не сообщает.
    .filter((field) => field.label !== NO_LABEL || (field.options?.length ?? 0) > 0)
    .slice(0, 5)
    .map((field) => {
      const count = field.options?.length ?? 0;
      if (!count) return field.label;
      return `${field.label} — ${count} ${plural(count, "вариант", "варианта", "вариантов")}`;
    });

  const text = rest.length ? `${head} Фильтры: ${rest.join("; ")}.` : head;
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
    : text;
}
