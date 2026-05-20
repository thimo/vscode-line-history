#!/usr/bin/env bash
# Release automation for line-history.
#
# Usage:
#   scripts/release.sh <version> [flags]
#
# Flags:
#   --skip-smoke-test   Skip the manual smoke-test confirmation prompt
#   --no-marketplace    Skip the VS Code Marketplace publish step
#   --dry-run           Print every command without executing
#   -h, --help          Show this help
#
# Steps (mirrors RELEASING.md):
#   1. Pre-flight: clean tree, on main, fast-forward, CHANGELOG ## Unreleased non-empty, gh logged in
#   2. Bump package.json + date-stamp `## Unreleased` in CHANGELOG.md
#   3. Commit, tag, build .vsix
#   4. Pause for smoke test (unless --skip-smoke-test)
#   5. Publish to VS Code Marketplace (unless --no-marketplace)
#   6. Push main + tag to origin
#   7. Create GitHub release with .vsix attached
#
# The smoke-test pause is the last reversible point. After confirmation the
# script publishes externally; failures past that point are recoverable
# (re-run individual steps) but irreversible (you can't unpublish).

set -euo pipefail

VERSION=""
SKIP_SMOKE=false
NO_MARKETPLACE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-smoke-test) SKIP_SMOKE=true; shift ;;
		--no-marketplace) NO_MARKETPLACE=true; shift ;;
		--dry-run) DRY_RUN=true; shift ;;
		-h|--help)
			sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		-*)
			echo "Unknown flag: $1" >&2
			exit 1
			;;
		*)
			if [[ -n "$VERSION" ]]; then
				echo "Version specified twice: $VERSION and $1" >&2
				exit 1
			fi
			VERSION="$1"; shift
			;;
	esac
done

if [[ -z "$VERSION" ]]; then
	echo "Usage: $0 <version> [--skip-smoke-test] [--no-marketplace] [--dry-run]" >&2
	exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Version must be X.Y.Z (got: $VERSION)" >&2
	exit 1
fi

run() {
	echo "+ $*"
	if ! $DRY_RUN; then
		"$@"
	fi
}

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

VSIX="line-history-$VERSION.vsix"

# === 1. Pre-flight ===
echo "==> Pre-flight"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" ]]; then
	echo "Must be on main (currently on $current_branch)" >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	if $DRY_RUN; then
		echo "(dry-run: ignoring dirty tree)"
	else
		echo "Working tree must be clean. git status:" >&2
		git status --short >&2
		exit 1
	fi
fi

current_version=$(node -p "require('./package.json').version")

# Resume detection: if a previous run got past bump+commit+tag+package but
# bailed before marketplace publish (e.g. vsce rejected the manifest, gh was
# down), re-running with the same version should pick up where it stopped
# rather than re-bumping. Local artifacts (commit, tag, .vsix) are the
# evidence; the tag absence on origin proves nothing got pushed yet.
RESUMING=false
if [[ "$current_version" == "$VERSION" ]]; then
	if git rev-parse "v$VERSION" >/dev/null 2>&1 && [[ -f "$VSIX" ]]; then
		if git ls-remote --tags origin "v$VERSION" 2>/dev/null | grep -q "refs/tags/v$VERSION$"; then
			echo "Tag v$VERSION already on origin — release already published. Nothing to do." >&2
			exit 1
		fi
		RESUMING=true
		echo "==> Resuming in-progress release of $VERSION (commit, tag, $VSIX all in place)"
	else
		echo "package.json is already at $VERSION but tag or $VSIX missing — partial state, fix manually" >&2
		exit 1
	fi
else
	if git rev-parse "v$VERSION" >/dev/null 2>&1; then
		echo "Tag v$VERSION already exists locally but package.json is at $current_version — inconsistent" >&2
		exit 1
	fi

	if git ls-remote --tags origin "v$VERSION" 2>/dev/null | grep -q "refs/tags/v$VERSION$"; then
		echo "Tag v$VERSION already exists on origin" >&2
		exit 1
	fi

	if ! grep -q "^## Unreleased" CHANGELOG.md; then
		echo "CHANGELOG.md must have a '## Unreleased' section. Write release notes there first." >&2
		exit 1
	fi

	unreleased_body=$(awk '/^## Unreleased/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md | sed '/^[[:space:]]*$/d')
	if [[ -z "$unreleased_body" ]]; then
		echo "CHANGELOG.md '## Unreleased' section is empty — write entries first." >&2
		exit 1
	fi
fi

if ! command -v gh >/dev/null 2>&1; then
	echo "gh CLI not found in PATH. brew install gh" >&2
	exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
	echo "gh CLI not authenticated. Run: gh auth login" >&2
	exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
	echo "npx not found in PATH" >&2
	exit 1
fi

# Parse sanity. Pure JS, no build, so `node --check` is the whole "compile" step.
run node --check extension.js

# Icon PNG must reflect the current SVG. Compare a fresh render against the
# committed PNG byte-for-byte so a stale icon can't sneak into a release.
if command -v rsvg-convert >/dev/null 2>&1; then
	tmp_png=$(mktemp -t line-history-icon.XXXXXX).png
	trap 'rm -f "$tmp_png"' EXIT
	run rsvg-convert -w 1024 -h 1024 media/icon.svg -o "$tmp_png"
	if ! $DRY_RUN; then
		if ! cmp -s "$tmp_png" media/icon.png; then
			echo "media/icon.png is out of sync with media/icon.svg." >&2
			echo "Regenerate with: rsvg-convert -w 1024 -h 1024 media/icon.svg -o media/icon.png" >&2
			exit 1
		fi
	fi
else
	echo "(skipping icon-sync check: rsvg-convert not installed)"
fi

run git pull --ff-only

if ! $RESUMING; then
	# === 2. Bump ===
	echo "==> Bumping to $VERSION ($(date +%Y-%m-%d))"

	today=$(date +%Y-%m-%d)

	if ! $DRY_RUN; then
		# Regex-replace only the "version" value so package.json formatting
		# (indentation, key order, trailing newline) stays byte-for-byte.
		node -e "
			const fs = require('fs');
			const path = './package.json';
			const raw = fs.readFileSync(path, 'utf8');
			const updated = raw.replace(/\"version\":\s*\"[^\"]+\"/, '\"version\": \"' + process.argv[1] + '\"');
			fs.writeFileSync(path, updated);
		" "$VERSION"

		python3 - "$VERSION" "$today" <<'PY'
import re, sys
version, today = sys.argv[1], sys.argv[2]
path = 'CHANGELOG.md'
with open(path) as f:
    text = f.read()
new = f'## [{version}] — {today}'
text, n = re.subn(r'^## Unreleased[ \t]*$', new, text, count=1, flags=re.MULTILINE)
if n == 0:
    sys.exit("Could not find '## Unreleased' line to replace")
with open(path, 'w') as f:
    f.write(text)
PY
	fi

	# === 3. Commit, tag, package ===
	echo "==> Commit + tag + package"

	run git add package.json CHANGELOG.md
	run git commit -m "Release $VERSION"
	run git tag "v$VERSION"

	run npx vsce package --no-dependencies --out "$VSIX"

	if [[ ! -f "$VSIX" && "$DRY_RUN" == "false" ]]; then
		echo "Expected $VSIX to be produced by vsce package" >&2
		exit 1
	fi
fi

# === 4. Smoke test pause ===
if ! $SKIP_SMOKE; then
	cat <<EOF

==> Smoke test (manual)

  1. code --install-extension $VSIX --force
  2. Reload your VS Code window so the new build is loaded.
  3. Open a tracked file, place the cursor on a line, confirm the
     Line History view populates with the right hover and that
     "Open Full Line History" still renders the line-only multi-diff.

If something is wrong, abort here and roll back with:
  git tag -d v$VERSION
  git reset --hard HEAD~1
  trash $VSIX

EOF
	read -r -p "Smoke test passed? Continue with marketplace + push + GitHub release? [y/N] " ans
	if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
		echo "Aborted before publish. Local commit + tag + .vsix retained." >&2
		exit 1
	fi
fi

# === 5. Marketplace ===
# Marketplace publish runs before git push: if vsce rejects the .vsix
# (PAT expired, manifest issue) we want to find out before the tag is on origin.
if ! $NO_MARKETPLACE; then
	echo "==> Publishing to VS Code Marketplace"
	run npm run publish:marketplace -- --packagePath "$VSIX"
else
	echo "==> Skipping marketplace publish (--no-marketplace)"
fi

# === 6. Push ===
echo "==> Pushing main + tag to origin"
run git push origin main
run git push origin "v$VERSION"

# === 7. GitHub release ===
echo "==> Creating GitHub release"

notes=$(mktemp)
trap 'rm -f "$notes" "${tmp_png:-}"' EXIT

if ! $DRY_RUN; then
	python3 - "$VERSION" "$notes" <<'PY'
import re, sys
version, notes_path = sys.argv[1], sys.argv[2]
with open('CHANGELOG.md') as f:
    text = f.read()
pattern = r'^## \[' + re.escape(version) + r'\][^\n]*\n(.*?)(?=^## \[|\Z)'
m = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL)
body = (m.group(1) if m else '').strip()
if not body:
    sys.exit(f"Could not find CHANGELOG section for {version}")
with open(notes_path, 'w') as f:
    f.write(body + '\n')
PY
fi

run gh release create "v$VERSION" "$VSIX" \
	--title "v$VERSION" \
	--notes-file "$notes"

# === Done ===
cat <<EOF

==> Done

  Marketplace:  https://marketplace.visualstudio.com/items?itemName=thimo.line-history
  GitHub:       https://github.com/thimo/vscode-line-history/releases/tag/v$VERSION

EOF
