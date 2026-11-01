#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
git init -q -b main "$test_dir/upstream"
git -C "$test_dir/upstream" config user.email test@example.invalid
git -C "$test_dir/upstream" config user.name test
cp "$root/makaka.sh" "$test_dir/upstream/"
printf '{}\n' > "$test_dir/upstream/package-lock.json"
printf 'v1\n' > "$test_dir/upstream/version"
git -C "$test_dir/upstream" add .
git -C "$test_dir/upstream" commit -qm first
git clone -q "$test_dir/upstream" "$test_dir/client"
mkdir "$test_dir/stubs"
cat > "$test_dir/stubs/node" <<'NODE'
#!/usr/bin/env bash
cat "$MAKAKA_REPO_DIR/version"
NODE
cat > "$test_dir/stubs/npm" <<'NPM'
#!/usr/bin/env bash
mkdir -p node_modules
NPM
chmod +x "$test_dir/stubs/"*
export PATH="$test_dir/stubs:$PATH" MAKAKA_REPO_DIR="$test_dir/client"
bash "$root/makaka.sh" > "$test_dir/first"
grep -q v1 "$test_dir/first"
printf 'v2\n' > "$test_dir/upstream/version"
git -C "$test_dir/upstream" commit -qam update
bash "$root/makaka.sh" > "$test_dir/second"
grep -q v2 "$test_dir/second"
printf 'local-edit\n' > "$test_dir/client/version"
if bash "$root/makaka.sh" > /dev/null 2>&1; then echo 'FAIL: overwritten dirty checkout'; exit 1; fi
grep -q local-edit "$test_dir/client/version"
git -C "$test_dir/client" restore version
git -C "$test_dir/client" remote set-url origin "$test_dir/no-such-repository"
if bash "$root/makaka.sh" > /dev/null 2>&1; then echo 'FAIL: update failure was hidden'; exit 1; fi
bash "$root/makaka.sh" --offline > "$test_dir/offline"
grep -q v2 "$test_dir/offline"
echo 'PASS: update, local edits, network failure and explicit offline mode'
