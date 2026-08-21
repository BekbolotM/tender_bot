import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingSchema, once, retryOnMissingSchema } from "../src/lib/db.ts";

/**
 * Выкладка новой версии не должна выключать бота. Раньше колонка, которой нет в
 * боевой базе, роняла всё, что читает площадки, — меню, кнопку проверки, крон и
 * приём страниц от сборщика, — и так до тех пор, пока владелец вручную не
 * откроет /api/setup. Здесь проверяется ровно то, что чинит это само.
 *
 * Сеть и база не нужны: обе функции работают с любыми «запросом» и «ремонтом».
 */

/** Ошибка Postgres так, как её отдаёт драйвер: с кодом и текстом. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

test("отставшая схема узнаётся и по коду Postgres, и по тексту", () => {
  assert.ok(isMissingSchema(pgError("42703", 'column "via_local" does not exist')));
  assert.ok(isMissingSchema(pgError("42P01", 'relation "sites" does not exist')));
  assert.ok(isMissingSchema(new Error('column sites.via_local does not exist')));
});

test("обычная поломка за отставшую схему не принимается", () => {
  // Иначе каждая опечатка в запросе гоняла бы миграцию и повторяла запрос,
  // пряча настоящую причину.
  assert.ok(!isMissingSchema(pgError("23505", "duplicate key value violates unique constraint")));
  assert.ok(!isMissingSchema(new Error("fetch failed")));
  assert.ok(!isMissingSchema(null));
  assert.ok(!isMissingSchema(undefined));
});

test("запрос с отставшей схемой чинится и повторяется сам", async () => {
  let attempts = 0;
  let repairs = 0;

  const value = await retryOnMissingSchema(
    async () => {
      attempts += 1;
      if (attempts === 1) throw pgError("42703", 'column "via_local" does not exist');
      return "площадки";
    },
    async () => {
      repairs += 1;
    },
  );

  assert.equal(value, "площадки");
  assert.equal(attempts, 2, "запрос должен повториться ровно один раз");
  assert.equal(repairs, 1);
});

test("удачный запрос схему не трогает", async () => {
  let repairs = 0;
  const value = await retryOnMissingSchema(
    async () => "площадки",
    async () => {
      repairs += 1;
    },
  );

  assert.equal(value, "площадки");
  assert.equal(repairs, 0, "миграция стоит запроса к базе — на каждом чтении она не нужна");
});

test("посторонняя ошибка уходит наверх как есть, без миграции", async () => {
  let repairs = 0;
  await assert.rejects(
    () =>
      retryOnMissingSchema(
        async () => {
          throw pgError("23505", "duplicate key");
        },
        async () => {
          repairs += 1;
        },
      ),
    /duplicate key/,
  );
  assert.equal(repairs, 0);
});

test("если и после ремонта та же ошибка — она доходит до человека, а не крутится по кругу", async () => {
  let attempts = 0;
  let repairs = 0;

  await assert.rejects(
    () =>
      retryOnMissingSchema(
        async () => {
          attempts += 1;
          throw pgError("42703", 'column "via_local" does not exist');
        },
        async () => {
          repairs += 1;
        },
      ),
    /via_local/,
  );

  assert.equal(attempts, 2);
  assert.equal(repairs, 1);
});

test("миграция идёт один раз на процесс, даже если её попросили все сразу", async () => {
  // На холодном старте в функцию влетает пачка запросов разом. Без общего
  // промиса каждый запустил бы свою миграцию: десяток параллельных ALTER TABLE
  // на одной таблице — это блокировки на ровном месте.
  let runs = 0;
  const guarded = once(async () => {
    runs += 1;
    await new Promise((done) => setTimeout(done, 10));
  });

  await Promise.all([guarded(), guarded(), guarded()]);
  await guarded();

  assert.equal(runs, 1);
});

test("неудачная миграция не запоминается как сделанная", async () => {
  // Иначе холодный старт с моргнувшей сетью выключал бы бота до самой
  // следующей выкладки: «уже мигрировали» — а колонки нет.
  let runs = 0;
  const guarded = once(async () => {
    runs += 1;
    if (runs === 1) throw new Error("сеть моргнула");
  });

  await assert.rejects(() => guarded(), /сеть моргнула/);
  await guarded();

  assert.equal(runs, 2, "вторая попытка должна была состояться");
});
