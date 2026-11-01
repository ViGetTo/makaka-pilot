#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077
# Read the complete function before Git can replace this launcher on disk.
main() {
  repo_dir="${MAKAKA_REPO_DIR:-$HOME/makaka-pilot}"
  command_name="${1:-start}"
  offline=0
  if [[ "$command_name" == --offline ]]; then
    offline=1
    shift
    command_name="${1:-start}"
  fi
  cd "$repo_dir"
  if [[ "$command_name" != status && "$command_name" != stop ]]; then
    exec 9> .makaka-update.lock
    flock -w 60 9 || { printf 'Другая команда обновляет скрипт. Повтори позже.\n'; exit 1; }
    if [[ "$offline" == 0 ]]; then
      printf 'Проверяю обновления GitHub…\n'
      if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        printf 'В коде есть местные изменения. Сохрани их перед обновлением. Для запуска без обновления: makaka --offline\n'
        exit 1
      fi
      git fetch --quiet origin main || { printf 'GitHub недоступен. Проверь сеть и gh auth status. Явный запуск прежней версии: makaka --offline\n'; exit 1; }
      git merge --ff-only --quiet origin/main || { printf 'Не удалось обновить без изменения истории. Местный код сохранён.\n'; exit 1; }
    fi
    lock_hash="$(sha256sum package-lock.json | cut -d ' ' -f 1)"
    if [[ ! -f node_modules/.makaka-deps || "$(cat node_modules/.makaka-deps)" != "$lock_hash" ]]; then
      npm ci --ignore-scripts --no-audit --no-fund
      printf '%s\n' "$lock_hash" > node_modules/.makaka-deps
    fi
    # Keep the lock until Node exits so another launch cannot replace live dependencies.
  fi
  exec node "$repo_dir/run.mjs" "$command_name"
}
main "$@"
