#!/bin/bash
#
# Выключает автоматический сбор. Проект и логи остаются на месте.
#
#   bash scripts/uninstall-collector.sh
#
# Запускать повторно безопасно. sudo не нужен.

set -euo pipefail

LABEL="kg.tenderbot.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

if [ ! -f "$PLIST" ]; then
  echo "Автоматический сбор и так выключен — настройки нет."
  exit 0
fi

launchctl unload -w "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Готово. Автоматический сбор выключен."
echo
echo "Логи никуда не делись:"
echo "  $LOG_DIR/tender-collector.log"
echo "  $LOG_DIR/tender-collector.err.log"
echo
echo "Включить обратно:"
echo "  bash \"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-collector.sh\""
