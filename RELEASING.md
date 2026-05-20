# Releasing

Pure-JS extension — no build, no bundler. The release script does the
ceremony; this file documents what it does and the one-time setup.

## Versioning (SemVer)

- **Patch** `0.1.x` — bug fixes, no surface change
- **Minor** `0.x.0` — new commands, settings, or visible behaviour
- **Major** `x.0.0` — breaking changes (e.g. removed settings, renamed view id)

## One-time setup

- VS Code Marketplace publisher `thimo` already exists (used by other
  extensions). No new publisher to create.
- Personal Access Token for `vsce` with *Marketplace → Manage* scope, stored
  via `vsce login thimo`. See [the vsce docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).
- `gh` CLI logged in (`gh auth status`).

## Day-to-day development (no version bump)

Press <kbd>F5</kbd> ("Run Extension") → an Extension Development Host opens
with the extension loaded from source. Edit `extension.js`, then in the dev
host run **Developer: Reload Window** to pick up changes. No packaging.

`node --check extension.js` for a quick parse-only sanity check.

## Automated release

Write release notes under `## Unreleased` in `CHANGELOG.md` first — the
script bails if that section is missing or empty. Lean verbose; explain the
*why* of each change, not just the *what*.

Then:

```bash
npm run release -- 0.1.4
```

That single command runs the full flow: pre-flight checks, version bump,
CHANGELOG date-stamp, commit, tag, `.vsix` build, smoke-test pause,
marketplace publish, `git push`, GitHub release with the `.vsix` attached.

The smoke-test pause is the last reversible point — once you confirm, the
script publishes externally.

### Flags

- `--skip-smoke-test` — skip the manual confirmation prompt
- `--no-marketplace` — skip the marketplace publish step (useful when
  iterating on a release that's already up)
- `--dry-run` — print every command without executing

### Rolling back before push

If the smoke test fails, abort at the prompt. Local state is recoverable:

```bash
git tag -d v0.1.4
git reset --hard HEAD~1
trash line-history-0.1.4.vsix
```

### Rolling back after push

You can't unpublish from the marketplace (only deprecate). For GitHub:

```bash
gh release delete v0.1.4
git push origin :refs/tags/v0.1.4
git tag -d v0.1.4
```

Don't `git reset` published commits — push a follow-up fix instead.

## Manual flow (reference)

The script just automates this. Useful when the script breaks or you need
to do partial work.

```bash
git switch main
git pull --ff-only
node --check extension.js
```

1. `package.json` → `"version"`
2. `CHANGELOG.md` → `## Unreleased` becomes `## [X.Y.Z] — YYYY-MM-DD`

```bash
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
npx vsce package --no-dependencies --out line-history-X.Y.Z.vsix
```

Smoke test:

```bash
code --install-extension line-history-X.Y.Z.vsix --force
```

Reload your VS Code window. Open a tracked file, place the cursor on a
line, confirm the Line History view populates with the right hover and
that "Open Full Line History" renders the line-only multi-diff.

```bash
npm run publish:marketplace -- --packagePath line-history-X.Y.Z.vsix
git push origin main
git push origin vX.Y.Z

gh release create vX.Y.Z line-history-X.Y.Z.vsix \
  --title "vX.Y.Z" \
  --notes-file <(awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md)
```

The `awk` pulls the just-released CHANGELOG section as the release body
(escape the dots in the version). The `.vsix` is attached so users who
don't use the marketplace (or want to pin a version) can install it
manually.

## Verify

- Marketplace listing shows the new version: <https://marketplace.visualstudio.com/items?itemName=thimo.line-history>
- GitHub release is "Latest": <https://github.com/thimo/vscode-line-history/releases>
- README renders correctly on the repo home
