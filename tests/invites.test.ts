import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_PREFIX,
  INVITE_TTL_HOURS,
  formatInviteMessage,
  inviteExpiresAt,
  inviteLink,
  isInviteExpired,
  newInviteToken,
  parseInvitePayload,
} from "../src/lib/invites.ts";

const ALPHABET = /^[A-Za-z0-9_-]+$/;

test("токен состоит только из символов, разрешённых Telegram", () => {
  for (let i = 0; i < 50; i++) {
    const token = newInviteToken();
    assert.match(token, ALPHABET);
    assert.ok(!token.includes("="), "в base64url не должно быть padding");
    assert.ok(!token.includes("+") && !token.includes("/"), "не обычный base64");
  }
});

test("токен несёт не меньше 128 бит энтропии", () => {
  // 22 символа base64url ≈ 16 случайных байт.
  assert.equal(newInviteToken().length, 22);
});

test("1000 генераций не дают повторов", () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 1000; i++) tokens.add(newInviteToken());
  assert.equal(tokens.size, 1000);
});

test("payload укладывается в лимит Telegram в 64 символа", () => {
  const payload = `${INVITE_PREFIX}${newInviteToken()}`;
  assert.ok(payload.length <= 64, `длина payload ${payload.length}`);
});

test("ссылка собирается из чистого имени бота", () => {
  assert.equal(
    inviteLink("tender_watch_bot", "abc123"),
    "https://t.me/tender_watch_bot?start=inv_abc123",
  );
});

test("ведущая собака в имени бота отбрасывается", () => {
  assert.equal(
    inviteLink("@tender_watch_bot", "abc123"),
    inviteLink("tender_watch_bot", "abc123"),
  );
  assert.equal(inviteLink("  @tender_watch_bot  ", "abc123"), "https://t.me/tender_watch_bot?start=inv_abc123");
});

test("пустое имя бота — ошибка", () => {
  assert.throws(() => inviteLink("", "abc123"), /имя бота/i);
  assert.throws(() => inviteLink("   ", "abc123"), /имя бота/i);
  assert.throws(() => inviteLink("@", "abc123"), /имя бота/i);
});

test("имя бота вне алфавита Telegram — ошибка, а не кривая ссылка", () => {
  // Регрессия: кавычка из имени уезжала в href="…" и рвала атрибут разметки.
  assert.throws(() => inviteLink('bot" onmouseover="x', "TOKEN"), /имя бота/i);
  assert.throws(() => inviteLink("bot/../evil", "TOKEN"), /имя бота/i);
  assert.throws(() => inviteLink("bot bot", "TOKEN"), /имя бота/i);
  assert.throws(() => inviteLink("бот_тендер", "TOKEN"), /имя бота/i);
  assert.throws(() => inviteLink("bot", "TOKEN"), /имя бота/i);
  assert.throws(() => inviteLink("b".repeat(33), "TOKEN"), /имя бота/i);
});

test("нормальные имена ботов принимаются", () => {
  assert.equal(inviteLink("Bot_42", "t"), "https://t.me/Bot_42?start=inv_t");
  assert.equal(inviteLink("@tender_watch_bot", "t"), "https://t.me/tender_watch_bot?start=inv_t");
  assert.equal(inviteLink("b".repeat(32), "t"), `https://t.me/${"b".repeat(32)}?start=inv_t`);
});

test("валидный payload разбирается в токен", () => {
  assert.equal(parseInvitePayload("inv_AbC-123_xyz"), "AbC-123_xyz");
});

test("пустой payload отбраковывается", () => {
  assert.equal(parseInvitePayload(undefined), null);
  assert.equal(parseInvitePayload(null), null);
  assert.equal(parseInvitePayload(""), null);
  assert.equal(parseInvitePayload("   "), null);
});

test("payload без префикса и с чужим префиксом отбраковывается", () => {
  assert.equal(parseInvitePayload("AbC123"), null);
  assert.equal(parseInvitePayload("ref_AbC123"), null);
  assert.equal(parseInvitePayload("inv-AbC123"), null);
});

test("регистр префикса имеет значение", () => {
  assert.equal(parseInvitePayload("INV_AbC123"), null);
  assert.equal(parseInvitePayload("Inv_AbC123"), null);
});

test("один префикс без токена отбраковывается", () => {
  assert.equal(parseInvitePayload("inv_"), null);
});

test("недопустимые символы в токене отбраковываются", () => {
  assert.equal(parseInvitePayload("inv_abc/123"), null);
  assert.equal(parseInvitePayload("inv_abc+123"), null);
  assert.equal(parseInvitePayload("inv_abc=123"), null);
  assert.equal(parseInvitePayload("inv_abc 123"), null);
  assert.equal(parseInvitePayload("inv_абв123"), null);
});

test("слишком длинный payload отбраковывается", () => {
  const long = `${INVITE_PREFIX}${"a".repeat(61)}`; // 65 символов
  assert.equal(long.length, 65);
  assert.equal(parseInvitePayload(long), null);
  assert.equal(parseInvitePayload(long.slice(0, 64)), "a".repeat(60));
});

test("пробелы по краям payload срезаются", () => {
  assert.equal(parseInvitePayload("  inv_AbC123  "), "AbC123");
  assert.equal(parseInvitePayload("\ninv_AbC123\t"), "AbC123");
});

test("свежесозданный токен проходит обратный разбор ссылки", () => {
  const token = newInviteToken();
  const payload = inviteLink("tender_watch_bot", token).split("?start=")[1];
  assert.equal(parseInvitePayload(payload), token);
});

test("срок истечения считается от переданного момента", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  assert.equal(inviteExpiresAt(now).toISOString(), "2026-08-20T10:00:00.000Z");
  assert.equal(inviteExpiresAt(now, 1).toISOString(), "2026-08-19T11:00:00.000Z");
  assert.equal(INVITE_TTL_HOURS, 24);
});

test("не истёкшее приглашение живо, истёкшее — нет", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  assert.equal(isInviteExpired(new Date("2026-08-19T10:00:01.000Z"), now), false);
  assert.equal(isInviteExpired(new Date("2026-08-19T09:59:59.000Z"), now), true);
});

test("момент ровно в срок считается истёкшим", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  assert.equal(isInviteExpired(now, now), true);
});

test("срок принимается и строкой из базы", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  assert.equal(isInviteExpired("2026-08-20T10:00:00.000Z", now), false);
  assert.equal(isInviteExpired("2026-08-18T10:00:00.000Z", now), true);
});

/**
 * Зона процесса меняется на время проверки: под TZ=UTC баг с разбором наивной
 * строки как местного времени невидим, и тест зеленел бы при любой реализации.
 */
function withTz<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    assert.notEqual(
      new Date("2026-08-20T10:00:00").getTime(),
      Date.parse("2026-08-20T10:00:00Z"),
      `зона ${tz} не применилась — проверка бессмысленна`,
    );
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("строка без смещения читается как UTC, а не как время хоста", () => {
  // Регрессия: западнее UTC истёкшее приглашение оставалось «живым» на часы смещения.
  withTz("America/New_York", () => {
    const now = new Date("2026-08-20T13:00:00.000Z"); // через 3 часа после срока
    assert.equal(isInviteExpired("2026-08-20 10:00:00", now), true);
    assert.equal(isInviteExpired("2026-08-20T10:00:00", now), true);
    assert.equal(isInviteExpired("2026-08-20 10:00:00.123456", now), true);
  });
});

test("восточнее UTC приглашение не умирает раньше срока", () => {
  withTz("Asia/Bishkek", () => {
    const now = new Date("2026-08-20T09:00:00.000Z"); // за час до срока
    assert.equal(isInviteExpired("2026-08-20 10:00:00", now), false);
    assert.equal(isInviteExpired("2026-08-20T10:00:00.000Z", now), false);
  });
});

test("явное смещение из базы учитывается", () => {
  withTz("America/New_York", () => {
    const now = new Date("2026-08-20T13:00:00.000Z");
    assert.equal(isInviteExpired("2026-08-20 10:00:00+00", now), true);
    assert.equal(isInviteExpired("2026-08-20 10:00:00+00:00", now), true);
    assert.equal(isInviteExpired("2026-08-20 10:00:00+06", now), true); // = 04:00 UTC
    assert.equal(isInviteExpired("2026-08-20 20:00:00+06:00", now), false); // = 14:00 UTC
    assert.equal(isInviteExpired("2026-08-20 09:00:00-06", now), false); // = 15:00 UTC
  });
});

test("форма строки не меняет вердикт при смене зоны хоста", () => {
  const now = new Date("2026-08-20T13:00:00.000Z");
  const forms = [
    "2026-08-20 10:00:00",
    "2026-08-20T10:00:00",
    "2026-08-20T10:00:00.000Z",
    "2026-08-20 10:00:00+00",
    "2026-08-20 14:00:00",
  ];
  for (const form of forms) {
    const inNewYork = withTz("America/New_York", () => isInviteExpired(form, now));
    const inBishkek = withTz("Asia/Bishkek", () => isInviteExpired(form, now));
    assert.equal(inNewYork, inBishkek, `вердикт по «${form}» зависит от зоны процесса`);
  }
});

test("битая дата считается истёкшей", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  assert.equal(isInviteExpired("не дата", now), true);
  assert.equal(isInviteExpired("", now), true);
  assert.equal(isInviteExpired(new Date("хлам"), now), true);
});

test("нераспознанная форма срока считается истёкшей", () => {
  const now = new Date("2026-08-19T10:00:00.000Z");
  // Всё, что не разобрано однозначно, гасит приглашение: отказ дешевле выдачи админки.
  assert.equal(isInviteExpired("20.08.2026 10:00", now), true);
  assert.equal(isInviteExpired("2026-08-20", now), true);
  assert.equal(isInviteExpired("2026-08-20 10:00:00 MSK", now), true);
  assert.equal(isInviteExpired("2026-13-01 10:00:00", now), true);
  assert.equal(isInviteExpired("2026-08-20 25:00:00", now), true);
});

test("сообщение экранирует спецсимволы ссылки", () => {
  const message = formatInviteMessage("https://t.me/bot?start=inv_a&b=<c>", new Date("2026-08-20T10:00:00.000Z"));
  assert.ok(message.includes("inv_a&amp;b=&lt;c&gt;"));
  assert.ok(!message.includes("&b="), "сырой амперсанд ломает HTML-разметку Telegram");
  assert.ok(!message.includes("<c>"));
});

test("сообщение экранирует кавычки: href не должен обрываться", () => {
  // Регрессия: сырая кавычка закрывала href="…" и превращала хвост в чужой атрибут.
  const message = formatInviteMessage('https://t.me/bot?start=inv_a"b\'c', new Date("2026-08-20T10:00:00.000Z"));
  assert.ok(message.includes('<a href="https://t.me/bot?start=inv_a&quot;b&#39;c">'));
  assert.equal(message.match(/"/g)?.length, 2, "кавычки остались только те, что обрамляют href");
  assert.ok(!message.includes("inv_a\"b"), "сырая кавычка внутри значения атрибута");
});

test("сообщение показывает срок в UTC и предупреждает о пересылке", () => {
  const message = formatInviteMessage("https://t.me/bot?start=inv_abc", new Date("2026-08-20T10:00:00.000Z"));
  assert.ok(message.includes("2026-08-20 10:00 UTC"));
  assert.match(message, /не пересылайте/i);
  assert.ok(message.includes('<a href="https://t.me/bot?start=inv_abc">'));
});

test("сообщение не обещает одноразовость, которой модуль не обеспечивает", () => {
  // Погашения токена среди экспортов нет, поэтому обещание «сгорит после перехода»
  // было бы ложным и гасило бы единственную реакцию получателя — просьбу отозвать ссылку.
  const message = formatInviteMessage("https://t.me/bot?start=inv_abc", new Date("2026-08-20T10:00:00.000Z"));
  assert.doesNotMatch(message, /одноразов/i);
  assert.doesNotMatch(message, /перестанет работать/i);
});
