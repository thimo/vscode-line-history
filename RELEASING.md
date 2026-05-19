# Releasing

Pure-JS extension — no build, no bundler. Two workflows.

## Day-to-day development (no version bump)

Press <kbd>F5</kbd> in this project ("Run Extension") → a second VS Code
window (Extension Development Host) opens with the extension loaded from
source. Edit `extension.js`, then in the dev host run **Developer: Reload
Window** (or restart F5) to pick up changes. No packaging, no install, no
version bump.

Legacy fallback (the loop used before this became its own project): copy
`extension.js` / `package.json` into the installed folder
`~/.vscode/extensions/thimo.line-history-0.1.3/` and reload the main window.
Only needed if you want the change live in your normal editor without F5.

## Cutting a release (.vsix)

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm run package` (wraps
   `vsce package --allow-missing-repository --no-dependencies`).
3. Install locally to verify: `code --install-extension line-history-<v>.vsix --force`.

## Publishing to the Marketplace (when ready)

Not yet published. Before the first publish:

- Set a real `publisher` (currently `thimo`) and create the matching
  publisher in the [VS Code Marketplace](https://marketplace.visualstudio.com/manage).
- Flip `"private": false` in `package.json`.
- Add a `repository` field (and drop `--allow-missing-repository`).
- `vsce publish` (or `ovsx publish` for Open VSX).

Commits are local only — never pushed automatically.
