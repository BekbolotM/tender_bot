#!/bin/bash
#
# Включает автоматический сбор: каждые 15 минут компьютер сам скачивает
# страницы площадок и отдаёт их боту.
#
#   bash scripts/install-collector.sh
#
# Запускать повторно безопасно: скрипт просто перезаписывает настройку.
# sudo не нужен — всё делается внутри домашней папки.
#
# Порядок здесь важен: сначала скрипт убеждается, что бот отвечает и узнаёт
# секрет, и только потом говорит «Готово». Иначе слово «Готово» стояло бы над
# настройкой, которая молча падает каждые 15 минут, а человек узнавал бы об
# этом только по тому, что тендеры не приходят.

set -euo pipefail

LABEL="kg.tenderbot.collector"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env.local"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
LOG_OUT="$LOG_DIR/tender-collector.log"
LOG_ERR="$LOG_DIR/tender-collector.err.log"
INTERVAL_SECONDS=900

fail() {
  echo "$@" >&2
  exit 1
}

# --- проверки, без которых установка бессмысленна ------------------------

if [ ! -f "$PROJECT_DIR/package.json" ] || [ ! -f "$PROJECT_DIR/scripts/collector.ts" ]; then
  fail "Не нахожу проект в $PROJECT_DIR — запустите скрипт из папки проекта."
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "На компьютере нет Node.js — без него сбор работать не сможет." >&2
  echo "Скачайте установщик (кнопка LTS) с https://nodejs.org, запустите его," >&2
  fail "закройте окно Терминала, откройте заново и повторите эту команду."
fi

NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"

if [ ! -f "$ENV_FILE" ]; then
  echo "Нет файла .env.local в $PROJECT_DIR." >&2
  echo "Создайте его и впишите адрес бота — выполните по очереди:" >&2
  echo "  cd \"$PROJECT_DIR\"" >&2
  echo "  cp -n .env.example .env.local" >&2
  echo "  open -e .env.local" >&2
  fail "Затем добавьте строку BOT_URL=https://ваш-адрес и запустите эту команду снова."
fi

# Файл с секретом читаем только мы: он лежит в домашней папке, а на общем Mac
# домашняя папка соседям видна.
chmod 600 "$ENV_FILE" 2>/dev/null || true

# Значение из .env.local. При двух строках с одним именем берём последнюю —
# так же, как это делает сам сборщик, иначе проверка и запуск разошлись бы.
env_value() {
  local name="$1" line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$ENV_FILE" | tail -n 1 || true)"
  [ -z "$line" ] && return 0

  line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/^export[[:space:]]*//')"
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

  case "$value" in
    '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
    "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

BOT_URL="$(env_value BOT_URL)"
# INGEST_SECRET умеет ровно одно — прислать боту страницу. CRON_SECRET остаётся
# запасным вариантом ради уже настроенных установок.
SECRET="$(env_value INGEST_SECRET)"
[ -z "$SECRET" ] && SECRET="$(env_value CRON_SECRET)"

if [ -z "$BOT_URL" ]; then
  echo "В файле .env.local нет строки BOT_URL — без неё сборщик не знает, куда слать страницы." >&2
  echo "Откройте файл командой:  open -e \"$ENV_FILE\"" >&2
  fail "и добавьте строку:  BOT_URL=https://tenderbot-blond.vercel.app"
fi

if [ -z "$SECRET" ]; then
  echo "В файле .env.local нет ни строки INGEST_SECRET, ни строки CRON_SECRET." >&2
  echo "Откройте файл командой:  open -e \"$ENV_FILE\"" >&2
  fail "и добавьте INGEST_SECRET с тем же значением, что записано в настройках проекта на сервере."
fi

# Секрет уходит в заголовке запроса, а заголовки умеют только латиницу: русская
# буква роняет сам запрос ещё до сети, и человек читает нечитаемое сообщение.
if printf '%s' "$SECRET" | LC_ALL=C grep -q '[^ -~]'; then
  echo "В секрете есть русские буквы или другие непечатные знаки — такой секрет отправить нельзя." >&2
  echo "Придумайте новый из латинских букв и цифр — вот команда, которая его создаёт:" >&2
  echo "  openssl rand -hex 32" >&2
  echo "Запишите одно и то же значение и в файл (open -e \"$ENV_FILE\"), и в настройки проекта на сервере." >&2
  fail "Сбор не включён."
fi

# Хвостовые слэши мешают склеить адрес маршрута.
BOT_URL="${BOT_URL%"${BOT_URL##*[!/]}"}"

# Без https секрет пошёл бы по сети открытым текстом — его прочитал бы любой
# сосед по вай-фаю. Свой же компьютер исключение: там сети нет.
case "$BOT_URL" in
  http://localhost*|http://127.0.0.1*|http://\[::1\]*) ;;
  http://*)
    echo "Строка BOT_URL начинается с http:// — так секрет уйдёт по сети открытым текстом." >&2
    fail "Исправьте её на https:// в файле: open -e \"$ENV_FILE\"" ;;
  https://*) ;;
  *)
    echo "Строка BOT_URL должна начинаться с https:// — сейчас там: $BOT_URL" >&2
    fail "Исправьте её в файле: open -e \"$ENV_FILE\"" ;;
esac

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Не хватает служебных файлов проекта. Выполните по очереди:" >&2
  echo "  cd \"$PROJECT_DIR\"" >&2
  fail "  npm install"
fi

# --- проверка связи с ботом: до установки, а не после --------------------

echo "Проверяю связь с ботом ($BOT_URL)…"

JOBS_FILE="$(mktemp -t tender-collector)"
trap 'rm -f "$JOBS_FILE"' EXIT

HTTP_CODE="$(
  curl -sS --max-time 25 \
    -H "authorization: Bearer $SECRET" \
    -H "accept: application/json" \
    -o "$JOBS_FILE" -w '%{http_code}' \
    "$BOT_URL/api/ingest" 2>/dev/null || printf '000'
)"

case "$HTTP_CODE" in
  200) ;;
  401)
    echo "Бот не узнал секрет: строка INGEST_SECRET (или CRON_SECRET) в .env.local" >&2
    echo "не совпадает с той, что записана в настройках проекта на сервере." >&2
    echo "Откройте файл и сверьте значение:  open -e \"$ENV_FILE\"" >&2
    fail "Сбор не включён — исправьте строку и запустите эту команду снова." ;;
  000)
    echo "Бот не ответил по адресу $BOT_URL." >&2
    echo "Проверьте интернет и строку BOT_URL в файле:  open -e \"$ENV_FILE\"" >&2
    fail "Сбор не включён — исправьте и запустите эту команду снова." ;;
  404)
    echo "По адресу $BOT_URL бот есть, но приёма страниц там нет (ответ 404)." >&2
    echo "Скорее всего, на сервер ещё не выложена свежая версия бота." >&2
    fail "Сбор не включён — выложите её и запустите эту команду снова." ;;
  *)
    echo "Бот ответил кодом $HTTP_CODE вместо списка площадок." >&2
    fail "Сбор не включён — повторите позже или проверьте, работает ли бот." ;;
esac

# Пустой список — не поломка, но и не работа: качать нечего, потому что в боте
# ещё не добавлена ни одна площадка домашнего сбора. Скажем об этом словами,
# иначе человек будет неделю ждать тендеров от установленной и пустой настройки.
NO_SITES=0
if grep -qE '^[[:space:]]*\[[[:space:]]*\][[:space:]]*$' "$JOBS_FILE"; then
  NO_SITES=1
fi

# --- сама установка ------------------------------------------------------

mkdir -p "$AGENTS_DIR" "$LOG_DIR"

# В файле настройки пути лежат внутри XML: пара символов там значит другое.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

PROJECT_XML="$(xml_escape "$PROJECT_DIR")"
NPM_XML="$(xml_escape "$NPM_BIN")"
PATH_XML="$(xml_escape "$NODE_DIR:/usr/local/bin:/usr/bin:/bin")"
LOG_OUT_XML="$(xml_escape "$LOG_OUT")"
LOG_ERR_XML="$(xml_escape "$LOG_ERR")"

# Если настройка уже стояла — снимаем её, иначе новая не подхватится.
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NPM_XML</string>
        <string>--silent</string>
        <string>run</string>
        <string>collect</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_XML</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$PATH_XML</string>
    </dict>
    <key>StartInterval</key>
    <integer>$INTERVAL_SECONDS</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_OUT_XML</string>
    <key>StandardErrorPath</key>
    <string>$LOG_ERR_XML</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

# `launchctl load` возвращает 0 даже когда загрузка провалилась, поэтому его
# ответ ни о чём не говорит — верим только списку заданий ниже.
launchctl load -w "$PLIST" >/dev/null 2>&1 || true

if ! launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "Не включилось: система не приняла настройку автоматического запуска." >&2
  echo "Так бывает, когда в системных настройках запрещён фоновый запуск программ:" >&2
  echo "  Системные настройки → Основные → Объекты входа → «Разрешить в фоне»." >&2
  echo "Разрешите там Terminal (или Node) и запустите эту команду снова." >&2
  echo >&2
  echo "Пока сбор не включён, его можно запускать руками:" >&2
  fail "  cd \"$PROJECT_DIR\" && npm run collect"
fi

# --- итог: печатаем только после успешной проверки -----------------------

echo "Готово. Сбор включён: каждые $((INTERVAL_SECONDS / 60)) минут."
echo
echo "Папка проекта: $PROJECT_DIR"

if [ "$NO_SITES" = "1" ]; then
  echo
  echo "Но качать пока нечего: в боте не добавлена ни одна площадка,"
  echo "которую нужно читать с этого компьютера."
  echo "Откройте бота в Telegram, напишите ему /menu и нажмите по очереди:"
  echo "«🌐 Сайты» → «⭐ Готовые площадки» →"
  echo "«Все тендеры Кыргызстана (procurement.kg)» → «➕ Добавить»."
  echo "После этого сбор начнёт работать сам, ничего переустанавливать не нужно."
fi

echo
echo "Пробный сбор прямо сейчас:"
COLLECT_LOG="$(mktemp -t tender-collect-run)"
trap 'rm -f "$JOBS_FILE" "$COLLECT_LOG"' EXIT
( cd "$PROJECT_DIR" && npm --silent run collect ) >"$COLLECT_LOG" 2>&1 || true
sed -e 's/^/  /' "$COLLECT_LOG" | tail -n 20

echo
echo "Посмотреть, что происходит:"
echo "  tail -n 40 \"$LOG_OUT\""
echo
echo "Посмотреть ошибки:"
echo "  tail -n 40 \"$LOG_ERR\""
echo
echo "Запустить сбор вручную:"
echo "  cd \"$PROJECT_DIR\" && npm run collect"
echo
echo "Выключить:"
echo "  bash \"$PROJECT_DIR/scripts/uninstall-collector.sh\""
