# Line History

The VS Code **Timeline** experience, but for a **single source line** instead
of the whole file. Same Explorer view, same native commit hover, same
multi-diff — scoped to the line under your cursor and its `git log -L`
history. The goal is explicitly to look and feel like Timeline as much as
possible, just per-line.

## What it does

- **Explorer view "Line History"** follows the cursor and lists every commit
  that touched the current line (`git log -L`). Newest first.
- **Commit hover** is the *real* VS Code hover widget — the same one
  Timeline uses (`TreeItem.tooltip`, resolved lazily via `resolveTreeItem`),
  with the same content as git's commit hover: gravatar + author (mailto),
  co-authors, relative + absolute date, message, shortstat, and a
  `$(git-commit) <sha>` (copy) · Open Commit · Open on GitHub command row
  (the GitHub link only when the repo has a github.com remote).
- **Click a row** → that revision's diff, scrolled to the line.
- **Inline "Open Commit"** (hover a row) → the whole commit as a native
  multi-file diff.
- **Title "Open Full Line History"** → a native multi-diff with **only the
  tracked line's hunk** per commit (everything else collapses away), stopping
  at the commit that introduced the line.
- **Command Palette: _Line History: Show for Current Line_** → quick-pick of
  the revisions, as a secondary surface.

The cursor's buffer line (including unsaved edits) is mapped to the
corresponding HEAD line before querying git, so it stays correct on a dirty
buffer.

Backed entirely by `git` + the built-in `vscode.git` API (`toGitUri`). Pure
JS, zero dependencies, no build step.

## Relation to Timeline

VS Code's built-in Timeline shows the commit history of the **whole file**.
This shows the commit history of **one line** — the same view location, the
same hover widget, the same multi-diff UI, deliberately mirrored so it feels
native. Where Timeline answers "what happened to this file", Line History
answers "what happened to *this line*". Nothing more — deliberately small.

Note: a contributed tree view cannot right-align the timestamp the way
Timeline does
([microsoft/vscode#107183](https://github.com/microsoft/vscode/issues/107183),
open since 2020). The time is shown inline-dimmed after the author instead.

## Settings

- `lineHistory.maxRevisions` — max revisions listed per line (default `10`).

## Development

Pure JS — no build. Press <kbd>F5</kbd> ("Run Extension") to launch an
Extension Development Host with the extension loaded; edit `extension.js` and
restart the host to iterate. See [RELEASING.md](RELEASING.md) for packaging.

## License

MIT © Thimo Jansen
