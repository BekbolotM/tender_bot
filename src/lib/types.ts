/** Как вытаскивать позиции со страницы списка тендеров. */
export type Selectors = {
  /** Селектор карточки одного тендера. */
  item: string;
  /** Селектор заголовка внутри карточки. Пусто — берём весь текст карточки. */
  title?: string;
  /** Селектор ссылки внутри карточки. Пусто — первый <a>. */
  link?: string;
  /** Селектор даты внутри карточки. Необязателен. */
  date?: string;
  /** Селектор цены внутри карточки. Необязателен. */
  price?: string;
};

export type Site = {
  id: number;
  title: string;
  list_url: string;
  selectors: Selectors;
  /** Как обходить сайт: страницей списка или через его собственный поиск. */
  search: SiteSearch;
  enabled: boolean;
  last_checked_at: string | null;
  last_error: string | null;
};

export type Keyword = {
  id: number;
  word: string;
  is_negative: boolean;
};

export type ScrapedItem = {
  title: string;
  url: string | null;
  date: string | null;
  price: string | null;
  /** Весь текст карточки — по нему тоже ищем ключевые слова. */
  text: string;
};

/* ---------- формы поиска и фильтры на стороне сайта ---------- */

/** Одно поле формы фильтра, найденное на странице. */
export type FilterField = {
  /** Имя параметра, которое уходит на сервер (`name` инпута). */
  name: string;
  /** Человекочитаемая подпись: label, placeholder или сам name. */
  label: string;
  kind: "text" | "select" | "checkbox" | "radio" | "date" | "hidden";
  /** Варианты для select/radio: значение → подпись. */
  options?: { value: string; label: string }[];
  /** Значение, выбранное на странице по умолчанию. */
  defaultValue?: string;
};

/** Форма поиска/фильтрации, найденная на странице списка. */
export type FilterForm = {
  /** Абсолютный URL, куда форма отправляет запрос. */
  action: string;
  method: "get" | "post";
  fields: FilterField[];
  /**
   * Имя поля, которое похоже на строку поиска по ключевым словам
   * (`q`, `search`, `keyword`, `name`…). null — такого поля нет.
   */
  searchField: string | null;
  /** Насколько форма похожа на фильтр списка тендеров: 0…1. */
  score: number;
};

/**
 * Как бот ищет на сайте. `off` — просто читает страницу списка;
 * `query` — подставляет каждое ключевое слово в поле поиска сайта,
 * что резко сокращает объём разбора и повышает точность.
 */
export type SiteSearch = {
  mode: "off" | "query";
  /** URL, к которому добавляются параметры (обычно action формы). */
  action?: string;
  method?: "get" | "post";
  /** Имя параметра для ключевого слова. */
  param?: string;
  /** Дополнительные фиксированные параметры фильтра: регион, категория, статус. */
  extra?: Record<string, string>;
};
