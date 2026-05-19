# line-history — architecture notes

A VS Code extension: the **Timeline experience, but for a single source
line** instead of the whole file. Per-line `git log -L` history in an
Explorer view, using VS Code's real commit-hover widget.

These notes explain the non-obvious design decisions so contributors don't
have to rediscover the constraints. Not shipped in the `.vsix`.

## Goal

Look and feel like the built-in **Timeline** view as closely as an extension
can — same view location, same hover widget, same multi-diff UI — scoped to
the line under the cursor. "What happened to *this line*", not the file.

## Design constraints

- **Pure JS, zero dependencies, no build step.** Intentional: the extension
  is small enough that a toolchain would add more surface than it removes.
- **The timestamp cannot be right-aligned.** A contributed `TreeView`
  renders icon + label + inline description only; the right side is an
  icon-only action bar. This is a known platform limitation
  ([microsoft/vscode#107183](https://github.com/microsoft/vscode/issues/107183),
  open since 2020). Timeline right-aligns its timestamp only because it is
  core (private tree renderer + internal hover service), which an extension
  cannot use. The relative time is therefore shown inline-dimmed after the
  author, de-duplicated on consecutive equal rows. A webview can do
  right-alignment but cannot reach the hover widget, so it is not used.
- **The hover is the platform widget, not a re-implementation.**
  `TreeItem.tooltip` is a `MarkdownString` filled lazily in
  `resolveTreeItem` — the same mechanism Timeline uses, so it renders in the
  same hover widget. Its content mirrors git's built-in commit hover
  field-for-field: gravatar (md5 of the commit email) + bold author in a
  mailto link, `$(history)` relative (absolute date via `toLocaleString`
  with year/month/day/hour/minute); `Co-authored-by:` trailers lifted out
  of the body into `$(account) **Name** _(Co-author)_` lines; message;
  shortstat in `--vscode-scmGraph-historyItemHover…` colours; a
  `$(git-commit) <sha>` (copy) | Open Commit | `$(github) Open on GitHub`
  command row (the GitHub link only when origin is a github.com remote).
- **No editor hover-provider.** Merged-popover section order is not
  controllable ([microsoft/vscode#152897](https://github.com/microsoft/vscode/issues/152897)),
  so the line history lives in the tree tooltip instead.

## Key technical facts

- `git log -L <n>,<n>:file` anchors its line range at **HEAD**, ignoring
  uncommitted edits. So the cursor's buffer line is first mapped to the
  corresponding HEAD line (`headLineFor`: a `git diff --no-index -U0` of
  HEAD's blob vs the live buffer text, cached per `document.version` so
  plain cursor moves cost nothing).
- **"Open Full Line History"** opens a native multi-diff where each block
  shows only the tracked line's hunk. The right side is the real
  `toGitUri(file@hash)` (real line numbers, working "Open File"); the left
  side is a `linehist:` virtual document — the same file with only the
  line's region reverted to the parent. The sole difference is that one
  hunk; the rest is byte-identical and collapses via
  `diffEditor.hideUnchangedRegions`. (Whole-file diffs would also show the
  commit's other changes; slicing the content would break line numbers and
  "Open File" — hence the composite.)
- The listing **stops at the commit that introduced the line** (parent side
  of the `@@` hunk empty). Beyond that, `git log -L` reports a blame-style
  lineage onto unrelated ancestor text — that is the tool's definition, not
  this extension's choice; Timeline behaves the same.
- `fromNow()` is ported verbatim from VS Code's `vs/base/common/date.ts`
  (fixed buckets — a month is 30 days — so e.g. 35 days reads "1 mo", not
  git's "5 weeks"). Keep it faithful to that source.

## Development

- Press <kbd>F5</kbd> ("Run Extension") for an Extension Development Host
  with the extension loaded from source; edit `extension.js` and reload the
  dev host to iterate. No build, no packaging.
- Sanity-check a change with `node --check extension.js` (parses only;
  `require('vscode')` is not executed).
- See `RELEASING.md` for packaging and the (not-yet-done) publish steps.
- The extension is intentionally described relative to Timeline throughout —
  keep that framing.
