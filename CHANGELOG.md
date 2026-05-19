# Changelog

All notable changes to the Line History extension.

## [Unreleased]

Split out into its own repository. No functional change vs the installed
0.1.3 build; project scaffolding added (LICENSE, README, this changelog,
F5 launch config). Version stays `0.1.3` until the first published release.

## [0.1.3] — 2026-05-19

The state at repository extraction. Pure JS, zero dependencies, no build.

- **Explorer TreeView** "Line History" following the cursor (250 ms
  debounce, visibility-gated, stale-token guard).
- **Commit hover** = the real VS Code hover widget via `TreeItem.tooltip`
  resolved lazily in `resolveTreeItem`; content mirrors git's
  `getCommitHover` (account/author mailto, `$(history)` relative + absolute
  date, message, rule, shortstat in `scmGraph` hover colours, `[Open
  Commit]` link).
- **Row click** → that revision's diff, scrolled to the line.
- **Inline "Open Commit"** action (`$(diff-multiple)`) → whole commit as a
  native multi-file diff.
- **"Open Full Line History"** title action → native multi-diff showing
  only the tracked line's hunk per commit (composite virtual `linehist:`
  document; the rest collapses via `diffEditor.hideUnchangedRegions`);
  stops at the commit that introduced the line.
- **Buffer→HEAD line mapping** so the query stays correct on a dirty buffer
  (`git log -L` anchors at HEAD); cached per document version.
- `fromNow()` ported verbatim from VS Code's `vs/base/common/date.ts`
  (fixed buckets — 35 days reads "1 mo", not git-relative's "5 wks").
- Setting `lineHistory.maxRevisions` (default 10).

This is the first tagged version; earlier iteration happened in a private
monorepo and is not part of this repository's history.
