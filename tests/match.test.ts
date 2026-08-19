import { test } from "node:test";
import assert from "node:assert/strict";
import { matchText, normalize } from "../src/lib/match.ts";

const kw = (word: string, is_negative = false) => ({ id: 1, word, is_negative });

test("нормализация убирает регистр, ё и пунктуацию", () => {
  assert.equal(normalize("Ремонт  КРОВЛИ, школы №12!"), " ремонт кровли школы 12 ");
  assert.equal(normalize("Приём ЗАЯВОК"), " прием заявок ");
});

test("совпадение по целому слову, а не по подстроке", () => {
  assert.equal(matchText("Ремонт кровли", [kw("ремонт")]).matched, true);
  assert.equal(matchText("Капремонта не будет", [kw("ремонт")]).matched, false);
});

test("звёздочка ищет по началу слова", () => {
  assert.equal(matchText("Ремонтные работы", [kw("ремонт*")]).matched, true);
  assert.equal(matchText("Поставка ремонта", [kw("ремонт*")]).matched, true);
  assert.equal(matchText("Поставка мебели", [kw("ремонт*")]).matched, false);
});

test("фраза ищется целиком", () => {
  assert.equal(matchText("Поставка мебели офисной", [kw("поставка мебели")]).matched, true);
  assert.equal(matchText("Поставка офисной мебели", [kw("поставка мебели")]).matched, false);
});

test("минус-слово отменяет совпадение", () => {
  const keywords = [kw("ремонт"), kw("аварийный", true)];
  assert.equal(matchText("Ремонт кровли", keywords).matched, true);
  assert.equal(matchText("Аварийный ремонт кровли", keywords).matched, false);
});

test("пустой список ключевых слов пропускает всё", () => {
  assert.equal(matchText("Что угодно", []).matched, true);
});

test("возвращает список сработавших слов", () => {
  const result = matchText("Ремонт кровли школы", [kw("ремонт"), kw("кровля"), kw("кровли")]);
  assert.deepEqual(result.hits, ["ремонт", "кровли"]);
});
