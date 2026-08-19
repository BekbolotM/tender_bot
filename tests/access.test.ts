import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accessDeniedText,
  adminDeletionError,
  CALLBACK_ALERT_MAX,
  parseAdminId,
  revokeNote,
} from "../src/lib/bot/access.ts";
import { INVITE_TTL_HOURS, inviteLink } from "../src/lib/invites.ts";

/* ---------- разбор Telegram ID ---------- */

test("голый идентификатор принимается", () => {
  assert.equal(parseAdminId("123456789"), 123456789);
  assert.equal(parseAdminId("  123456789  "), 123456789);
  assert.equal(parseAdminId("12345"), 12345);
});

test("ссылка-приглашение не превращается в админа", () => {
  // Раньше из строки вычёркивались все нецифры, и такая вставка заводила
  // «админа 38»: на него потом падала каждая рассылка крона.
  const link = inviteLink("tenderhuntkgz_bot", "UPb3o8pXtPnHsXscniOUrw");
  assert.equal(parseAdminId(link), null);
  assert.equal(parseAdminId("https://t.me/tenderhuntkgz_bot?start=inv_ABC123"), null);
});

test("мусор и опасные формы отбраковываются", () => {
  assert.equal(parseAdminId(""), null);
  assert.equal(parseAdminId("   "), null);
  assert.equal(parseAdminId("@username"), null);
  assert.equal(parseAdminId("id 123456789"), null);
  assert.equal(parseAdminId("123 456 789"), null);
  assert.equal(parseAdminId("-123456789"), null);
  assert.equal(parseAdminId("1234"), null, "слишком короткий id — почти наверняка опечатка");
  // Длинная цифровая строка уходила в bigint и роняла запрос уже в базе.
  assert.equal(parseAdminId("1234567890123456789012"), null);
});

test("предельная длина id остаётся точным числом", () => {
  const id = parseAdminId("999999999999999");
  assert.equal(id, 999999999999999);
  assert.ok(Number.isSafeInteger(id));
});

/* ---------- удаление админов ---------- */

test("обычное удаление разрешено", () => {
  assert.equal(adminDeletionError(2, 1, [1, 2, 3], []), null);
  assert.equal(adminDeletionError(2, 1, [1, 2], []), null);
});

test("себя удалить нельзя", () => {
  const error = adminDeletionError(1, 1, [1, 2, 3], [7]);
  assert.ok(error, "самоудаление обязано отклоняться");
  assert.match(error, /себя/i);
});

test("последнего админа без владельца в env удалить нельзя", () => {
  // Пустая таблица admins снова открывает захват бота первым написавшим.
  const error = adminDeletionError(2, 1, [2], []);
  assert.ok(error, "опустошение списка админов обязано отклоняться");
  assert.match(error, /OWNER_TELEGRAM_ID/);
});

test("с владельцем из env последняя строка удаляется", () => {
  // Владелец доступ не теряет: его id проверяется до обращения к таблице.
  assert.equal(adminDeletionError(2, 1, [2], [1]), null);
});

test("устаревшая кнопка на уже удалённого админа не блокирует список", () => {
  // Строки в списке нет — удалять нечего, но и запрещать нечего.
  assert.equal(adminDeletionError(9, 1, [1, 2], []), null);
});

test("отказы влезают во всплывающий ответ Telegram", () => {
  for (const error of [adminDeletionError(1, 1, [1], []), adminDeletionError(2, 1, [2], [])]) {
    assert.ok(error);
    assert.ok(error.length <= CALLBACK_ALERT_MAX, `слишком длинный ответ: ${error.length}`);
  }
});

/* ---------- отказ постороннему ---------- */

test("отказ называет Telegram ID в обеих формах", () => {
  const denied = accessDeniedText(4242, false, INVITE_TTL_HOURS);
  assert.match(denied.plain, /4242/);
  assert.match(denied.html, /<code>4242<\/code>/);
  // Во всплывающем ответе разметка показывается как есть — тегов там быть не должно.
  assert.ok(!denied.plain.includes("<"), "в тексте для алерта не должно быть HTML");
});

test("по битой ссылке объясняем причину, а не просто «доступ запрещён»", () => {
  const denied = accessDeniedText(4242, true, INVITE_TTL_HOURS);
  assert.match(denied.plain, /одноразов/i);
  assert.ok(denied.plain.includes(String(INVITE_TTL_HOURS)), "не назван срок жизни ссылки");
  assert.match(denied.plain, /4242/);
});

test("отказ влезает во всплывающий ответ Telegram", () => {
  for (const hasToken of [true, false]) {
    const { plain } = accessDeniedText(1234567890, hasToken, INVITE_TTL_HOURS);
    assert.ok(plain.length <= CALLBACK_ALERT_MAX, `слишком длинный отказ: ${plain.length}`);
  }
});

/* ---------- итог отзыва ссылок ---------- */

test("отзыв сообщает, что задел чужие ссылки", () => {
  assert.match(revokeNote(3, 2), /Отозвано ссылок: 3/);
  assert.match(revokeNote(3, 2), /другими админами: 2/);
});

test("свои ссылки отдельно не считаются", () => {
  assert.equal(revokeNote(2, 0), "❌ Отозвано ссылок: 2.");
});

test("чужих не бывает больше, чем отозванных", () => {
  // Чужие считаются отдельным запросом до отзыва — за это время их могло стать меньше.
  assert.match(revokeNote(1, 5), /другими админами: 1/);
});

test("пустой отзыв не притворяется сделанной работой", () => {
  assert.match(revokeNote(0, 0), /нечего/i);
  assert.match(revokeNote(0, 3), /нечего/i);
});
