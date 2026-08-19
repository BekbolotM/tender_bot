import { test } from "node:test";
import assert from "node:assert/strict";
import { inviteButtons, inviteHint } from "../src/lib/bot/invitemenu.ts";
import { startPayload } from "../src/lib/bot/startpayload.ts";
import { INVITE_TTL_HOURS, inviteLink, parseInvitePayload } from "../src/lib/invites.ts";

const BOT = "tenderhuntkgz_bot";

/* ---------- payload команды /start ---------- */

test("payload берётся из текста после команды", () => {
  assert.equal(startPayload("/start inv_ABC", BOT), "inv_ABC");
});

test("команда без payload даёт null", () => {
  assert.equal(startPayload("/start", BOT), null);
  assert.equal(startPayload("/start   ", BOT), null);
  assert.equal(startPayload(`/start@${BOT}`, BOT), null);
});

test("адресная форма команды разбирается так же", () => {
  assert.equal(startPayload(`/start@${BOT} inv_ABC`, BOT), "inv_ABC");
});

test("имя бота в адресной форме сравнивается без учёта регистра", () => {
  // Telegram нормализует регистр имён по-своему, а grammY сравнивает их в нижнем.
  assert.equal(startPayload("/start@TenderHuntKgz_Bot inv_ABC", BOT), "inv_ABC");
  assert.equal(startPayload(`/start@${BOT} inv_ABC`, "TenderHuntKgz_Bot"), "inv_ABC");
});

test("команда, адресованная другому боту, игнорируется", () => {
  // В общем чате «/start@other_bot» — не наше сообщение, и приглашение по нему гасить нельзя.
  assert.equal(startPayload("/start@other_bot inv_ABC", BOT), null);
  assert.equal(startPayload("/start@ inv_ABC", BOT), null);
  assert.equal(startPayload("/start@a@b inv_ABC", BOT), null);
});

test("без известного имени бота адресная форма не принимается", () => {
  assert.equal(startPayload("/start@tenderhuntkgz_bot inv_ABC", undefined), null);
  assert.equal(startPayload("/start@tenderhuntkgz_bot inv_ABC", ""), null);
  // Простая форма от имени бота не зависит.
  assert.equal(startPayload("/start inv_ABC", undefined), "inv_ABC");
});

test("лишние пробелы вокруг payload срезаются", () => {
  assert.equal(startPayload("/start     inv_ABC", BOT), "inv_ABC");
  assert.equal(startPayload("/start inv_ABC   ", BOT), "inv_ABC");
  assert.equal(startPayload("/start\tinv_ABC\n", BOT), "inv_ABC");
  assert.equal(startPayload("/start\ninv_ABC", BOT), "inv_ABC");
});

test("команда должна начинать сообщение", () => {
  // У текста с отступом Telegram не ставит entity в нулевое смещение,
  // и grammY командой его не считает — middleware обязано вести себя так же.
  assert.equal(startPayload(" /start inv_ABC", BOT), null);
  assert.equal(startPayload("привет /start inv_ABC", BOT), null);
});

test("регистр имени команды имеет значение", () => {
  assert.equal(startPayload("/START inv_ABC", BOT), null);
  assert.equal(startPayload("/Start inv_ABC", BOT), null);
});

test("чужие и похожие команды не отдают payload", () => {
  assert.equal(startPayload("/menu inv_ABC", BOT), null);
  assert.equal(startPayload("/starter inv_ABC", BOT), null);
  assert.equal(startPayload("/start_bot inv_ABC", BOT), null);
  assert.equal(startPayload("start inv_ABC", BOT), null);
});

test("пустой и отсутствующий текст не ломают разбор", () => {
  assert.equal(startPayload(undefined, BOT), null);
  assert.equal(startPayload(null, BOT), null);
  assert.equal(startPayload("", BOT), null);
  assert.equal(startPayload("   ", BOT), null);
  assert.equal(startPayload("обычное сообщение", BOT), null);
});

/* ---------- сквозной путь «сообщение → токен» ---------- */

test("токен достаётся из сообщения по deep-link", () => {
  assert.equal(parseInvitePayload(startPayload("/start inv_AbC-123_xyz", BOT)), "AbC-123_xyz");
  assert.equal(
    parseInvitePayload(startPayload(`/start@${BOT} inv_AbC-123_xyz`, BOT)),
    "AbC-123_xyz",
  );
});

test("ссылка, собранная inviteLink, разбирается обратно в тот же токен", () => {
  const token = "s0meT0ken_-";
  const payload = inviteLink(BOT, token).split("?start=")[1];
  assert.equal(parseInvitePayload(startPayload(`/start ${payload}`, BOT)), token);
});

test("мусор вместо приглашения не превращается в токен", () => {
  assert.equal(parseInvitePayload(startPayload("/start", BOT)), null);
  assert.equal(parseInvitePayload(startPayload("/start hello", BOT)), null);
  assert.equal(parseInvitePayload(startPayload("/start ref_ABC", BOT)), null);
  assert.equal(parseInvitePayload(startPayload("/start inv_", BOT)), null);
  assert.equal(parseInvitePayload(startPayload("/start INV_ABC", BOT)), null);
  // Хвост после токена — уже другой payload, а не приглашение с примечанием.
  assert.equal(parseInvitePayload(startPayload("/start inv_ABC и ещё текст", BOT)), null);
});

/* ---------- меню «Админы» ---------- */

test("меню админов всегда предлагает пригласить по ссылке", () => {
  for (const active of [0, 1, 7]) {
    const invite = inviteButtons(active).find((b) => b.data === "admin_invite");
    assert.ok(invite, `нет кнопки приглашения при ${active} активных`);
    assert.match(invite.text, /Пригласить по ссылке/);
  }
});

test("без активных приглашений отзывать нечего", () => {
  assert.deepEqual(
    inviteButtons(0).map((b) => b.data),
    ["admin_invite"],
  );
  assert.match(inviteHint(0, INVITE_TTL_HOURS), /Действующих ссылок нет/);
});

test("активные приглашения дают кнопку отзыва с их числом", () => {
  assert.deepEqual(
    inviteButtons(3).map((b) => b.data),
    ["admin_invite", "admin_revoke"],
  );
  assert.equal(inviteButtons(3)[1].text, "❌ Отозвать ссылки (3)");
  assert.match(inviteHint(3, INVITE_TTL_HOURS), /действует ссылок: 3/i);
});

test("меню объясняет одноразовость и срок жизни ссылки", () => {
  const hint = inviteHint(0, INVITE_TTL_HOURS);
  assert.match(hint, /одноразов/i);
  assert.ok(hint.includes(String(INVITE_TTL_HOURS)), "в меню не назван срок жизни ссылки");
  // Срок берётся из invites.ts, а не зашит в текст второй раз.
  assert.match(inviteHint(0, 3), /действует 3 ч\./);
});

test("меню предупреждает, какие права уходят вместе со ссылкой", () => {
  // Ссылку пересылают как «доступ посмотреть», а она отдаёт и управление админами.
  assert.match(inviteHint(0, INVITE_TTL_HOURS), /удаление других админов/i);
});

test("меню объясняет, что отзыв гасит все ссылки, а не только свои", () => {
  // Кнопка отзыва одна на бота: нажавший обрывает и чужое разосланное приглашение.
  const hint = inviteHint(2, INVITE_TTL_HOURS);
  assert.match(hint, /все действующие ссылки/i);
  assert.match(hint, /другими админами/i);
  // Снятие админа тоже закрывает его ключи — иначе он вернётся по своей же ссылке.
  assert.match(hint, /Удаление админа гасит и его невыданные ссылки/i);
});

test("меню не обещает, что выданную ссылку можно посмотреть заново", () => {
  // Токен наружу из базы не отдаётся: потерянную ссылку только отзывают и выпускают новую.
  const hint = inviteHint(1, INVITE_TTL_HOURS);
  assert.match(hint, /нельзя/i);
  assert.ok(!hint.includes("t.me/"), "в меню не должно быть самих ссылок");
});
