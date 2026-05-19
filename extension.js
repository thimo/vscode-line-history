"use strict";

const vscode = require("vscode");
const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

// git's hover shows a gravatar derived from the commit email (md5 of the
// lowercased, trimmed address). `d=retro` so addresses without a real
// gravatar still get a generated image, like Timeline.
function gravatarUrl(email) {
  const h = crypto
    .createHash("md5")
    .update(String(email).trim().toLowerCase())
    .digest("hex");
  return `https://www.gravatar.com/avatar/${h}?s=40&d=retro`;
}

/**
 * Line History — per-line git history.
 *
 * An Explorer TreeView that follows the cursor (debounced) and lists the
 * revisions touching the current line. The commit hover is the **real VS Code
 * hover widget**, reused (not rebuilt): TreeItem.tooltip = MarkdownString,
 * filled lazily in resolveTreeItem — exactly how Timeline does it. An inline
 * "Open Commit" action (diff-multiple codicon, the same icon Timeline's
 * git.timeline.viewCommit uses) opens the whole commit as a native
 * multi-file diff. Clicking a row opens that revision's diff, scrolled to
 * the line.
 *
 * Right-aligned time is deliberately NOT attempted: it is impossible for a
 * contributed TreeView (microsoft/vscode#107183, open since 2020 — even
 * GitLens can't). Time is inline-dimmed after the author, de-duplicated on
 * consecutive equal rows like Timeline.
 *
 * Data source: `git log -L <n>,<n>:<file>`. Pure JS, no dependencies. Uses
 * the built-in vscode.git API only to turn a commit into a diffable URI.
 */

function getGitApi() {
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext || !ext.isActive || !ext.exports || !ext.exports.enabled) {
    return undefined;
  }
  return ext.exports.getAPI(1);
}

const FS = "\x1f"; // unit separator — safe field delimiter for --format

function gitLogForLine(repoRoot, relPath, line, maxRevisions) {
  return new Promise((resolve) => {
    const args = [
      "log",
      "-L",
      `${line},${line}:${relPath}`,
      "--no-patch",
      "-n",
      String(maxRevisions),
      `--format=%H${FS}%h${FS}%an${FS}%ae${FS}%ct${FS}%s`,
    ];
    execFile(
      "git",
      args,
      { cwd: repoRoot, timeout: 4000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const revs = [];
        for (const raw of stdout.split("\n")) {
          const ln = raw.trim();
          if (!ln) continue;
          const [hash, short, author, email, ct, subject] = ln.split(FS);
          if (hash) {
            revs.push({
              hash,
              short,
              author,
              email,
              ts: Number(ct),
              subject,
            });
          }
        }
        resolve(revs);
      }
    );
  });
}

/**
 * Exact port of VS Code's `fromNow(date)` short form (the call Timeline
 * makes). Fixed-threshold buckets — a month is 30 days, a year 365 — so 35
 * days reads "1 mo", not git's "5 wks". Source: src/vs/base/common/date.ts.
 */
function fromNow(tsSeconds) {
  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  const year = day * 365;
  const seconds = Math.round(Date.now() / 1000 - tsSeconds);
  if (seconds < 30) return "now";
  let value;
  let words;
  if (seconds < minute) {
    value = seconds;
    words = ["sec", "secs"];
  } else if (seconds < hour) {
    value = Math.floor(seconds / minute);
    words = ["min", "mins"];
  } else if (seconds < day) {
    value = Math.floor(seconds / hour);
    words = ["hr", "hrs"];
  } else if (seconds < week) {
    value = Math.floor(seconds / day);
    words = ["day", "days"];
  } else if (seconds < month) {
    value = Math.floor(seconds / week);
    words = ["wk", "wks"];
  } else if (seconds < year) {
    value = Math.floor(seconds / month);
    words = ["mo", "mos"];
  } else {
    value = Math.floor(seconds / year);
    words = ["yr", "yrs"];
  }
  return `${value} ${value === 1 ? words[0] : words[1]}`;
}

const LH_SCHEME = "linehist";

function gitShowFile(root, ref, rel) {
  if (!ref) return Promise.resolve("");
  return new Promise((resolve) => {
    execFile(
      "git",
      ["show", `${ref}:${rel}`],
      { cwd: root, timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

/**
 * Left side of a line-scoped block: the file at `hash`, but with the tracked
 * line's region reverted to the parent's version (or that region removed if
 * the commit added it). The ONLY difference vs the real file@hash is the
 * line's hunk — everything else is byte-identical, so VS Code collapses it
 * and the block shows just that line's change with real line numbers.
 */
const lhContentProvider = {
  async provideTextDocumentContent(uri) {
    let q;
    try {
      q = JSON.parse(uri.query);
    } catch (e) {
      return "";
    }
    const child = await gitShowFile(q.root, q.hash, q.rel);
    if (!child) return "";
    const cl = child.split("\n");
    const head = cl.slice(0, Math.max(0, q.cA - 1));
    const tail = cl.slice(q.cB);
    let mid = [];
    if (q.hasParent) {
      const parent = await gitShowFile(q.root, `${q.hash}^`, q.rel);
      const pl = parent.split("\n");
      mid = pl.slice(Math.max(0, q.pA - 1), q.pB);
    }
    return head.concat(mid, tail).join("\n");
  },
};

// Parse `git log -L` into per-commit aggregated @@ ranges (parent pA..pB,
// child cA..cB). The tracked line moves through history; these headers say
// where, per commit.
function parseLineLog(out) {
  const HDR = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const commits = [];
  let cur = null;
  for (const raw of out.split("\n")) {
    const m = raw.match(/^commit ([0-9a-f]{40})/);
    if (m) {
      if (cur) commits.push(cur);
      cur = { hash: m[1], pA: Infinity, pB: 0, cA: Infinity, cB: 0 };
      continue;
    }
    if (!cur) continue;
    const h = raw.match(HDR);
    if (h) {
      const a = +h[1];
      const b = h[2] === undefined ? 1 : +h[2];
      const c = +h[3];
      const d = h[4] === undefined ? 1 : +h[4];
      if (b > 0) {
        cur.pA = Math.min(cur.pA, a);
        cur.pB = Math.max(cur.pB, a + b - 1);
      }
      if (d > 0) {
        cur.cA = Math.min(cur.cA, c);
        cur.cB = Math.max(cur.cB, c + d - 1);
      }
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

function gitLogPatchForLine(root, rel, line, max) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["log", "-L", `${line},${line}:${rel}`, "-n", String(max), "--format=commit %H"],
      { cwd: root, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

// `git log -L` anchors its line range at HEAD, ignoring uncommitted edits
// (verified). So a dirty buffer's cursor line must be mapped back to the
// corresponding HEAD line first. Mapping is cached per document version, so
// plain cursor moves (no edit) cost nothing.
const _lineMapCache = new Map(); // fsPath\0version -> (newLine)=>oldLine

function _gitDiffNoIndex(aPath, bPath) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["diff", "--no-index", "--no-color", "-U0", "--", aPath, bPath],
      { timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
      // exit 1 = "files differ", that's the normal case — use stdout anyway.
      (err, stdout) => resolve(String(stdout || ""))
    );
  });
}

function _buildMapper(diffOut) {
  const HDR = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const hunks = [];
  for (const raw of diffOut.split("\n")) {
    const m = raw.match(HDR);
    if (!m) continue;
    hunks.push({
      oldStart: +m[1],
      oldCount: m[2] === undefined ? 1 : +m[2],
      newStart: +m[3],
      newCount: m[4] === undefined ? 1 : +m[4],
    });
  }
  hunks.sort((a, b) => a.newStart - b.newStart);
  return (newLine) => {
    let delta = 0;
    for (const h of hunks) {
      if (newLine < h.newStart) break;
      if (h.newCount > 0 && newLine <= h.newStart + h.newCount - 1) {
        // line exists only in the buffer (added/changed) — no exact HEAD
        // counterpart; anchor at the hunk's old start.
        return Math.max(1, h.oldStart);
      }
      delta += h.oldCount - h.newCount; // hunk entirely above the line
    }
    return Math.max(1, newLine + delta);
  };
}

// Map a buffer (editor) line to the corresponding HEAD line of the same
// file. Returns the line unchanged when the file matches HEAD or isn't in
// git. Uses a temp file for the (possibly unsaved) buffer content.
async function headLineFor(document, line) {
  const ctx = repoFor(document.uri);
  if (!ctx) return line;
  const rel = path.relative(ctx.root, document.uri.fsPath);
  if (!rel || rel.startsWith("..")) return line;
  const key = `${document.uri.fsPath} ${document.version}`;
  const cached = _lineMapCache.get(key);
  if (cached) return cached(line);

  const headText = await gitShowFile(ctx.root, "HEAD", rel);
  const bufText = document.getText();
  let mapper;
  if (!headText || headText === bufText) {
    mapper = (n) => n; // new file, or buffer identical to HEAD
  } else {
    const tmp = os.tmpdir();
    const stamp = `lh-${process.pid}-${Date.now()}`;
    const aPath = path.join(tmp, `${stamp}-head`);
    const bPath = path.join(tmp, `${stamp}-buf`);
    try {
      fs.writeFileSync(aPath, headText);
      fs.writeFileSync(bPath, bufText);
      mapper = _buildMapper(await _gitDiffNoIndex(aPath, bPath));
    } catch (e) {
      mapper = (n) => n;
    } finally {
      try {
        fs.unlinkSync(aPath);
      } catch (e) {}
      try {
        fs.unlinkSync(bPath);
      } catch (e) {}
    }
  }
  // Keep only this file's latest version mapping.
  for (const k of _lineMapCache.keys()) {
    if (k.startsWith(`${document.uri.fsPath} `)) _lineMapCache.delete(k);
  }
  _lineMapCache.set(key, mapper);
  return mapper(line);
}

function repoFor(uri) {
  const api = getGitApi();
  if (!api) return undefined;
  const repo = api.getRepository(uri);
  if (!repo) return undefined;
  return { api, repo, root: repo.rootUri.fsPath };
}

async function revisionsForPosition(uri, line) {
  const ctx = repoFor(uri);
  if (!ctx) return undefined;
  const rel = path.relative(ctx.root, uri.fsPath);
  if (!rel || rel.startsWith("..")) return undefined;
  const max = vscode.workspace
    .getConfiguration("lineHistory")
    .get("maxRevisions", 10);
  const revs = await gitLogForLine(ctx.root, rel, line, max);
  return { ctx, rel, revs };
}

const fileExistsAtRef = (repoRoot, ref, relPath) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["cat-file", "-e", `${ref}:${relPath}`],
      { cwd: repoRoot, timeout: 4000 },
      (err) => resolve(!err)
    );
  });

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const commitExists = (root, ref) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["cat-file", "-e", ref],
      { cwd: root, timeout: 4000 },
      (err) => resolve(!err)
    );
  });

// Lazily fetch the full commit message + shortstat for the hovered row only
// (Timeline shows both in its commit hover). Two tiny git spawns, cached.
function commitMeta(root, hash) {
  const run = (args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        args,
        { cwd: root, timeout: 4000, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? "" : stdout)
      );
    });
  return Promise.all([
    run(["show", "-s", "--format=%B", hash]),
    run(["log", "-1", "--shortstat", "--format=", hash]),
  ]).then(([message, stat]) => ({
    message: String(message).trim(),
    stat: String(stat).trim(),
  }));
}

// Resolve origin to a GitHub https base (or undefined). Cached per repo —
// the remote doesn't change between hovers.
const _ghBaseCache = new Map();
function ghRemoteBase(root) {
  if (_ghBaseCache.has(root)) return Promise.resolve(_ghBaseCache.get(root));
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: root, timeout: 4000 },
      (err, stdout) => {
        let base;
        const url = String(stdout || "").trim();
        const m = url.match(
          /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i
        );
        if (m) base = `https://github.com/${m[1]}/${m[2]}`;
        _ghBaseCache.set(root, base);
        resolve(base);
      }
    );
  });
}

async function openRevision(arg) {
  if (!arg || !arg.file || !arg.hash) return;
  const uri = vscode.Uri.file(arg.file);
  const ctx = repoFor(uri);
  if (!ctx) {
    vscode.window.showErrorMessage("Line History: not a Git repository.");
    return;
  }
  const rel = path.relative(ctx.root, uri.fsPath);
  const name = path.basename(arg.file);
  const opts =
    typeof arg.line === "number" && arg.line > 0
      ? { selection: new vscode.Range(arg.line - 1, 0, arg.line - 1, 0) }
      : undefined;

  // Parent may not have the file (repo's initial commit, or the commit that
  // added/moved/renamed it). Then the left side must be empty (ref ""), not
  // a ref where the path is absent — otherwise "file was not found".
  const parentHasFile = await fileExistsAtRef(ctx.root, `${arg.hash}^`, rel);
  const left = ctx.api.toGitUri(uri, parentHasFile ? `${arg.hash}^` : "");
  const right = ctx.api.toGitUri(uri, arg.hash);
  vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${arg.hash.slice(0, 8)} — ${name}`,
    opts
  );
}

// Open a whole commit as a native multi-file diff (vscode.changes). Invoked
// from the inline action (arg = the tree node) or the command palette.
async function openCommit(arg) {
  const node = arg && arg.rev ? arg : undefined;
  const file = node ? node.file : arg && arg.file;
  const hash = node ? node.rev.hash : arg && arg.hash;
  if (!file || !hash) return;
  const uri = vscode.Uri.file(file);
  const ctx = repoFor(uri);
  if (!ctx) {
    vscode.window.showErrorMessage("Line History: not a Git repository.");
    return;
  }
  const hasParent = await commitExists(ctx.root, `${hash}^`);
  const baseRef = hasParent ? `${hash}^` : EMPTY_TREE;
  let changes;
  try {
    changes = await ctx.repo.diffBetween(baseRef, hash);
  } catch (e) {
    vscode.window.showErrorMessage("Line History: could not diff commit.");
    return;
  }
  const S_INDEX_ADDED = 1;
  const S_INDEX_DELETED = 2;
  const S_DELETED = 6;
  const list = changes.map((c) => {
    const label = c.renameUri || c.uri;
    const isAdded = c.status === S_INDEX_ADDED;
    const isDeleted = c.status === S_INDEX_DELETED || c.status === S_DELETED;
    const left = isAdded
      ? undefined
      : ctx.api.toGitUri(c.originalUri, hasParent ? baseRef : "");
    const right = isDeleted ? undefined : ctx.api.toGitUri(label, hash);
    return [label, left, right];
  });
  if (!list.length) {
    vscode.window.showInformationMessage(
      "Line History: commit has no file changes."
    );
    return;
  }
  vscode.commands.executeCommand(
    "vscode.changes",
    `${hash.slice(0, 8)} — commit`,
    list
  );
}

function absDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
}

/**
 * Build the commit hover as a MarkdownString — rendered by VS Code's own
 * hover widget (the same one Timeline uses). Mirrors git's getCommitHover
 * field-for-field: gravatar + author (mailto), comma, $(history) relative
 * (absolute); co-authors as `$(account) **Name** _(Co-author)_`; message
 * (co-author trailers stripped); rule; shortstat in scmGraph hover colours;
 * rule; a `$(git-commit) <sha>` (copy) | Open Commit command row.
 */
function buildTooltip(node, meta, ghBase) {
  const md = new vscode.MarkdownString(undefined, true); // supportThemeIcons
  md.isTrusted = true;
  md.supportHtml = true;
  const r = node.rev;

  // Author line — exactly git's getCommitHover: $(account), bold name
  // wrapped *inside* a mailto link, comma, $(history), relative (absolute).
  const name = r.email
    ? `[**${r.author}**](mailto:${r.email})`
    : `**${r.author}**`;
  const avatar = r.email
    ? `![${r.author}](${gravatarUrl(r.email)}|width=20,height=20)`
    : "$(account)";
  md.appendMarkdown(
    `${avatar} ${name}, $(history) ${fromNow(r.ts)} (${absDate(r.ts)})`
  );

  // Co-authors — git pulls `Co-authored-by:` trailers out of the message
  // and renders them as `$(account) **Name** _(Co-author)_`, not as raw
  // body text. Mirror that, and strip them from the message below.
  let message = (meta && meta.message) || r.subject || "(no subject)";
  const coRe = /^[ \t]*Co-authored-by:[ \t]*(.+?)[ \t]*<([^>]+)>[ \t]*$/gim;
  const coauthors = [];
  let cm;
  while ((cm = coRe.exec(message)) !== null) {
    coauthors.push({ name: cm[1], email: cm[2] });
  }
  for (const co of coauthors) {
    md.appendMarkdown(
      `  \n$(account) [**${co.name}**](mailto:${co.email}) _(Co-author)_`
    );
  }

  // Message — drop co-author trailers, escape image syntax, collapse runs
  // of newlines to paragraph breaks; then a rule.
  message = message.replace(coRe, "");
  const safe = message
    .replace(/!\[/g, "&#33;&#91;")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
  md.appendMarkdown(`\n\n${safe}\n\n---\n\n`);

  // Short stats — HTML spans with git's scmGraph hover colour tokens.
  if (meta && meta.stat) {
    const files = (meta.stat.match(/(\d+) files? changed/) || [])[1];
    const ins = (meta.stat.match(/(\d+) insertion/) || [])[1];
    const del = (meta.stat.match(/(\d+) deletion/) || [])[1];
    const parts = [];
    if (files) {
      parts.push(`${files} ${files === "1" ? "file" : "files"} changed`);
    }
    if (ins) {
      parts.push(
        `<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">` +
          `${ins} ${ins === "1" ? "insertion" : "insertions"}(+)</span>`
      );
    }
    if (del) {
      parts.push(
        `<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">` +
          `${del} ${del === "1" ? "deletion" : "deletions"}(-)</span>`
      );
    }
    if (parts.length) md.appendMarkdown(`${parts.join(", ")}\n\n---\n\n`);
  }

  // Command links — git's appendCommands pattern: groups joined by
  // `&nbsp;&nbsp;|&nbsp;&nbsp;`. $(git-commit) <short> copies the SHA;
  // then Open Commit (we have no remote, so no "Open on GitHub").
  const openArgs = encodeURIComponent(
    JSON.stringify([{ file: node.file, hash: r.hash }])
  );
  const copyArgs = encodeURIComponent(JSON.stringify([r.hash]));
  const sep = "&nbsp;&nbsp;|&nbsp;&nbsp;";
  const groups = [
    `$(git-commit) [${r.short}](command:lineHistory.copyCommit?${copyArgs} ` +
      `"Copy Commit SHA")`,
    `[Open Commit](command:lineHistory.openCommit?${openArgs} ` +
      `"Open the full commit as a multi-file diff")`,
  ];
  if (ghBase) {
    groups.push(
      `$(github) [Open on GitHub](${ghBase}/commit/${r.hash} ` +
        `"Open this commit on GitHub")`
    );
  }
  md.appendMarkdown(groups.join(sep));
  return md;
}

class LineHistoryProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.nodes = [];
    this.header = "Open a tracked file";
    this.visible = false;
    this.pending = null;
    this.token = 0;
    this.metaCache = new Map();
    this.view = undefined;
  }

  setVisible(v) {
    this.visible = v;
    if (v && this.pending) {
      const p = this.pending;
      this.pending = null;
      this.update(p.uri, p.seedLine, p.displayLine);
    }
  }

  async update(uri, seedLine, displayLine) {
    const line = seedLine;
    const shown = displayLine || seedLine;
    if (!uri || uri.scheme !== "file" || !line) return;
    if (!this.visible) {
      this.pending = { uri, seedLine, displayLine };
      return;
    }
    const myToken = ++this.token;
    const result = await revisionsForPosition(uri, line);
    if (myToken !== this.token) return;

    if (!result) {
      this.header = "Not a Git repository";
      this.nodes = [];
      if (this.view) this.view.description = undefined;
    } else if (result.revs.length === 0) {
      this.header = `No history · ${path.basename(uri.fsPath)}:${shown}`;
      this.nodes = [];
      if (this.view) {
        this.view.description = `${path.basename(uri.fsPath)}:${shown}`;
      }
    } else {
      this.header = "";
      if (this.view) {
        this.view.description = `${path.basename(uri.fsPath)}:${shown}`;
      }
      let prev = null;
      this.nodes = result.revs.map((r) => {
        const time = fromNow(r.ts);
        const dup = time === prev;
        prev = time;
        return { rev: r, file: uri.fsPath, line, time, dup };
      });
    }
    this._emitter.fire();
  }

  getTreeItem(node) {
    if (node.placeholder) {
      const it = new vscode.TreeItem(node.placeholder);
      it.contextValue = "placeholder";
      return it;
    }
    const r = node.rev;
    const it = new vscode.TreeItem(
      r.subject || "(no subject)",
      vscode.TreeItemCollapsibleState.None
    );
    // Timeline omits the time on consecutive rows with the same value.
    it.description = node.dup ? r.author : `${r.author}  ${node.time}`;
    it.iconPath = new vscode.ThemeIcon("git-commit");
    it.contextValue = "commit";
    it.command = {
      command: "lineHistory.openRevision",
      title: "Open Revision",
      arguments: [{ file: node.file, hash: r.hash, line: node.line }],
    };
    return it;
  }

  // Lazily fill the real VS Code hover widget — same mechanism as Timeline.
  async resolveTreeItem(item, node) {
    if (!node || node.placeholder) return item;
    const r = node.rev;
    let meta = this.metaCache.get(r.hash);
    let ghBase;
    const ctx = repoFor(vscode.Uri.file(node.file));
    if (ctx) {
      if (!meta) {
        meta = await commitMeta(ctx.root, r.hash);
        this.metaCache.set(r.hash, meta);
      }
      ghBase = await ghRemoteBase(ctx.root);
    }
    item.tooltip = buildTooltip(node, meta, ghBase);
    return item;
  }

  getChildren() {
    if (this.nodes.length === 0) return [{ placeholder: this.header }];
    return this.nodes;
  }
}

// Open the whole line's history as one native multi-diff (vscode.changes) —
// same UI as "Git: Open Changes" / Open Commit, one diff block per commit
// that touched the line (whole file at hash^ vs hash; VS Code's diff editor
// can't line-scope).
async function openLineHistory() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    vscode.window.showInformationMessage("Line History: no active editor.");
    return;
  }
  const uri = editor.document.uri;
  const bufLine = editor.selection.active.line + 1;
  const line = await headLineFor(editor.document, bufLine);
  const result = await revisionsForPosition(uri, line);
  if (!result) {
    vscode.window.showErrorMessage("Line History: not a Git repository.");
    return;
  }
  if (result.revs.length === 0) {
    vscode.window.showInformationMessage(
      `Line History: no history for line ${line}.`
    );
    return;
  }
  const ctx = result.ctx;
  const rel = result.rel;
  const max = vscode.workspace
    .getConfiguration("lineHistory")
    .get("maxRevisions", 10);
  const commits = parseLineLog(
    await gitLogPatchForLine(ctx.root, rel, line, max)
  );
  if (!commits.length) {
    vscode.window.showInformationMessage(
      `Line History: no history for line ${line}.`
    );
    return;
  }
  const list = [];
  for (const c of commits) {
    // pB === 0 means the parent side of the @@ hunk is empty: the tracked
    // line is *introduced* in this commit. Older commits are git's
    // blame-style lineage guess onto unrelated ancestor text — not this
    // line's history. Include the birth commit, then stop.
    const born = !(c.pB > 0);
    const hasParent =
      c.pB > 0 &&
      (await fileExistsAtRef(ctx.root, `${c.hash}^`, rel));
    // right = the real file@hash (real line numbers, "Open File" works).
    const right = ctx.api.toGitUri(uri, c.hash);
    // left = same file but only the tracked line's region reverted, so the
    // sole diff is that line's hunk; everything else collapses away.
    const left = vscode.Uri.from({
      scheme: LH_SCHEME,
      path: "/" + rel,
      query: JSON.stringify({
        root: ctx.root,
        rel,
        hash: c.hash,
        hasParent,
        pA: isFinite(c.pA) ? c.pA : 1,
        pB: c.pB || 0,
        cA: isFinite(c.cA) ? c.cA : 1,
        cB: c.cB || 0,
      }),
    });
    list.push([ctx.api.toGitUri(uri, c.hash), left, right]);
    if (born) break; // line introduced here — nothing real before it
  }
  vscode.commands.executeCommand(
    "vscode.changes",
    `Line history — ${rel}:${bufLine}`,
    list
  );
}

async function showQuickPick() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("Line History: no active editor.");
    return;
  }
  const bufLine = editor.selection.active.line + 1;
  const line = await headLineFor(editor.document, bufLine);
  const result = await revisionsForPosition(editor.document.uri, line);
  if (!result || !result.revs || result.revs.length === 0) {
    vscode.window.showInformationMessage(
      `Line History: no history for line ${bufLine}.`
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    result.revs.map((r) => ({
      label: `$(git-commit) ${r.short}  ${r.subject || "(no subject)"}`,
      description: `${fromNow(r.ts)} · ${r.author}`,
      rev: r,
    })),
    { placeHolder: `Line ${bufLine} — ${result.rel}` }
  );
  if (pick) {
    openRevision({
      file: editor.document.uri.fsPath,
      hash: pick.rev.hash,
      line,
    });
  }
}

function activate(context) {
  const provider = new LineHistoryProvider();
  const treeView = vscode.window.createTreeView("lineHistory.view", {
    treeDataProvider: provider,
  });
  provider.view = treeView;
  provider.setVisible(treeView.visible);

  let debounce;
  const followCursor = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return;
    const doc = editor.document;
    const uri = doc.uri;
    const bufLine = editor.selection.active.line + 1;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const seed = await headLineFor(doc, bufLine);
      provider.update(uri, seed, bufLine);
    }, 250);
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      LH_SCHEME,
      lhContentProvider
    ),
    treeView,
    treeView.onDidChangeVisibility((e) => provider.setVisible(e.visible)),
    vscode.window.onDidChangeTextEditorSelection(followCursor),
    vscode.window.onDidChangeActiveTextEditor(followCursor),
    vscode.commands.registerCommand("lineHistory.openRevision", openRevision),
    vscode.commands.registerCommand("lineHistory.openCommit", openCommit),
    vscode.commands.registerCommand("lineHistory.show", showQuickPick),
    vscode.commands.registerCommand(
      "lineHistory.openLineHistory",
      openLineHistory
    ),
    vscode.commands.registerCommand("lineHistory.refresh", followCursor),
    vscode.commands.registerCommand("lineHistory.copyCommit", (hash) => {
      if (hash) {
        vscode.env.clipboard.writeText(String(hash));
        vscode.window.setStatusBarMessage(
          `Copied ${String(hash).slice(0, 8)}`,
          2000
        );
      }
    })
  );

  followCursor();
}

function deactivate() {}

module.exports = { activate, deactivate };
