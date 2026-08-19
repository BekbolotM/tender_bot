/**
 * Payload команды /start прямо из текста сообщения.
 *
 * grammY кладёт его в ctx.match, но приглашение проверяется в middleware —
 * а оно отрабатывает раньше обработчиков команд. Правила разбора намеренно
 * повторяют grammY (Context.has.command): разойдись они, токен погас бы
 * в middleware, а обработчик /start не сработал бы, и приглашённый остался
 * бы админом без единого ответа бота.
 */

const COMMAND = "start";

/**
 * Возвращает текст после `/start` (или `/start@имя_бота`) либо null, если это
 * не наша команда. Имя бота нужно, чтобы не отвечать на команду, адресованную
 * в общем чате другому боту; без него адресную форму не принимаем.
 */
export function startPayload(
  text: string | undefined | null,
  botUsername?: string | null,
): string | null {
  if (!text) return null;

  // Командой Telegram считает только начало сообщения: у « /start» entity
  // стоит не в нулевом смещении, и grammY такое сообщение не берёт.
  const space = text.search(/\s/);
  const head = space === -1 ? text : text.slice(0, space);
  if (!head.startsWith("/")) return null;

  const parts = head.slice(1).split("@");
  // Имя команды Telegram и grammY сравнивают с учётом регистра.
  if (parts[0] !== COMMAND) return null;
  if (parts.length > 2) return null;

  if (parts.length === 2) {
    const me = (botUsername ?? "").trim().replace(/^@+/, "");
    if (!me || parts[1].toLowerCase() !== me.toLowerCase()) return null;
  }

  return text.slice(head.length).trim() || null;
}
