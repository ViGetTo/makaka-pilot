#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
if [[ -z "${PREFIX:-}" || "$PREFIX" != *com.termux* ]]; then
  printf 'Запусти этот установщик внутри обычного Termux.\n'
  exit 1
fi
pkg update -y
pkg install -y git nodejs-lts x11-repo util-linux
pkg install -y chromium
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$repo_dir"
npm ci --ignore-scripts --no-audit --no-fund
sha256sum package-lock.json | cut -d ' ' -f 1 > node_modules/.makaka-deps
mkdir -p "$PREFIX/bin"
printf -v escaped_repo '%q' "$repo_dir"
{
  printf '#!%s/bin/bash\n' "$PREFIX"
  printf 'export MAKAKA_REPO_DIR=%s\n' "$escaped_repo"
  printf 'exec bash "$MAKAKA_REPO_DIR/makaka.sh" "$@"\n'
} > "$PREFIX/bin/makaka"
chmod 700 "$PREFIX/bin/makaka"
printf '\nГотово. Первый вход: makaka login\nЗапуск: makaka\nНастройки: makaka config\n'
