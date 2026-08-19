import type { Keyword } from "./types";

/**
 * Приводит текст к виду, в котором сравнение устойчиво к регистру,
 * пунктуации, переносам и «ё». Результат обрамлён пробелами, чтобы
 * поиск " слово " ловил границы слов без регулярных выражений.
 */
export function normalize(text: string): string {
  const lowered = text.toLowerCase().replace(/ё/g, "е");
  const cleaned = lowered.replace(/[^\p{L}\p{N}]+/gu, " ");
  return ` ${cleaned.trim().replace(/\s+/g, " ")} `;
}

/**
 * Ищет ключевое слово в уже нормализованном тексте.
 * «слово»   — совпадение целого слова;
 * «слово*»  — совпадение по началу слова (ремонт* → ремонта, ремонтные);
 * «две слова» — фраза целиком, слово в слово.
 */
export function matchesKeyword(normalizedText: string, keyword: string): boolean {
  const isPrefix = keyword.trim().endsWith("*");
  const bare = keyword.trim().replace(/\*+$/, "");
  const normalizedKeyword = normalize(bare).trim();
  if (!normalizedKeyword) return false;
  return normalizedText.includes(
    isPrefix ? ` ${normalizedKeyword}` : ` ${normalizedKeyword} `,
  );
}

export type MatchResult = {
  matched: boolean;
  /** Какие ключевые слова сработали — показываем их в уведомлении. */
  hits: string[];
};

/**
 * Позиция подходит, если сработало хотя бы одно обычное ключевое слово
 * и не сработало ни одно минус-слово. Пустой список ключевых слов
 * означает «шлём всё» — так бот полезен сразу после добавления сайта.
 */
export function matchText(text: string, keywords: Keyword[]): MatchResult {
  const normalized = normalize(text);

  const negatives = keywords.filter((k) => k.is_negative);
  for (const negative of negatives) {
    if (matchesKeyword(normalized, negative.word)) return { matched: false, hits: [] };
  }

  const positives = keywords.filter((k) => !k.is_negative);
  if (positives.length === 0) return { matched: true, hits: [] };

  const hits = positives.filter((k) => matchesKeyword(normalized, k.word)).map((k) => k.word);
  return { matched: hits.length > 0, hits };
}
