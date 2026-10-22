#!/usr/bin/env bash
# Installs the git pre-commit hook that scans staged changes for secrets with gitleaks
# (.gitleaks.toml: the default rules plus Bunny.net keys). Once per clone; worktrees share it.
#
#   mise install && tools/scripts/install-hooks.sh
set -euo pipefail

marker='# Written by tools/scripts/install-hooks.sh'
hooks="$(git rev-parse --path-format=absolute --git-path hooks)"
hook="$hooks/pre-commit"

if [ -e "$hook" ] && ! grep -qxF "$marker" "$hook"; then
  echo "install-hooks.sh: $hook exists and wasn't written by this script; merge it by hand" >&2
  exit 1
fi

mkdir -p "$hooks"
cat > "$hook" << HOOK
#!/usr/bin/env bash
$marker
command -v gitleaks > /dev/null || {
  echo "gitleaks not found: run mise install" >&2
  exit 1
}
exec gitleaks git --pre-commit --staged --redact --no-banner --config "\$(git rev-parse --show-toplevel)/.gitleaks.toml"
HOOK
chmod +x "$hook"
echo "install-hooks.sh: installed $hook"
