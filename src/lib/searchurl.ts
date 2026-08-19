import type { FilterForm, SiteSearch } from "./types";

/** Потолок запросов к сайту за прогон: иначе десяток слов превратится в сотню страниц. */
const DEFAULT_URL_LIMIT = 8;

/** Кавычки по краям — синтаксис матчера для фраз, сайту он не нужен. */
const EDGE_QUOTES_RE = /^["'«„“]+|["'»”]+$/g;

/**
 * Снимает с ключевого слова служебный синтаксис матчера: хвостовую звёздочку
 * и обрамляющие кавычки — на сайте всё равно ищется подстрока, а «ремонт*»
 * поле поиска поняло бы буквально. Минус-слова и пустые строки отбрасываем:
 * искать их на сайте бессмысленно, они только отсеивают уже найденное.
 */
function cleanKeyword(keyword: string): string | null {
  const unquoted = keyword.trim().replace(EDGE_QUOTES_RE, "").trim();
  if (unquoted.startsWith("-")) return null;
  return unquoted.replace(/\*+$/, "").trim() || null;
}

/** Насколько GET-форма может уступать лучшей, чтобы её всё же предпочли. */
const GET_SCORE_TOLERANCE = 0.2;

/**
 * Из всех найденных на странице форм выбирает ту, через которую бот сможет
 * искать. Формы отсортированы по правдоподобию; GET предпочитаем — его выдача
 * открывается по ссылке, — но только при сопоставимом качестве: иначе поиск по
 * всему сайту из шапки вытеснил бы найденный фильтр тендеров, а он на площадках
 * ASP.NET и JSF почти всегда POST.
 */
export function pickSearchForm(forms: FilterForm[]): FilterForm | null {
  const withSearch = forms.filter((form) => form.searchField && form.action);
  const top = withSearch[0];
  if (!top) return null;

  const get = withSearch.find((form) => form.method === "get");
  return get && get.score >= top.score - GET_SCORE_TOLERANCE ? get : top;
}

/**
 * Превращает форму в конфиг поиска. POST-форму тоже берём: площадки СНГ почти
 * всегда принимают те же параметры и в query-строке. Если конкретная не примет
 * (405 или 404 на GET), обход сайта не срывается: checker разберёт страницу
 * списка запасным адресом.
 */
export function searchFromForm(form: FilterForm): SiteSearch | null {
  if (!form.searchField || !form.action) return null;
  return {
    mode: "query",
    action: form.action,
    method: form.method,
    param: form.searchField,
  };
}

/**
 * Собирает URL поиска: ключевое слово в поле поиска сайта плюс фиксированные
 * фильтры админа. Любая неопределённость — возвращаем страницу списка:
 * лучше разобрать её целиком, чем сорвать проверку сайта.
 */
export function buildSearchUrl(search: SiteSearch, keyword: string, fallbackUrl: string): string {
  if (search.mode !== "query" || !search.action || !search.param) return fallbackUrl;

  const word = cleanKeyword(keyword);
  if (!word) return fallbackUrl;

  let url: URL;
  try {
    url = new URL(search.action);
  } catch {
    return fallbackUrl;
  }

  url.searchParams.set(search.param, word);

  for (const [name, value] of Object.entries(search.extra ?? {})) {
    // Фильтры админа сильнее того, что зашито в action, — он выбирал их осознанно.
    // Кроме самого поля поиска: затерев его, мы бы получили один и тот же URL
    // на все ключевые слова.
    if (name === search.param) continue;
    url.searchParams.set(name, value);
  }

  return url.toString();
}

/** FNV-1a: нужен разброс, а не криптостойкость. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Сдвиг окна ключевых слов для сайта. Порядок слов в БД стабилен, поэтому без
 * сдвига слова после лимита не попадали бы в поиск ни разу. Опору берём из
 * времени прошлой проверки — оно меняется от прогона к прогону и уже лежит в
 * базе, отдельный счётчик не нужен. Берём именно хэш, а не сами секунды: крон
 * ходит ровным интервалом, и остаток от деления давал бы то же самое окно.
 */
export function keywordWindowOffset(siteId: number, lastCheckedAt: string | null): number {
  // Сайт, который ещё не проверялся, начинает с начала списка — так предсказуемее.
  if (!lastCheckedAt) return 0;
  return hashString(`${siteId}:${lastCheckedAt}`);
}

/**
 * Набор URL на один прогон сайта — по одному на ключевое слово, без дублей.
 * За лимит берём не первые слова, а окно, начинающееся с `offset`: порядок слов
 * в БД стабилен, поэтому без сдвига слова из хвоста списка не искались бы никогда.
 */
export function searchUrlsFor(
  search: SiteSearch,
  keywords: string[],
  fallbackUrl: string,
  limit = DEFAULT_URL_LIMIT,
  offset = 0,
): string[] {
  if (search.mode !== "query") return [fallbackUrl];

  const usable = keywords.filter((word) => cleanKeyword(word) !== null);
  const start = usable.length > 0 ? ((offset % usable.length) + usable.length) % usable.length : 0;
  const window = [...usable.slice(start), ...usable.slice(0, start)].slice(0, limit);
  const urls = new Set(window.map((word) => buildSearchUrl(search, word, fallbackUrl)));

  return urls.size > 0 ? [...urls] : [fallbackUrl];
}
