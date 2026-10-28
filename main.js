"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const state_1 = require("@codemirror/state");
const view_1 = require("@codemirror/view");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const VIEW_TYPE = "vault-version-control-view";
const DIFF_VIEW_TYPE = "vault-version-control-diff-view";
// A large Diff must never mount tens of thousands of DOM rows in one tab.
const DIFF_PAGE_ROWS = 3000;
const DIFF_RENDER_BATCH_ROWS = 150;
const DIFF_JUMP_ROWS = 360;
const DIFF_FRAME_BUDGET_MS = 7;
// Restored tabs only auto-start after proving that both sources are small.
const DIFF_AUTO_RESTORE_MAX_BYTES = 1024 * 1024;
const DIFF_AUTO_RESTORE_MAX_LINE_BYTES = 16 * 1024;
const HISTORY_LIMIT = 60;
const STATUS_DEBOUNCE_MS = 350;
const EDITOR_STATUS_DEBOUNCE_MS = 700;
const HOVER_OPEN_MS = 220;
const HOVER_CLOSE_MS = 240;
// Historical Markdown previews remain ordinary Obsidian Markdown views so the
// native Outline, source mode, Reading view, search, selection, and copy
// behavior continue to work.  A per-editor CodeMirror compartment makes only
// those preview editors strictly read-only when the user switches to source
// mode.  `tabindex=0` preserves focus even though the content DOM itself is not
// editable.
const historyPreviewReadOnlyCompartment = new state_1.Compartment();
class HistoryPreviewReadOnlyController {
    constructor(view) {
        this.view = view;
        this.readOnly = null;
        this.observer = null;
        this.timers = [];
        const root = this.view.dom.closest(".workspace-leaf-content") || this.view.dom.parentElement;
        if (root) {
            this.observer = new MutationObserver(() => this.scheduleSync(0));
            this.observer.observe(root, {
                attributes: true,
                attributeFilter: ["class", "data-vvc-history-preview-path"],
            });
        }
        this.scheduleSync(0);
        this.scheduleSync(80);
        this.scheduleSync(300);
    }
    update() {
        this.scheduleSync(0);
    }
    destroy() {
        this.observer?.disconnect();
        for (const timer of this.timers)
            window.clearTimeout(timer);
        this.timers = [];
    }
    scheduleSync(delay) {
        const timer = window.setTimeout(() => {
            this.timers = this.timers.filter((value) => value !== timer);
            this.sync();
        }, delay);
        this.timers.push(timer);
    }
    sync() {
        const shouldBeReadOnly = Boolean(this.view.dom.closest(".vvc-history-preview-view"));
        if (this.readOnly === shouldBeReadOnly)
            return;
        this.readOnly = shouldBeReadOnly;
        const readOnlyExtensions = shouldBeReadOnly
            ? state_1.Prec.highest([
                state_1.EditorState.readOnly.of(true),
                view_1.EditorView.editable.of(false),
                // Extra guard: suppress document changes even if an editing command
                // manages to construct a transaction. Selection-only transactions
                // remain available, which keeps keyboard navigation/search usable.
                state_1.EditorState.changeFilter.of((transaction) => !transaction.docChanged),
                view_1.EditorView.contentAttributes.of({
                    tabindex: "0",
                    "aria-readonly": "true",
                    "data-vvc-history-readonly": "true",
                }),
            ])
            : [];
        this.view.dispatch({
            effects: historyPreviewReadOnlyCompartment.reconfigure(readOnlyExtensions),
        });
    }
}
const historyPreviewReadOnlyExtension = [
    historyPreviewReadOnlyCompartment.of([]),
    view_1.ViewPlugin.fromClass(HistoryPreviewReadOnlyController),
];
function isHistoryPreviewHeaderTitleTarget(target) {
    if (!(target instanceof Element))
        return false;
    return Boolean(target.closest(".vvc-history-preview-view .view-header-title"));
}
const DEFAULT_GITIGNORE = `# Obsidian application state and plugins
.obsidian/

# Obsidian trash
.trash/

# macOS
.DS_Store

# Windows
Thumbs.db
Desktop.ini

# Node.js dependencies and caches
node_modules/
.npm/
.yarn/
.pnpm-store/

# Python virtual environments and caches
.venv/
venv/
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Common build and tool caches
dist/
build/
.cache/
`;
const DEFAULT_SETTINGS = {
    gitMode: "auto",
    gitExecutable: "",
    authorName: "",
    authorEmail: "",
    identityMode: "git",
    diffGridLines: true,
    lastDetectedGitPath: "",
    vaultHistoryCollapsed: true,
    stagedChangesCollapsed: false,
    changesCollapsed: false,
};
// The journal is evidence for read-only recovery, not permission to delete.
function installStagedGitMetadata(vaultRoot, isolatedGit, onFileCopied, journal) {
    const root = fs.lstatSync(vaultRoot);
    if (!root.isDirectory() || root.isSymbolicLink())
        throw new Error("Vault root is not a normal directory.");
    if (fs.readdirSync(vaultRoot).some((name) => name.toLowerCase() === ".git")) {
        throw new Error("Refusing to overwrite existing Vault Git metadata.");
    }
    const staged = fs.lstatSync(isolatedGit);
    if (!staged.isDirectory() || staged.isSymbolicLink())
        throw new Error("Staged Git metadata is not a normal directory.");
    const relative = path.relative(vaultRoot, isolatedGit);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        throw new Error("Staged Git metadata must be isolated outside the Vault.");
    }
    if (fs.existsSync(path.join(isolatedGit, "objects", "info", "alternates"))) {
        throw new Error("Staged Git objects must be self-contained, without external alternates.");
    }
    // Validate all staged metadata types before claiming the target.
    const inspect = (directory) => {
        for (const item of fs.readdirSync(directory)) {
            const absolute = path.join(directory, item);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
                throw new Error("Staged Git metadata contains unsupported filesystem entries.");
            }
            if (stat.isDirectory())
                inspect(absolute);
        }
    };
    inspect(isolatedGit);
    // A root-level journal closes the otherwise unprotected interval between
    // claiming .git and writing its internal marker. Both markers are fail-closed.
    const rootMarker = path.join(vaultRoot, ".vvc-remote-import-pending");
    const serialized = JSON.stringify(journal ?? { version: 1, phase: "claiming-git-directory" }) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
        throw new Error("Remote import journal exceeds the safety limit; no Vault metadata was created.");
    }
    const rootFd = fs.openSync(rootMarker, "wx", 0o600);
    try {
        fs.writeSync(rootFd, serialized);
        fs.fsyncSync(rootFd);
    }
    finally {
        fs.closeSync(rootFd);
    }
    const target = path.join(vaultRoot, ".git");
    fs.mkdirSync(target); // atomic exclusive claim; EEXIST never replaced.
    const marker = path.join(target, "vvc-import-pending");
    const fd = fs.openSync(marker, "wx", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify({ version: 1, phase: "installing-metadata" }) + "\n");
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    const copy = (source, destination) => {
        for (const name of fs.readdirSync(source)) {
            if (name === "vvc-import-pending")
                throw new Error("Staged metadata collides with import marker.");
            const from = path.join(source, name);
            const to = path.join(destination, name);
            const stat = fs.lstatSync(from);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                fs.mkdirSync(to);
                copy(from, to);
            }
            else if (stat.isFile() && !stat.isSymbolicLink()) {
                fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
                onFileCopied?.(); // deterministic failure injection in disposable tests
            }
            else
                throw new Error("Staged Git metadata changed during installation.");
        }
    };
    // Any exception from here leaves vvc-import-pending for explicit recovery.
    copy(isolatedGit, target);
}
// Fail closed before remote initialization touches the Vault. Comparing the
// live Markdown view with filesystem bytes catches Obsidian's debounced saves;
// Git status alone cannot see content still held in an editor buffer.
function assertNoUnsavedMarkdownViews(app, vaultRoot, filePaths) {
    const workspace = app?.workspace;
    if (!workspace || typeof workspace.getLeavesOfType !== "function") {
        throw new Error("Obsidian workspace is unavailable. Cannot safely check open editors.");
    }
    const leaves = workspace.getLeavesOfType("markdown");
    if (!Array.isArray(leaves)) {
        throw new Error("Unable to enumerate Obsidian Markdown editors.");
    }
    for (const leaf of leaves) {
        const view = leaf?.view;
        if (!view)
            throw new Error("A Markdown editor is not ready. Retry after it finishes loading.");
        const file = view.file;
        if (filePaths && file && !filePaths.has(file.path))
            continue;
        if (!file) {
            if (typeof view.getViewData === "function" && view.getViewData()) {
                throw new Error("An unsaved Markdown editor has no file path. Save it before remote initialization.");
            }
            continue;
        }
        if (typeof file.path !== "string" || typeof view.getViewData !== "function") {
            throw new Error("An open Markdown view cannot be checked. Close it before remote initialization.");
        }
        const relative = file.path;
        if (!relative || relative.startsWith("/") || (process.platform === "win32" && relative.includes("\\")) ||
            relative.split("/").some((part) => part === ".." || part === "." || !part)) {
            throw new Error("An open Markdown view has an unsafe file path.");
        }
        const absolute = path.join(vaultRoot, ...relative.split("/"));
        let disk;
        try {
            const info = fs.lstatSync(absolute);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error("not a normal file");
            disk = fs.readFileSync(absolute, "utf8");
        }
        catch {
            throw new Error(`An open Markdown file could not be verified on disk: ${relative}. Save it before continuing.`);
        }
        let current;
        try {
            current = view.getViewData();
        }
        catch {
            throw new Error(`Cannot read an open Markdown editor: ${relative}. Save and retry.`);
        }
        // Byte-exact comparison is intentional. Differences in line endings/BOM
        // may reject a safe import, but never silently commit a stale editor.
        if (typeof current !== "string" || current !== disk) {
            throw new Error(`Unsaved editor changes detected: ${relative}. Save this note before remote initialization.`);
        }
    }
}
function assertSupportedAttributeFile(name, bytes) {
    if (bytes.length > 512 * 1024 || bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
        throw new Error(`Unsupported Git attributes file: ${name}`);
    }
    const declarations = bytes.toString("utf8").split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
    if (/(^|\s)(filter|working-tree-encoding)\s*=\s*\S+/m.test(declarations)) {
        throw new Error("Git LFS and custom clean/smudge filters or working-tree encoding are not supported by raw import/restore.");
    }
}
function checkedVaultFilePath(vaultRoot, filePath) {
    const root = fs.lstatSync(vaultRoot);
    if (!root.isDirectory() || root.isSymbolicLink())
        throw new Error("Vault root is not a normal directory.");
    const parts = filePath.split("/");
    if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0") ||
        (process.platform === "win32" && (filePath.includes("\\") || /^[a-z]:/i.test(filePath))) ||
        parts.some((part) => !part || part === "." || part === ".." || /^\.git$/i.test(part)) ||
        filePath === ".vvc-remote-import-pending")
        throw new Error("Unsafe or protected Vault file path.");
    let current = vaultRoot;
    for (const part of parts.slice(0, -1)) {
        current = path.join(current, part);
        try {
            const info = fs.lstatSync(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error("Vault path contains an unsafe directory.");
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
    }
    return path.join(current, parts[parts.length - 1]);
}
function snapshotRegularFile(absolute) {
    let stat;
    try {
        stat = fs.lstatSync(absolute);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
        return { exists: false, sha256: null, dev: null, ino: null, mode: null };
    }
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Target is not a regular file.");
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const before = fs.fstatSync(fd);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        const current = fs.lstatSync(absolute);
        if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) {
            throw new Error("File changed while its contents were being checked.");
        }
        return { exists: true, sha256: require("crypto").createHash("sha256").update(bytes).digest("hex"),
            dev: before.dev, ino: before.ino, mode: before.mode & 0o777 };
    }
    finally {
        fs.closeSync(fd);
    }
}
// Validate the link stored in the source blob against files that will actually
// exist after import. Do not resolve it through the live Vault filesystem.
function checkedRemoteSymlinkTarget(name, blob, plan) {
    const reject = (reason) => {
        throw new Error(`Cannot import symbolic link ${JSON.stringify(name)}: ${reason}.`);
    };
    if (blob.length === 0 || blob.length > 2048 || blob.includes(0)) {
        reject("the link target is empty, too long, or contains a NUL byte");
    }
    const target = blob.toString("utf8");
    if (!Buffer.from(target, "utf8").equals(blob) || /[\u0000-\u001f\u007f]/.test(target)) {
        reject("the link target is not a valid UTF-8 path");
    }
    if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
        reject(`absolute link targets are not allowed (${JSON.stringify(target)})`);
    }
    if (target.includes("\\")) {
        reject(`backslash paths are not supported (${JSON.stringify(target)})`);
    }
    // Reject paths whose lexical normalization would conceal a traversal through
    // a file or link (e.g. "file.md/../note.md", "file.md/.").
    let enteredTarget = false;
    const segments = target.split("/");
    if (segments.some((part) => {
        if (!part)
            return true;
        if (part === ".." && enteredTarget)
            return true;
        if (part !== "." && part !== "..")
            enteredTarget = true;
        return false;
    }) || segments[segments.length - 1] === ".") {
        reject(`target ${JSON.stringify(target)} contains an unsupported noncanonical path`);
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
    if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
        reject(`target ${JSON.stringify(target)} escapes the Vault`);
    }
    const root = resolved.split("/")[0].toLowerCase();
    if (root === ".git" || resolved.toLowerCase() === ".vvc-remote-import-pending") {
        reject(`target ${JSON.stringify(resolved)} accesses protected Git metadata`);
    }
    if (root === ".obsidian") {
        reject(`target ${JSON.stringify(resolved)} accesses protected Obsidian settings`);
    }
    if (plan.symlinkFiles.includes(resolved)) {
        reject(`target ${JSON.stringify(resolved)} is another symbolic link (chains and cycles are not supported)`);
    }
    if (![...plan.importFiles, ...plan.existingFiles].includes(resolved)) {
        reject(`target ${JSON.stringify(resolved)} will not be a source-tracked regular file after import`);
    }
    return { target, resolved };
}
// Preflight is deliberately read-only. No remote blob is ever written into an
// Obsidian Vault until its complete tree and the existing filesystem agree.
// Git's -z output avoids quoted-path parsing and supports legitimate spaces.
function inspectRemoteImportTree(vaultRoot, treeOutput) {
    const remoteFiles = new Map();
    const remoteKeys = new Map();
    const localFiles = new Map();
    const localKeys = new Map();
    const collisionKey = (value) => value.normalize("NFD").toLowerCase();
    const pathError = (name) => {
        throw new Error(`Unsupported or unsafe remote import path: ${JSON.stringify(name)}`);
    };
    const assertPath = (name) => {
        if (!name || name.length > 2048 || name.startsWith("/") || name.includes("\\") ||
            name === ".vvc-remote-import-pending" ||
            /[\u0000-\u001f\u007f<>:"|?*]/.test(name))
            pathError(name);
        const segments = name.split("/");
        if (segments.length > 128 || segments.some((part) => !part || part === "." || part === ".." || part.length > 255 ||
            /[. ]$/.test(part) || /^\.git$/i.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
            pathError(name);
    };
    for (const record of treeOutput.split("\0")) {
        if (!record)
            continue;
        const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64}) +([0-9-]+)\t([^\0]+)$/.exec(record);
        if (!match)
            throw new Error("Malformed Git tree entry; remote initialization was not started.");
        const [, mode, type, , , filename] = match;
        assertPath(filename);
        if (mode === "160000" && type === "commit") {
            throw new Error(`Git submodules are not supported by Initialize from Remote. Submodule: ${JSON.stringify(filename)} (mode 160000). No Vault files were imported.`);
        }
        if (!["100644", "100755", "120000"].includes(mode) || type !== "blob") {
            throw new Error(`Unsupported Git tree entry at ${JSON.stringify(filename)} (mode ${mode}, type ${type}). Only regular files and safe internal symbolic links are supported. No Vault files were imported.`);
        }
        if (remoteFiles.has(filename))
            throw new Error(`Duplicate remote tree entry: ${filename}`);
        remoteFiles.set(filename, mode);
        const parts = filename.split("/");
        for (let i = 1; i <= parts.length; i += 1) {
            const name = parts.slice(0, i).join("/");
            const kind = i === parts.length ? "file" : "directory";
            const key = collisionKey(name);
            const previous = remoteKeys.get(key);
            if (previous && (previous.name !== name || previous.kind !== kind)) {
                throw new Error(`Remote tree path collision or type conflict: ${previous.name} / ${name}`);
            }
            remoteKeys.set(key, { name, kind });
        }
    }
    if (remoteFiles.size > 100000)
        throw new Error("Repository exceeds safe remote import file-count limit.");
    const root = fs.lstatSync(vaultRoot);
    if (!root.isDirectory() || root.isSymbolicLink())
        throw new Error("Vault root must be a regular directory.");
    if (fs.readdirSync(vaultRoot).some((name) => name.toLowerCase() === ".git")) {
        throw new Error("A Git metadata path already exists in this Vault. Remote initialization cannot overwrite it.");
    }
    const walk = (folder, prefix = "") => {
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${item.name}` : item.name;
            assertPath(rel);
            const info = fs.lstatSync(path.join(folder, item.name));
            if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) {
                throw new Error(`Vault contains an unsupported filesystem entry: ${rel}`);
            }
            const kind = info.isDirectory() ? "directory" : "file";
            const key = collisionKey(rel);
            const previous = localKeys.get(key);
            if (previous && (previous.name !== rel || previous.kind !== kind)) {
                throw new Error(`Vault contains colliding paths: ${previous.name} / ${rel}`);
            }
            localKeys.set(key, { name: rel, kind });
            if (kind === "directory")
                walk(path.join(folder, item.name), rel);
            else
                localFiles.set(rel, kind);
            if (localKeys.size > 150000)
                throw new Error("Vault exceeds safe remote import path-count limit.");
        }
    };
    walk(vaultRoot);
    const importFiles = [];
    const existingFiles = [];
    const deferredObsidian = [];
    const tracksObsidian = [...remoteFiles.keys()].some((name) => name.startsWith(".obsidian/"));
    for (const filename of remoteFiles.keys()) {
        const ancestors = filename.split("/");
        for (let index = 1; index < ancestors.length; index += 1) {
            const ancestor = ancestors.slice(0, index).join("/");
            const local = localKeys.get(collisionKey(ancestor));
            if (local && (local.name !== ancestor || local.kind !== "directory")) {
                throw new Error(`Remote path conflicts with existing Vault directory structure: ${filename}`);
            }
        }
        const atTarget = localKeys.get(collisionKey(filename));
        if (atTarget && (atTarget.name !== filename || atTarget.kind !== "file")) {
            throw new Error(`Remote path conflicts with an existing Vault entry: ${filename}`);
        }
        if (atTarget)
            existingFiles.push(filename);
        else if (filename.startsWith(".obsidian/"))
            deferredObsidian.push(filename);
        else
            importFiles.push(filename);
    }
    const localOnlyFiles = [...localFiles.keys()].filter((name) => !remoteFiles.has(name));
    const symlinkFiles = [...remoteFiles].filter(([, mode]) => mode === "120000").map(([name]) => name);
    return { trackedFileCount: remoteFiles.size, tracksObsidian, importFiles, existingFiles, deferredObsidian, localOnlyFiles, symlinkFiles };
}
// Counts are based on locally stored remote-tracking refs, not a live GitHub
// query. Keep the presentation separate from Git's ahead/behind calculation.
function remoteTrackingStatus(remote) {
    if (!remote.upstream)
        return "origin connected · No upstream branch";
    const prefix = `${remote.upstream} · `;
    const { ahead, behind } = remote;
    if (ahead === null || behind === null)
        return prefix + "Remote status unavailable";
    if (ahead === 0 && behind === 0)
        return prefix + "Up to date";
    const local = `${ahead} local ${ahead === 1 ? "commit" : "commits"}`;
    const incoming = `${behind} remote ${behind === 1 ? "commit" : "commits"}`;
    if (behind === 0)
        return prefix + local + " to push";
    if (ahead === 0)
        return prefix + `${behind} new remote ${behind === 1 ? "commit" : "commits"}`;
    return prefix + local + " · " + incoming;
}
// Use a root-anchored literal rule; directory rules end in /.
function exactGitIgnoreRule(filePath, directory = false) {
    if (!filePath || filePath.startsWith("/") || filePath.includes("\\") ||
        /[\x00-\x1f\x7f]/.test(filePath) ||
        filePath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("This path cannot be safely represented by a Git ignore rule.");
    }
    return "/" + filePath.replace(/([\\*?\[\]!# ])/g, "\\$1") + (directory ? "/" : "");
}
function workingTreeDiffSource(filePath, tracked) {
    return { kind: "working-tree", filePath, tracked };
}
function revisionDiffSource(filePath, entry) {
    return {
        kind: "revision",
        filePath,
        pathAtCommit: entry.pathAtCommit,
        hash: entry.hash,
        shortHash: entry.shortHash,
        timestamp: entry.timestamp,
        absentAtCommit: entry.contentAvailable === false,
    };
}
function diffSourceLabel(source) {
    return source.kind === "working-tree" ? "Current local file" :
        source.absentAtCommit ? `${source.shortHash} (removed)` : source.shortHash;
}
function diffSourceDetail(source) {
    if (source.kind === "working-tree") {
        const status = source.tracked === false ? " · Not tracked by Git" :
            source.tracked === true ? " · Tracked by Git" : "";
        return `Current local file · Saved on disk${status}`;
    }
    return `Historical version · ${source.shortHash} · ${formatDate(source.timestamp)}${source.absentAtCommit ? " · Not in this commit" : ""}`;
}
const MAX_VISIBLE_GRAPH_LANES = 3;
const SOURCE_GRAPH_LANE = 0;
const FOCUS_GRAPH_LANE = 1;
const OTHER_GRAPH_LANE = 2;
function graphParents(entry) {
    if (!entry?.parents.trim())
        return [];
    return entry.parents.trim().split(/\s+/).filter(Boolean);
}
function firstParentPathList(entriesByHash, tipHash, stopHash = "") {
    const path = [];
    const seen = new Set();
    let hash = tipHash;
    while (hash && hash !== stopHash && !seen.has(hash)) {
        seen.add(hash);
        path.push(hash);
        const parents = graphParents(entriesByHash.get(hash));
        hash = parents[0] || "";
    }
    return path;
}
function firstParentPath(entriesByHash, tipHash, stopHash = "") {
    return new Set(firstParentPathList(entriesByHash, tipHash, stopHash));
}
function collectAncestors(entriesByHash, roots) {
    const result = new Set();
    const pending = roots.filter(Boolean);
    while (pending.length) {
        const hash = pending.pop() || "";
        if (!hash || result.has(hash))
            continue;
        result.add(hash);
        for (const parent of graphParents(entriesByHash.get(hash)))
            pending.push(parent);
    }
    return result;
}
function resolveFocusOrigin(entriesByHash, branches, focusBranch, originByBranch) {
    if (!focusBranch?.hash)
        return { hash: "", inferredSourceBranch: "" };
    const explicit = originByBranch.get(focusBranch.name) || "";
    if (explicit)
        return { hash: explicit, inferredSourceBranch: "" };
    // Reflog creation records can expire or be unavailable after a repository is
    // copied. Only make a fallback inference when another local branch tip lies
    // directly on the focus branch's first-parent path; this is deliberately
    // conservative so the UI never invents a parent branch from an ambiguous DAG.
    const path = firstParentPathList(entriesByHash, focusBranch.hash);
    const indexByHash = new Map(path.map((hash, index) => [hash, index]));
    const candidates = branches
        .filter((branch) => branch.name !== focusBranch.name && Boolean(branch.hash))
        .map((branch) => ({ branch, index: indexByHash.get(branch.hash) ?? -1 }))
        .filter((item) => item.index > 0)
        .sort((a, b) => a.index - b.index);
    const nearest = candidates[0];
    return nearest
        ? { hash: nearest.branch.hash, inferredSourceBranch: nearest.branch.name }
        : { hash: "", inferredSourceBranch: "" };
}
function computeGraphLaneRows(entries, branches, focusBranchName, origins) {
    const entriesByHash = new Map(entries.map((entry) => [entry.hash, entry]));
    const originByBranch = new Map(origins.map((origin) => [origin.branch, origin.hash]));
    const focusBranch = branches.find((branch) => branch.name === focusBranchName)
        ?? branches.find((branch) => branch.current)
        ?? branches[0];
    const focusTipHash = focusBranch?.hash || "";
    const { hash: focusOrigin, inferredSourceBranch } = resolveFocusOrigin(entriesByHash, branches, focusBranch, originByBranch);
    const fullFocusPath = focusTipHash ? firstParentPathList(entriesByHash, focusTipHash) : [];
    const focusIndexByHash = new Map(fullFocusPath.map((hash, index) => [hash, index]));
    const originIndex = focusOrigin ? (focusIndexByHash.get(focusOrigin) ?? -1) : -1;
    let focusPath = focusTipHash
        ? firstParentPath(entriesByHash, focusTipHash, focusOrigin)
        : new Set();
    const sourceContext = new Set();
    if (focusOrigin) {
        // If a newly-created focus branch has not made a unique commit yet, keep its
        // tip in the center lane and place only the older parent history on lane 1.
        if (focusTipHash === focusOrigin) {
            focusPath = new Set([focusOrigin]);
            for (const hash of collectAncestors(entriesByHash, graphParents(entriesByHash.get(focusOrigin)))) {
                sourceContext.add(hash);
            }
        }
        else {
            for (const hash of collectAncestors(entriesByHash, [focusOrigin]))
                sourceContext.add(hash);
        }
        // Lane 1 is allowed to aggregate source/parent branches. A branch is source
        // context when it still reaches the focus fork and its own known creation
        // point is older than that fork. Siblings and child branches stay on lane 3.
        for (const branch of branches) {
            if (!branch.hash || branch.name === focusBranch?.name)
                continue;
            const branchPath = firstParentPathList(entriesByHash, branch.hash);
            if (!branchPath.includes(focusOrigin))
                continue;
            let sourceSide = branch.name === inferredSourceBranch || branch.hash === focusOrigin;
            const otherOrigin = originByBranch.get(branch.name) || "";
            if (otherOrigin) {
                const otherOriginIndex = focusIndexByHash.get(otherOrigin) ?? -1;
                sourceSide = originIndex >= 0 && otherOriginIndex > originIndex;
            }
            else if (branch.name === "master" || branch.name === "main") {
                sourceSide = true;
            }
            if (!sourceSide)
                continue;
            for (const hash of branchPath)
                sourceContext.add(hash);
        }
    }
    const roleForCommit = (hash) => {
        if (focusPath.has(hash))
            return FOCUS_GRAPH_LANE;
        if (sourceContext.has(hash))
            return SOURCE_GRAPH_LANE;
        return OTHER_GRAPH_LANE;
    };
    let nextLaneId = 1;
    let lanes = [];
    const rawRows = [];
    for (const entry of entries) {
        const incomingTokens = lanes.filter((lane) => lane.hash === entry.hash);
        const startsHere = incomingTokens.length === 0;
        const nodeRole = roleForCommit(entry.hash);
        if (startsHere) {
            const token = { id: nextLaneId++, hash: entry.hash, role: nodeRole };
            lanes.push(token);
            incomingTokens.push(token);
        }
        const before = lanes.slice();
        const incomingIds = new Set(incomingTokens.map((lane) => lane.id));
        const parents = graphParents(entry);
        const after = before.filter((lane) => !incomingIds.has(lane.id));
        const insertionIndex = Math.min(Math.max(0, before.findIndex((lane) => incomingIds.has(lane.id))), after.length);
        const parentTokens = parents.map((hash, index) => ({
            id: nextLaneId++,
            hash,
            // Keep the first-parent edge in the same visible role until it reaches
            // the actual fork/base commit. Secondary merge parents use their own role.
            role: index === 0 ? nodeRole : roleForCommit(hash),
        }));
        after.splice(insertionIndex, 0, ...parentTokens);
        const continuationTokens = before.filter((lane) => !incomingIds.has(lane.id));
        rawRows.push({
            entry,
            before,
            after,
            nodeRole,
            startsHere,
            incomingTokens,
            parentTokens,
            continuationTokens,
        });
        lanes = after;
    }
    const uniqueLanes = (values) => Array.from(new Set(values)).sort((a, b) => a - b);
    const countForRole = (tokens, role) => tokens.filter((token) => token.role === role).length;
    return rawRows.map((raw) => {
        const incomingLanes = uniqueLanes(raw.incomingTokens.map((token) => token.role));
        const parentLanes = uniqueLanes(raw.parentTokens.map((token) => token.role));
        const continuations = uniqueLanes(raw.continuationTokens.map((token) => token.role))
            .map((lane) => ({ fromLane: lane, toLane: lane }));
        const aggregatePathCounts = [
            Math.max(countForRole(raw.before, SOURCE_GRAPH_LANE), countForRole(raw.after, SOURCE_GRAPH_LANE)),
            Math.max(countForRole(raw.before, FOCUS_GRAPH_LANE), countForRole(raw.after, FOCUS_GRAPH_LANE)),
            Math.max(countForRole(raw.before, OTHER_GRAPH_LANE), countForRole(raw.after, OTHER_GRAPH_LANE)),
        ];
        return {
            entry: raw.entry,
            // Keep all three role slots physically stable. Lane 2 is therefore always
            // the visual center even when lane 1 or lane 3 has no path on this row.
            beforeCount: MAX_VISIBLE_GRAPH_LANES,
            afterCount: MAX_VISIBLE_GRAPH_LANES,
            nodeLane: raw.nodeRole,
            startsHere: raw.startsHere,
            incomingLanes,
            parentLanes,
            continuations,
            aggregatePathCounts,
            isFocusTip: Boolean(focusTipHash && raw.entry.hash === focusTipHash),
        };
    });
}
function htmlEl(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className)
        element.className = className;
    if (text !== undefined)
        element.textContent = text;
    parent.appendChild(element);
    return element;
}
function buttonEl(parent, text, className) {
    const button = htmlEl(parent, "button", className, text);
    button.type = "button";
    return button;
}
// The Obsidian manifest is the single source of funding links.  The SDK's
// PluginManifest type currently omits fundingUrl, although Obsidian supports it.
function fundingLinkFromManifest(value) {
    const entries = typeof value === "string" ? [["Support development", value]]
        : value && typeof value === "object" && !Array.isArray(value)
            ? Object.entries(value)
            : [];
    for (const [label, rawUrl] of entries) {
        if (typeof rawUrl !== "string" || !label.trim())
            continue;
        try {
            const url = new URL(rawUrl);
            if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
                continue;
            return { label, url: url.href };
        }
        catch {
            // Ignore malformed manifest URLs rather than rendering unsafe links.
        }
    }
    return null;
}
function formatDate(timestampSeconds) {
    const date = new Date(timestampSeconds * 1000);
    if (Number.isNaN(date.getTime()))
        return "";
    return date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
function defaultCommitMessage(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `v${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
function initialCommitMessage(date = new Date()) {
    return `initial commit - ${defaultCommitMessage(date)}`;
}
function splitPorcelainFields(record, fixedFieldCount) {
    const fields = [];
    let start = 0;
    for (let i = 0; i < fixedFieldCount; i++) {
        const space = record.indexOf(" ", start);
        if (space < 0)
            return null;
        fields.push(record.slice(start, space));
        start = space + 1;
    }
    return { fields, rest: record.slice(start) };
}
function statusCodeFromPorcelainV2(code) {
    return !code || code === "." ? " " : code;
}
function gitLinkFlags(submoduleField) {
    const isGitLink = Boolean(submoduleField?.startsWith("S"));
    if (!isGitLink)
        return { isGitLink: false, headChanged: false, dirty: false, untracked: false };
    const headChanged = submoduleField?.[1] === "C";
    const trackedDirty = submoduleField?.[2] === "M";
    const untracked = submoduleField?.[3] === "U";
    return { isGitLink: true, headChanged, dirty: trackedDirty || untracked, untracked };
}
function statusLetter(code) {
    if (code === "?" || code === "A")
        return "A";
    if (code === "D")
        return "D";
    if (code === "R")
        return "R";
    if (code === "C")
        return "C";
    if (code === "U")
        return "U";
    return "M";
}
function isTextFile(file) {
    const ext = (file.extension || "").toLowerCase();
    return new Set([
        "md", "txt", "markdown", "json", "yaml", "yml", "toml", "xml", "csv", "tsv",
        "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx", "jsx", "html", "htm",
        "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs", "sh", "zsh",
        "fish", "bat", "ps1", "ini", "cfg", "conf", "sql", "tex", "log",
    ]).has(ext);
}
function isMarkdownPath(filePath) {
    const match = /\.([^.\/]+)$/.exec(filePath);
    const ext = (match?.[1] || "").toLowerCase();
    return ext === "md" || ext === "markdown";
}
// Keep error classification separate from Git execution: it must never retry,
// mutate the index, or automatically discard a user's working-tree changes.
function describeGitFailure(error, operation) {
    const technical = (error instanceof Error ? error.message : String(error || "Git command failed")).trim();
    const message = technical.toLowerCase();
    let title = "";
    let guidance = "";
    let configureGit = false;
    if (/interrupted remote initialization detected/.test(message)) {
        title = "Remote initialization is incomplete";
        guidance = "Git operations are paused to protect existing Vault files. Review the interrupted initialization before retrying; never delete .git without checking its contents.";
    }
    else if (/git executable not found|git is unavailable|unable to find (?:a usable )?git|spawn git enoent/.test(message)) {
        title = "Git executable unavailable";
        guidance = "Check the Git executable in Vault Version Control settings, then try again.";
        configureGit = true;
    }
    else if (/permission denied|operation not permitted|eacces|eperm|unable to create .*\.lock|could not lock (?:config|index|ref)|权限不够|权限被拒绝|拒绝访问|操作不被允许/.test(message)) {
        title = "Git cannot access the Vault";
        guidance = "Check the Vault and .git folder permissions. If Git reports a lock, finish other Git operations before retrying; do not delete lock files automatically.";
    }
    else if (/not a git repository|does not have a commit checked out|must be run in a work tree|不是(?:一个)? ?git 仓库/.test(message)) {
        title = "Git repository unavailable";
        guidance = "Check that the Vault still contains a valid Git repository, then refresh Version Control.";
    }
    else if (/bad object|bad revision|unknown revision|unknown commit|invalid object name|not a valid object name|path .* (?:does not exist in|exists on disk, but not in)|path .* not in |reference is not a tree|ambiguous argument|错误的对象|无效的对象|无效的版本|未知的修订版/.test(message)) {
        title = "Historical version unavailable";
        guidance = "Refresh File History and choose an existing revision. The selected commit or file may have been removed or renamed.";
    }
    else if (/local changes .* would be overwritten|untracked working tree files would be overwritten|commit (?:the |your |current )?changes before|working tree (?:is )?not clean|please commit your changes or stash|本地修改将被|切换分支前提交|贮藏您的修改/.test(message)) {
        title = "Uncommitted changes prevent this operation";
        guidance = "Review and commit the Vault's changes before trying again. Your changes have not been discarded.";
    }
    else {
        const fallback = {
            status: ["Unable to refresh Git status", "Check the Vault's Git repository and try Check again."],
            diff: ["Comparison failed", "Check that both files and any selected revisions are available, then retry the comparison."],
            history: ["Unable to load file history", "Check that the file and its Git history are available, then try again."],
            restore: ["Unable to restore this version", "Check the selected revision and Vault permissions, then retry. Review the file before making further changes."],
            branch: ["Branch operation failed", "Check the branch name and working-tree status, then try again."],
            repository: ["Git operation failed", "Check the Git environment and Vault permissions, then try again."],
            stage: ["Unable to update staged changes", "Check the selected files and Vault permissions, then retry staging."],
            commit: ["Unable to create commit", "Check the staged changes, Git author identity and Vault permissions, then retry."],
        };
        [title, guidance] = fallback[operation];
    }
    return { title, guidance, technical, configureGit };
}
function gitFailureNotice(error, operation) {
    const failure = describeGitFailure(error, operation);
    return `${failure.title}. ${failure.guidance}`;
}
class RemoteGitAuthenticationError extends Error {
    constructor(method) {
        super(method === "ssh"
            ? "SSH authentication is unavailable. Check your SSH key and agent."
            : "Git authentication is required. Check your system Git credentials.");
        this.method = method;
        this.name = "RemoteGitAuthenticationError";
    }
}
class GitService {
    constructor(plugin) {
        this.detection = null;
        // Network Git operations deliberately use a different execution budget from
        // local status/diff commands. Only explicitly requested operations reach here.
        this.networkAbort = null;
        this.remoteImportInProgress = false;
        this.githubCreationInProgress = false;
        this.ignoreInProgress = false;
        this.ignoreUndoStack = [];
        this.ignoreUndoSerial = 0;
        this.plugin = plugin;
    }
    get vaultPath() {
        const adapter = this.plugin.app.vault.adapter;
        if (!adapter || typeof adapter.getBasePath !== "function") {
            throw new Error("Vault Version Control requires an Obsidian desktop vault with a local filesystem path.");
        }
        return adapter.getBasePath();
    }
    gitDirPath() {
        return path.join(this.vaultPath, ".git");
    }
    /**
     * A future importer must create this marker before copying any Git objects
     * into a newly and exclusively claimed .git directory, removing it only
     * after verifying refs, index and baseline commit. Never auto-delete a
     * partially installed Git directory: external Git may have modified it.
     */
    /**
     * Read-only diagnosis for interrupted import journals. This is deliberately
     * NOT a rollback: matching a Git blob hash cannot establish ownership of a
     * file, nor can we prove that another Git process did not modify .git.
     */
    inspectInterruptedRemoteImport() {
        const vault = this.vaultPath;
        const rootMarker = path.join(vault, ".vvc-remote-import-pending");
        const gitDir = this.gitDirPath();
        const report = {
            state: "none", metadataPresent: false, expectedHead: null,
            matchingFiles: [], missingFiles: [], changedOrUnsafeFiles: [],
        };
        try {
            report.metadataPresent = fs.lstatSync(gitDir).isDirectory();
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        let rootInfo;
        try {
            rootInfo = fs.lstatSync(rootMarker);
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        if (!rootInfo) {
            if (report.metadataPresent && fs.existsSync(path.join(gitDir, "vvc-import-pending")))
                report.state = "legacy";
            return report;
        }
        report.state = "legacy";
        if (!rootInfo.isFile() || rootInfo.isSymbolicLink() || rootInfo.size > 8 * 1024 * 1024) {
            throw new Error("Interrupted import journal is not a safe regular file.");
        }
        let journal;
        try {
            const fd = fs.openSync(rootMarker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
                const info = fs.fstatSync(fd);
                if (!info.isFile() || info.ino !== rootInfo.ino || info.size !== rootInfo.size) {
                    throw new Error("Interrupted import journal was replaced during inspection.");
                }
                const data = Buffer.alloc(info.size);
                let offset = 0;
                while (offset < data.length) {
                    const count = fs.readSync(fd, data, offset, data.length - offset, null);
                    if (!count)
                        throw new Error("Interrupted import journal changed during inspection.");
                    offset += count;
                }
                journal = JSON.parse(data.toString("utf8"));
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch {
            throw new Error("Interrupted import journal is invalid or changed; manual review is required.");
        }
        if (journal?.version !== 2)
            return report;
        if (journal.phase !== "claiming-git-directory" ||
            !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(journal.expectedHead) ||
            !Array.isArray(journal.expectedFiles) || journal.expectedFiles.length > 100000) {
            throw new Error("Interrupted import journal has invalid metadata.");
        }
        report.state = "journaled";
        report.expectedHead = journal.expectedHead;
        const hashAlgorithm = journal.expectedHead.length === 64 ? "sha256" : "sha1";
        const crypto = require("crypto");
        const seen = new Set();
        for (const entry of journal.expectedFiles) {
            const filename = entry?.path;
            if (typeof filename !== "string" || filename.length > 2048 ||
                filename.startsWith("/") || filename.includes("\\") ||
                !filename || filename.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" ||
                part === ".vvc-remote-import-pending") ||
                /[\u0000-\u001f\u007f]/.test(filename) || seen.has(filename) ||
                !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(entry.objectId) ||
                entry.objectId.length !== journal.expectedHead.length ||
                !["100644", "100755", "120000"].includes(entry.mode)) {
                throw new Error("Interrupted import journal contains unsafe file metadata.");
            }
            seen.add(filename);
            let absolute = vault;
            let missing = false;
            let unsafe = false;
            const segments = filename.split("/");
            for (let i = 0; i < segments.length; i += 1) {
                const part = segments[i];
                absolute = path.join(absolute, part);
                try {
                    const info = fs.lstatSync(absolute);
                    if (info.isSymbolicLink() && !(i === segments.length - 1 && entry.mode === "120000"))
                        unsafe = true;
                }
                catch (error) {
                    if (error?.code === "ENOENT")
                        missing = true;
                    else
                        unsafe = true;
                }
                if (missing || unsafe)
                    break;
            }
            if (missing) {
                report.missingFiles.push(filename);
                continue;
            }
            if (unsafe) {
                report.changedOrUnsafeFiles.push(filename);
                continue;
            }
            try {
                const stat = fs.lstatSync(absolute);
                const actualMode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
                if (!(stat.isFile() || stat.isSymbolicLink()) || actualMode !== entry.mode) {
                    report.changedOrUnsafeFiles.push(filename);
                    continue;
                }
                if (entry.mode === "120000") {
                    const data = fs.readlinkSync(absolute, { encoding: "buffer" });
                    const digest = crypto.createHash(hashAlgorithm).update(`blob ${data.length}\0`).update(data).digest("hex");
                    if (digest === entry.objectId)
                        report.matchingFiles.push(filename);
                    else
                        report.changedOrUnsafeFiles.push(filename);
                    continue;
                }
                const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
                let digest;
                try {
                    const info = fs.fstatSync(fd);
                    if (!info.isFile() || info.size !== stat.size || info.ino !== stat.ino)
                        throw new Error("File replaced during inspection.");
                    const h = crypto.createHash(hashAlgorithm);
                    h.update(`blob ${info.size}\0`);
                    const buffer = Buffer.allocUnsafe(64 * 1024);
                    while (true) {
                        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
                        if (!count)
                            break;
                        h.update(buffer.subarray(0, count));
                    }
                    digest = h.digest("hex");
                }
                finally {
                    fs.closeSync(fd);
                }
                if (digest === entry.objectId)
                    report.matchingFiles.push(filename);
                else
                    report.changedOrUnsafeFiles.push(filename);
            }
            catch {
                report.changedOrUnsafeFiles.push(filename);
            }
        }
        return report;
    }
    /**
     * Recover only the narrow case where installation had ALREADY completed its
     * files and Git metadata, but the process exited before clearing markers.
     * Never download, add, overwrite, delete, or infer file ownership here.
     */
    async finalizeVerifiedInterruptedImport() {
        const report = this.inspectInterruptedRemoteImport();
        if (report.state !== "journaled" || !report.metadataPresent || !report.expectedHead) {
            throw new Error("This interrupted import cannot be automatically finalized. Manual review is required.");
        }
        if (report.missingFiles.length || report.changedOrUnsafeFiles.length) {
            throw new Error("The interrupted import has missing or modified files. No automatic recovery was attempted.");
        }
        const vault = this.vaultPath;
        assertNoUnsavedMarkdownViews(this.plugin.app, vault);
        const executable = await this.effectiveExecutable();
        const crypto = require("crypto");
        const algorithm = report.expectedHead.length === 64 ? "sha256" : "sha1";
        const readGit = (args) => new Promise((resolve, reject) => {
            execFile(executable, [
                "-c", "core.fsmonitor=false",
                "-c", "core.hooksPath=/dev/null",
                "--no-optional-locks",
                ...args,
            ], {
                cwd: vault, windowsHide: true, encoding: "utf8",
                maxBuffer: 32 * 1024 * 1024, timeout: 180000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
            }, (error, stdout) => {
                if (error)
                    reject(new Error("Interrupted Git metadata did not pass read-only verification."));
                else
                    resolve(stdout || "");
            });
        });
        const [head, index, tree, remotes] = await Promise.all([
            readGit(["rev-parse", "--verify", "HEAD^{commit}"]),
            readGit(["ls-files", "--stage", "-z"]),
            readGit(["ls-tree", "--full-tree", "-r", "-z", "HEAD"]),
            readGit(["remote"]),
        ]);
        if (remotes.trim()) {
            throw new Error("Interrupted repository still has a configured remote. Recovery cannot finish safely.");
        }
        if (head.trim() !== report.expectedHead) {
            throw new Error("Interrupted repository HEAD differs from the recorded baseline.");
        }
        const indexed = new Map();
        for (const record of index.split("\0").filter(Boolean)) {
            const match = /^(100644|100755|120000) ([0-9a-f]{40,64}) 0\t([^\0]+)$/.exec(record);
            if (!match || indexed.has(match[3]))
                throw new Error("Interrupted Git index is invalid.");
            indexed.set(match[3], { mode: match[1], oid: match[2] });
        }
        const committed = new Map();
        for (const record of tree.split("\0").filter(Boolean)) {
            const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t([^\0]+)$/.exec(record);
            if (!match || committed.has(match[3]))
                throw new Error("Interrupted commit tree contains unsupported paths.");
            committed.set(match[3], { mode: match[1], oid: match[2] });
        }
        if (indexed.size !== committed.size)
            throw new Error("Interrupted Git index does not match HEAD tree.");
        const readBlob = (filename) => {
            const segments = filename.split("/");
            if (!segments.length || segments.some((part) => !part || part === "." || part === ".." || /^\.git$/i.test(part))) {
                throw new Error("Interrupted Git contains an unsafe file path.");
            }
            let location = vault;
            for (const segment of segments.slice(0, -1)) {
                location = path.join(location, segment);
                const parent = fs.lstatSync(location);
                if (!parent.isDirectory() || parent.isSymbolicLink())
                    throw new Error("Vault directory changed during verification.");
            }
            const absolute = path.join(location, segments[segments.length - 1]);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                const data = fs.readlinkSync(absolute, { encoding: "buffer" });
                const h = crypto.createHash(algorithm).update(`blob ${data.length}\0`).update(data).digest("hex");
                return { mode: "120000", oid: h };
            }
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error("Vault file is missing or changed.");
            const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
                const current = fs.fstatSync(fd);
                if (!current.isFile() || current.ino !== stat.ino || current.size !== stat.size) {
                    throw new Error("Vault file changed during verification.");
                }
                const h = crypto.createHash(algorithm);
                h.update(`blob ${current.size}\0`);
                const buffer = Buffer.allocUnsafe(128 * 1024);
                for (;;) {
                    const count = fs.readSync(fd, buffer, 0, buffer.length, null);
                    if (!count)
                        break;
                    h.update(buffer.subarray(0, count));
                }
                const later = fs.fstatSync(fd);
                if (later.size !== current.size || later.mtimeMs !== current.mtimeMs) {
                    throw new Error("Vault file changed during verification.");
                }
                return { mode: current.mode & 0o111 ? "100755" : "100644", oid: h.digest("hex") };
            }
            finally {
                fs.closeSync(fd);
            }
        };
        for (const [filename, entry] of committed) {
            const staged = indexed.get(filename);
            if (!staged || staged.mode !== entry.mode || staged.oid !== entry.oid) {
                throw new Error("Interrupted Git index content differs from HEAD tree.");
            }
            const disk = readBlob(filename);
            if (disk.mode !== entry.mode || disk.oid !== entry.oid) {
                throw new Error(`Vault content changed since baseline preparation: ${filename}`);
            }
        }
        // Checking reachable objects catches an interrupted .git pack copy, even
        // when HEAD and a few index entries happen to be readable.
        await readGit(["fsck", "--connectivity-only", "--no-reflogs", "--no-progress"]);
        // An interrupted importer must never be released with its source origin
        // (or another unexpected Push destination) attached.
        if ((await readGit(["remote"])).trim()) {
            throw new Error("Interrupted repository has a configured remote. Refusing to clear import guards.");
        }
        assertNoUnsavedMarkdownViews(this.plugin.app, vault);
        if (this.inspectInterruptedRemoteImport().state !== "journaled") {
            throw new Error("Import journal changed during recovery verification.");
        }
        // Do not remove files or metadata. Only release the two transaction guards,
        // inner first and root last, once every invariant is proven.
        const inner = path.join(vault, ".git", "vvc-import-pending");
        try {
            const marker = fs.lstatSync(inner);
            if (marker.isFile() && !marker.isSymbolicLink())
                fs.unlinkSync(inner);
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
        }
        fs.unlinkSync(path.join(vault, ".vvc-remote-import-pending"));
    }
    assertImportComplete() {
        // A crash can happen after the root journal has been fsynced but before
        // the .git directory exists. Never misinterpret that state as uninitialized.
        if (fs.readdirSync(this.vaultPath).includes(".vvc-remote-import-pending")) {
            throw new Error("Interrupted remote initialization detected. Git operations are paused to protect this Vault. Inspect the pending import and recover it before continuing; do not delete .git automatically.");
        }
        const gitDir = this.gitDirPath();
        try {
            const info = fs.lstatSync(gitDir);
            if (!info.isDirectory() || info.isSymbolicLink())
                return;
            if (fs.existsSync(path.join(gitDir, "vvc-import-pending"))) {
                throw new Error("Interrupted remote initialization detected. Git operations are paused to protect this Vault. Inspect the pending import and recover it before continuing; do not delete .git automatically.");
            }
        }
        catch (error) {
            if (error?.code === "ENOENT")
                return;
            throw error;
        }
    }
    hasLocalRepository() {
        try {
            return fs.existsSync(this.gitDirPath()) || fs.readdirSync(this.vaultPath).includes(".vvc-remote-import-pending");
        }
        catch {
            return false;
        }
    }
    invalidateDetection() {
        this.detection = null;
    }
    classifyGitFailure(message, errorCode) {
        const text = String(message || "");
        if (errorCode === "ENOENT" || /not found|cannot find|no such file or directory/i.test(text))
            return "not_found";
        if (/xcode license|license agreements|xcodebuild\s+-license|agree to the xcode/i.test(text))
            return "xcode_license";
        if (/invalid active developer path|command line developer tools|xcode-select\s+--install|requires.*developer tools|xcrun:\s*error/i.test(text))
            return "command_line_tools";
        if (errorCode === "EACCES" || /permission denied|operation not permitted/i.test(text))
            return "permission";
        return "other";
    }
    githubDesktopGitCandidates(localAppData) {
        if (!localAppData)
            return [];
        const desktopRoot = path.join(localAppData, "GitHubDesktop");
        try {
            if (!fs.existsSync(desktopRoot))
                return [];
            return fs.readdirSync(desktopRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
                .map((entry) => entry.name)
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }))
                .map((name) => path.join(desktopRoot, name, "resources", "app", "git", "cmd", "git.exe"))
                .filter((candidate) => fs.existsSync(candidate));
        }
        catch {
            return [];
        }
    }
    autoCandidates() {
        const candidates = [];
        const remembered = (this.plugin.settings.lastDetectedGitPath || "").trim();
        if (remembered)
            candidates.push(remembered);
        if (process.platform === "darwin") {
            // Prefer standalone Git installations before PATH/Apple Git. GUI apps such as
            // Obsidian often inherit a PATH where `git` resolves to /usr/bin/git, which can
            // trigger the Xcode-license shim even when Homebrew Git is already installed.
            candidates.push("/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git", "git", "/usr/bin/git");
        }
        else if (process.platform === "win32") {
            candidates.push("git");
            const programFiles = process.env?.ProgramFiles || "C:\\Program Files";
            const programFilesX86 = process.env?.["ProgramFiles(x86)"] || "";
            const localAppData = process.env?.LOCALAPPDATA || "";
            candidates.push(path.join(programFiles, "Git", "cmd", "git.exe"), path.join(programFiles, "Git", "bin", "git.exe"));
            if (programFilesX86) {
                candidates.push(path.join(programFilesX86, "Git", "cmd", "git.exe"), path.join(programFilesX86, "Git", "bin", "git.exe"));
            }
            if (localAppData) {
                candidates.push(path.join(localAppData, "Programs", "Git", "cmd", "git.exe"), path.join(localAppData, "Programs", "Git", "bin", "git.exe"));
                candidates.push(...this.githubDesktopGitCandidates(localAppData));
            }
        }
        else {
            candidates.push("git", "/usr/local/bin/git", "/usr/bin/git");
        }
        const seen = new Set();
        return candidates.filter((candidate) => {
            const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    async resolveExecutablePath(executable) {
        if (path.isAbsolute(executable))
            return executable;
        const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
        return await new Promise((resolve) => {
            execFile(locator, [executable], { encoding: "utf8", windowsHide: true }, (error, stdout) => {
                if (error || !stdout) {
                    resolve(executable);
                    return;
                }
                const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
                resolve(first || executable);
            });
        });
    }
    async testExecutable(executable) {
        return await new Promise((resolve) => {
            execFile(executable, ["--version"], {
                cwd: this.vaultPath,
                windowsHide: true,
                encoding: "utf8",
                maxBuffer: 1024 * 1024,
            }, async (error, stdout, stderr) => {
                if (!error) {
                    resolve({
                        executable,
                        resolvedPath: await this.resolveExecutablePath(executable),
                        version: (stdout || "").trim(),
                        ok: true,
                        kind: "none",
                        message: "",
                    });
                    return;
                }
                const message = (stderr || stdout || error.message || `Unable to run ${executable}`).trim();
                resolve({
                    executable,
                    resolvedPath: path.isAbsolute(executable) ? executable : executable,
                    version: "",
                    ok: false,
                    kind: this.classifyGitFailure(message, error.code),
                    message,
                });
            });
        });
    }
    async detectGit(force = false) {
        if (!force && this.detection)
            return this.detection;
        const mode = this.plugin.settings.gitMode || "auto";
        const custom = this.plugin.settings.gitExecutable.trim();
        const candidates = mode === "custom" ? (custom ? [custom] : []) : this.autoCandidates();
        const attempts = [];
        if (!candidates.length) {
            this.detection = {
                available: false,
                mode,
                executable: "",
                resolvedPath: "",
                version: "",
                kind: "not_found",
                message: mode === "custom" ? "No custom Git executable has been configured." : "No Git executable candidates are available.",
                attempts,
            };
            return this.detection;
        }
        for (const executable of candidates) {
            const attempt = await this.testExecutable(executable);
            attempts.push(attempt);
            if (attempt.ok) {
                this.detection = {
                    available: true,
                    mode,
                    executable: attempt.executable,
                    resolvedPath: attempt.resolvedPath,
                    version: attempt.version,
                    kind: "none",
                    message: "",
                    attempts,
                };
                if (mode === "auto" && attempt.resolvedPath) {
                    void this.plugin.rememberDetectedGitPath(attempt.resolvedPath);
                }
                return this.detection;
            }
        }
        const preferredFailure = attempts.find((attempt) => attempt.kind === "xcode_license") ||
            attempts.find((attempt) => attempt.kind === "command_line_tools") ||
            attempts.find((attempt) => attempt.kind === "permission") ||
            attempts.find((attempt) => attempt.kind !== "not_found") ||
            attempts[0];
        this.detection = {
            available: false,
            mode,
            executable: preferredFailure?.executable || "",
            resolvedPath: preferredFailure?.resolvedPath || "",
            version: "",
            kind: preferredFailure?.kind || "not_found",
            message: preferredFailure?.message || "No usable Git installation was found.",
            attempts,
        };
        return this.detection;
    }
    async effectiveExecutable() {
        const environment = await this.detectGit();
        if (!environment.available || !environment.executable) {
            throw new Error(environment.message || "Git is unavailable.");
        }
        return environment.executable;
    }
    async run(args, allowedExitCodes = [0], cwd) {
        this.assertImportComplete();
        const executable = await this.effectiveExecutable();
        return await new Promise((resolve, reject) => {
            execFile(executable, args, {
                cwd: cwd || this.vaultPath,
                windowsHide: true,
                encoding: "utf8",
                maxBuffer: 20 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
                if (error && !allowedExitCodes.includes(code)) {
                    if (error.code === "ENOENT") {
                        this.invalidateDetection();
                        reject(new Error(`Git executable not found: ${executable}`));
                        return;
                    }
                    const message = (stderr || stdout || error.message || "Git command failed").trim();
                    reject(new Error(message));
                    return;
                }
                resolve({ stdout: stdout || "", stderr: stderr || "", code });
            });
        });
    }
    async runBuffer(args, allowedExitCodes = [0], cwd) {
        this.assertImportComplete();
        const executable = await this.effectiveExecutable();
        return await new Promise((resolve, reject) => {
            execFile(executable, args, {
                cwd: cwd || this.vaultPath,
                windowsHide: true,
                encoding: null,
                maxBuffer: 50 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
                if (error && !allowedExitCodes.includes(code)) {
                    if (error.code === "ENOENT") {
                        this.invalidateDetection();
                        reject(new Error(`Git executable not found: ${executable}`));
                        return;
                    }
                    const message = (stderr?.toString("utf8") || stdout?.toString("utf8") || error.message || "Git command failed").trim();
                    reject(new Error(message));
                    return;
                }
                resolve({ stdout: stdout || Buffer.alloc(0), stderr: stderr?.toString("utf8") || "", code });
            });
        });
    }
    isRemoteImportInProgress() {
        return this.remoteImportInProgress;
    }
    cancelNetwork() {
        this.networkAbort?.abort();
    }
    isNetworkBusy() {
        return this.networkAbort !== null;
    }
    async runNetwork(args) {
        this.assertImportComplete();
        if (this.networkAbort)
            throw new Error("Another remote Git operation is in progress.");
        const executable = await this.effectiveExecutable();
        const controller = new AbortController();
        this.networkAbort = controller;
        try {
            return await new Promise((resolve, reject) => {
                execFile(executable, args, {
                    cwd: this.vaultPath,
                    windowsHide: true,
                    encoding: "utf8",
                    maxBuffer: 4 * 1024 * 1024,
                    // Leave time to complete a browser-based credential helper sign-in.
                    timeout: 300000,
                    signal: controller.signal,
                    env: {
                        ...process.env,
                        // GCM may use its GUI/browser; never wait for an invisible TTY
                        // username/password prompt from ordinary Git.
                        GIT_TERMINAL_PROMPT: "0",
                        GCM_INTERACTIVE: "auto",
                    },
                }, (error, stdout, stderr) => {
                    if (error) {
                        // Do not echo Git's raw stderr: it may include credentials embedded
                        // in a remote URL, SSH identities or helper-specific diagnostics.
                        // Push --porcelain prints non-fast-forward rejection details to
                        // stdout; stderr may be localized and therefore insufficient.
                        const details = `${stdout || ""}\n${stderr || ""}\n${error.message || ""}`.toLowerCase();
                        if (controller.signal.aborted)
                            reject(new Error("Remote Git operation cancelled."));
                        else if (error.killed || error.code === "ETIMEDOUT")
                            reject(new Error(args[0] === "push"
                                ? "Push timed out. The server may already have accepted it. Fetch and verify the remote state before retrying."
                                : "Remote Git operation timed out."));
                        else if (/authentication (?:was )?cancelled|authentication (?:was )?canceled|user cancelled|user canceled/.test(details)) {
                            reject(new Error("Git authentication was cancelled. The operation was not automatically retried."));
                        }
                        else if (/authentication failed|could not read username|could not read password|permission denied \(publickey\)|authentication required|invalid credentials|terminal prompts disabled|credential-manager.*not a git command|credential helper.*not found|fatal: could not read/.test(details)) {
                            reject(new RemoteGitAuthenticationError(/publickey|ssh_askpass|ssh-askpass/.test(details)
                                ? "ssh" : "https"));
                        }
                        else if (/403|permission denied to|write access to repository not granted|insufficient permission|not authorized to push|requested url returned error: 403/.test(details)) {
                            reject(new Error("The remote account does not have permission for this operation. Check repository access and your Git account."));
                        }
                        else if (/repository not found|not a git repository|remote: not found|does not appear to be a git repository/.test(details)) {
                            reject(new Error("Remote repository not found or access was denied. Check its URL and your account's repository access."));
                        }
                        else if (/non-fast-forward|fetch first|rejected|failed to push some refs/.test(details)) {
                            reject(new Error("Remote rejected the push. Fetch to inspect upstream changes; no force push was attempted."));
                        }
                        else if (/could not resolve host|network is unreachable|connection refused|unable to access|timed out/.test(details)) {
                            reject(new Error("Cannot reach the remote Git server. Check your connection and repository address."));
                        }
                        else
                            reject(new Error(args[0] === "push"
                                ? "Push result is uncertain. Fetch and verify the remote state before retrying."
                                : "Remote Git operation failed. Check the remote URL, permissions and system Git authentication."));
                        return;
                    }
                    resolve({ stdout: stdout || "", stderr: stderr || "", code: 0 });
                });
            });
        }
        finally {
            if (this.networkAbort === controller)
                this.networkAbort = null;
        }
    }
    validateRemoteUrl(value) {
        const url = value.trim();
        if (!url || url.length > 2048 || /[\s\x00-\x1f]/.test(url) || url.startsWith("-")) {
            throw new Error("Enter a valid HTTPS or SSH repository URL.");
        }
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
            let parsed;
            try {
                parsed = new URL(url);
            }
            catch {
                throw new Error("Invalid remote repository URL.");
            }
            if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || parsed.password || parsed.search || parsed.hash) {
                throw new Error("Only HTTPS and SSH repository URLs without embedded credentials are supported.");
            }
            // HTTPS usernames are credential hints and should not be stored in URL.
            if (parsed.username && parsed.protocol === "https:") {
                throw new Error("Do not include credentials in the remote URL. Use system Git authentication.");
            }
            return url;
        }
        if (!/^[\w.-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s:][^\s]*$/.test(url)) {
            throw new Error("Use an HTTPS or SSH Git repository URL.");
        }
        return url;
    }
    // GitHub CLI uses its own login, separate from Git's credential helper.
    // Look in the common GUI-app locations because Obsidian's PATH can be
    // different from the user's terminal PATH on macOS.
    githubExecutable() {
        const name = process.platform === "win32" ? "gh.exe" : "gh";
        const directories = [
            ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
            ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
        ];
        for (const directory of directories) {
            const candidate = path.join(directory, name);
            try {
                if (fs.statSync(candidate).isFile())
                    return candidate;
            }
            catch { /* Try the next installed location. */ }
        }
        throw new Error("GitHub CLI (gh) is not installed. Install it and run gh auth login, then try again.");
    }
    async githubCli(args) {
        const executable = this.githubExecutable();
        return await new Promise((resolve, reject) => {
            execFile(executable, args, {
                cwd: this.vaultPath,
                encoding: "utf8",
                windowsHide: true,
                maxBuffer: 256 * 1024,
                timeout: 45000,
                env: {
                    ...process.env,
                    GH_PROMPT_DISABLED: "1",
                    GH_NO_UPDATE_NOTIFIER: "1",
                    GIT_TERMINAL_PROMPT: "0",
                },
            }, (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout || "");
                    return;
                }
                // Never show raw CLI output: it can include account or secret details.
                const diagnostic = `${stderr || ""}\n${error.message || ""}`.toLowerCase();
                if (error.killed || error.code === "ETIMEDOUT") {
                    reject(new Error("GitHub did not respond in time. Check GitHub before retrying repository creation."));
                }
                else if (/authentication|not logged|gh auth login|no oauth token|http 401/.test(diagnostic)) {
                    reject(new Error("GitHub CLI is not signed in. Run gh auth login, then try again."));
                }
                else if (/http 422|already exists|name already/.test(diagnostic)) {
                    reject(new Error("This GitHub repository name is unavailable. Choose another name, or connect the existing repository."));
                }
                else if (/http 403|forbidden|permission|resource not accessible/.test(diagnostic)) {
                    reject(new Error("Your GitHub login does not have permission to create this repository. Check your account permissions."));
                }
                else {
                    reject(new Error("GitHub repository creation could not be confirmed. Check your GitHub account before trying Create again."));
                }
            });
        });
    }
    async createGithubRepository(name, visibility) {
        const repository = name.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
            throw new Error("Enter a repository name (1–100 characters: letters, numbers, '.', '_' or '-').");
        }
        if (visibility !== "private" && visibility !== "public")
            throw new Error("Invalid repository visibility.");
        if (!this.hasLocalRepository())
            throw new Error("Initialize the local repository first.");
        this.assertImportComplete();
        if (this.githubCreationInProgress || this.isNetworkBusy())
            throw new Error("Another remote operation is in progress.");
        if ((await this.remoteSummary()).configured)
            throw new Error("Disconnect the existing origin before creating a new remote repository.");
        this.githubCreationInProgress = true;
        let createdUrl;
        try {
            // Check login before issuing any remote write. Do not launch an invisible
            // terminal-based login flow inside Obsidian.
            await this.githubCli(["auth", "status", "--hostname", "github.com"]);
            const output = await this.githubCli([
                "api", "--hostname", "github.com", "--method", "POST", "/user/repos",
                "--raw-field", `name=${repository}`,
                "--field", `private=${visibility === "private"}`,
                "--field", "auto_init=false",
                "--jq", "{name: .name, clone_url: .clone_url, private: .private}",
            ]);
            let response;
            try {
                response = JSON.parse(output);
            }
            catch { /* API may have succeeded. */ }
            const cloneUrl = response?.clone_url;
            const match = typeof cloneUrl === "string"
                ? /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\.git$/.exec(cloneUrl) : null;
            if (!match || match[2].toLowerCase() !== repository.toLowerCase()
                || typeof response?.name !== "string" || response.name.toLowerCase() !== repository.toLowerCase()
                || response?.private !== (visibility === "private")) {
                throw new Error("GitHub may have created the repository, but its response could not be verified. Check GitHub and use Connect existing repository; do not create it again.");
            }
            createdUrl = this.validateRemoteUrl(cloneUrl);
        }
        finally {
            this.githubCreationInProgress = false;
        }
        // Remote creation and local connection are separate transactions. Never
        // attempt a second GitHub create when connecting origin fails.
        try {
            await this.connectRemote(createdUrl);
            return { url: createdUrl, connected: true };
        }
        catch {
            try {
                const current = await this.remoteSummary();
                if (current.configured && current.displayUrl === createdUrl) {
                    return { url: createdUrl, connected: true };
                }
            }
            catch { /* Keep the confirmed remote URL available for recovery. */ }
            return {
                url: createdUrl, connected: false,
                warning: "Repository created on GitHub, but origin could not be connected. Use Connect existing repository with this URL; do not create it again.",
            };
        }
    }
    async connectRemote(url) {
        const validated = this.validateRemoteUrl(url);
        if (this.isNetworkBusy())
            throw new Error("Cancel the running remote operation first.");
        if (!this.hasLocalRepository())
            throw new Error("Initialize the local repository first.");
        const existing = (await this.run(["remote"])).stdout.split(/\r?\n/).map((s) => s.trim());
        if (existing.includes("origin"))
            throw new Error("A remote named origin is already configured. Disconnect it before connecting another.");
        await this.run(["remote", "add", "origin", validated]);
        await this.run(["config", "--local", "vvc.remoteEverConfigured", "true"]);
        await this.run(["config", "--local", "vvc.lastFetchedAt", "0"]);
    }
    async updateRemoteUrl(url) {
        const validated = this.validateRemoteUrl(url);
        if (this.isNetworkBusy())
            throw new Error("Cancel the running remote operation first.");
        if (!(await this.remoteSummary()).configured)
            throw new Error("No origin remote is configured.");
        await this.run(["remote", "set-url", "origin", validated]);
        await this.run(["config", "--local", "vvc.remoteEverConfigured", "true"]);
        await this.run(["config", "--local", "vvc.lastFetchedAt", "0"]);
    }
    async disconnectRemote() {
        if (this.isNetworkBusy())
            throw new Error("Cancel the running remote operation first.");
        if ((await this.run(["remote"])).stdout.split(/\r?\n/).includes("origin")) {
            // Disconnecting must never make a possibly published commit editable.
            await this.run(["config", "--local", "vvc.remoteEverConfigured", "true"]);
            await this.run(["remote", "remove", "origin"]);
            await this.run(["config", "--local", "vvc.lastFetchedAt", "0"]);
        }
    }
    async remoteSummary() {
        const empty = {
            configured: false, remote: "", displayUrl: "", upstream: "", ahead: null, behind: null, lastFetchedAt: null,
        };
        if (!this.hasLocalRepository())
            return empty;
        const names = (await this.run(["remote"])).stdout.split(/\r?\n/).map((s) => s.trim());
        if (!names.includes("origin"))
            return empty;
        const rawUrl = (await this.run(["remote", "get-url", "origin"])).stdout.trim();
        // Never render URL userinfo from an externally configured Git remote.
        const displayUrl = rawUrl.replace(/^([a-z][a-z+.-]*:\/\/)[^@/]+@/i, "$1").split(/[?#]/, 1)[0];
        const upstreamResult = await this.run([
            "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}",
        ], [0, 128]);
        const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : "";
        let ahead = null;
        let behind = null;
        if (upstream) {
            const count = await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], [0, 128]);
            if (count.code === 0) {
                const [a, b] = count.stdout.trim().split(/\s+/).map(Number);
                if (Number.isFinite(a) && Number.isFinite(b)) {
                    ahead = a;
                    behind = b;
                }
            }
        }
        const fetched = await this.run(["config", "--local", "--get", "vvc.lastFetchedAt"], [0, 1]);
        const timestamp = Number(fetched.stdout.trim());
        const lastFetchedAt = fetched.code === 0 && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
        return { configured: true, remote: "origin", displayUrl, upstream, ahead, behind, lastFetchedAt };
    }
    async fetchRemote() {
        if (!(await this.remoteSummary()).configured)
            throw new Error("Connect a remote repository first.");
        await this.runNetwork(["fetch", "--no-tags", "origin"]);
        await this.run(["config", "--local", "vvc.lastFetchedAt", String(Date.now())]);
    }
    async pushRemote(expectedBranch) {
        if (!(await this.remoteSummary()).configured)
            throw new Error("Connect a remote repository first.");
        const branch = await this.currentBranch();
        if (!branch || branch === "(detached)" || branch !== expectedBranch) {
            throw new Error("Current branch changed. Refresh before pushing.");
        }
        await this.run(["config", "--local", "vvc.remoteEverConfigured", "true"]);
        await this.runNetwork(["push", "--porcelain", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`]);
    }
    async gitVersion(force = false) {
        const environment = await this.detectGit(force);
        if (!environment.available)
            throw new Error(environment.message || "Git is unavailable.");
        return environment.version;
    }
    // P1.0 read-only boundary for a checkout-free clone in an isolated staging
    // directory. It must not be used as authorization to write a Vault: another
    // full preflight is required immediately before the eventual P1.2 install.
    async inspectStagedRemoteImport(stagingDirectory) {
        if (this.hasLocalRepository())
            throw new Error("The Vault already has a Git repository.");
        const stagedGit = path.join(stagingDirectory, ".git");
        if (!fs.lstatSync(stagedGit).isDirectory())
            throw new Error("Staged Git repository must use a normal .git directory.");
        const branch = (await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], [0], stagingDirectory)).stdout.trim();
        if (!branch || branch.startsWith("-"))
            throw new Error("Source repository has no usable default branch.");
        const head = (await this.run(["rev-parse", "--verify", "HEAD^{commit}"], [0], stagingDirectory)).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/.test(head))
            throw new Error("Source repository has no complete HEAD commit.");
        const tree = (await this.run(["ls-tree", "--full-tree", "-rz", "-l", "HEAD"], [0], stagingDirectory)).stdout;
        const plan = inspectRemoteImportTree(this.vaultPath, tree);
        // A local .gitignore must not be replaced with source data or silently
        // merged with negations. Refuse ambiguity at preflight, before any writes.
        const trackedIgnoreFiles = [...plan.importFiles, ...plan.existingFiles]
            .filter((name) => name === ".gitignore" || name.endsWith("/.gitignore"));
        for (const ignoreName of trackedIgnoreFiles) {
            if (plan.existingFiles.includes(ignoreName)) {
                const source = (await this.runBuffer(["show", `HEAD:${ignoreName}`], [0], stagingDirectory)).stdout;
                const local = fs.readFileSync(path.join(this.vaultPath, ...ignoreName.split("/")));
                if (!local.equals(source)) {
                    throw new Error(`Local and source ${ignoreName} differ; cannot safely merge their Ignore rules.`);
                }
            }
            else if (ignoreName !== ".gitignore") {
                // Nested ignore patterns are relative to their own directory; using
                // root .git/info/exclude instead would silently track private files.
                throw new Error(`Remote-only nested Ignore file must be imported safely before baseline planning: ${ignoreName}`);
            }
        }
        // Importing only Git object history cannot restore Git LFS payloads.
        // Nor should a newly fetched .gitattributes trigger local clean/smudge
        // helpers while building the initial baseline. Fail closed until LFS and
        // custom filters have an explicit, reviewed implementation.
        const trackedAttributes = [...plan.importFiles, ...plan.existingFiles]
            .filter((name) => name === ".gitattributes" || name.endsWith("/.gitattributes"));
        for (const name of trackedAttributes) {
            const blob = (await this.runBuffer(["show", `HEAD:${name}`], [0], stagingDirectory)).stdout;
            assertSupportedAttributeFile(name, blob);
            if (plan.existingFiles.includes(name)) {
                const local = fs.readFileSync(path.join(this.vaultPath, ...name.split("/")));
                if (!local.equals(blob))
                    throw new Error(`Local and source ${name} differ; refusing ambiguous Git attributes.`);
            }
        }
        for (const name of plan.localOnlyFiles.filter((name) => name === ".gitattributes" || name.endsWith("/.gitattributes"))) {
            assertSupportedAttributeFile(name, fs.readFileSync(checkedVaultFilePath(this.vaultPath, name)));
        }
        await this.run(["read-tree", "HEAD"], [0], stagingDirectory);
        const attributePaths = [...plan.importFiles, ...plan.existingFiles, ...plan.localOnlyFiles];
        await this.assertSupportedWorkingAttributes(attributePaths, stagingDirectory, undefined, true);
        await this.assertSupportedWorkingAttributes(attributePaths, stagingDirectory, this.vaultPath);
        const newLinks = plan.importFiles.filter((name) => plan.symlinkFiles.includes(name));
        if (newLinks.length && process.platform === "win32") {
            throw new Error("Importing Git symbolic links requires a filesystem with native symbolic link support.");
        }
        for (const name of newLinks) {
            if (name === ".gitignore" || name.endsWith("/.gitignore") ||
                name === ".gitattributes" || name.endsWith("/.gitattributes")) {
                throw new Error(`Git Ignore/attributes must be regular files: ${name}`);
            }
            const blob = (await this.runBuffer(["show", `HEAD:${name}`], [0], stagingDirectory)).stdout;
            checkedRemoteSymlinkTarget(name, blob, plan);
        }
        return { sourceHead: head, sourceBranch: branch, plan, pluginIgnoresObsidian: !plan.tracksObsidian };
    }
    // Build C -> D entirely inside the disposable checkout-free clone. Neither
    // this method nor its Git commands modify the live Vault. A production
    // installer must repeat preflight and check the file hashes before writing.
    async prepareRemoteBaseline(stage) {
        const { sourceHead, sourceBranch, plan, pluginIgnoresObsidian } = await this.inspectStagedRemoteImport(stage);
        if (plan.trackedFileCount === 0)
            throw new Error("Source default branch contains no files.");
        const vault = this.vaultPath;
        const localHasIgnore = [...plan.existingFiles, ...plan.localOnlyFiles].includes(".gitignore");
        const remoteHasIgnore = [...plan.existingFiles, ...plan.importFiles].includes(".gitignore");
        const defaultIgnores = pluginIgnoresObsidian
            ? DEFAULT_GITIGNORE
            : DEFAULT_GITIGNORE.replace(/^# Obsidian application state and plugins\n\.obsidian\/\n\n/, "");
        let sourceIgnore = "";
        if (remoteHasIgnore && !localHasIgnore) {
            const raw = (await this.runBuffer(["show", "HEAD:.gitignore"], [0], stage)).stdout;
            if (raw.length > 512 * 1024 || raw.includes(0))
                throw new Error("Source .gitignore is too large or invalid.");
            sourceIgnore = raw.toString("utf8");
            if (!Buffer.from(sourceIgnore, "utf8").equals(raw))
                throw new Error("Source .gitignore encoding is unsupported.");
        }
        // Local .gitignore remains untouched. .git/info/exclude applies the plugin
        // defaults, followed by any source rules absent from the live worktree.
        const excludePath = path.join(stage, ".git", "info", "exclude");
        fs.mkdirSync(path.dirname(excludePath), { recursive: true });
        fs.writeFileSync(excludePath, defaultIgnores + "\n" + sourceIgnore);
        await this.run(["read-tree", "HEAD"], [0], stage);
        // Ask Git to interpret all nested ignore/negation rules. Do NOT run
        // "git add" against user files: a configured clean filter could execute.
        const others = (await this.run(["--work-tree", vault, "ls-files", "--others", "--exclude-standard", "-z"], [0], stage))
            .stdout.split("\0").filter(Boolean);
        const localOnly = new Set(plan.localOnlyFiles);
        if (others.some((name) => !localOnly.has(name))) {
            throw new Error("Vault changed during remote import preflight. Retry.");
        }
        const localSnapshot = [];
        const stageExistingFile = async (name) => {
            const absolute = path.join(vault, ...name.split("/"));
            const info = fs.lstatSync(absolute);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error(`Vault file changed during import: ${name}`);
            const hash = (await this.run(["hash-object", "-w", "--no-filters", "--", absolute], [0], stage)).stdout.trim();
            if (!/^[0-9a-f]{40,64}$/.test(hash))
                throw new Error("Failed to hash Vault content.");
            const mode = info.mode & 0o111 ? "100755" : "100644";
            await this.run(["update-index", "--add", "--cacheinfo", `${mode},${hash},${name}`], [0], stage);
            localSnapshot.push({ path: name, objectId: hash, mode });
        };
        for (const name of plan.existingFiles)
            await stageExistingFile(name);
        for (const name of others)
            await stageExistingFile(name);
        for (const name of plan.deferredObsidian) {
            await this.run(["update-index", "--force-remove", "--", name], [0], stage);
        }
        let generatedGitignore = null;
        if (!remoteHasIgnore && !localHasIgnore) {
            generatedGitignore = defaultIgnores;
            const temp = path.join(stage, "vvc-default-ignore.tmp");
            try {
                fs.writeFileSync(temp, generatedGitignore, { flag: "wx" });
                const hash = (await this.run(["hash-object", "-w", "--no-filters", "--", temp], [0], stage)).stdout.trim();
                await this.run(["update-index", "--add", "--cacheinfo", `100644,${hash},.gitignore`], [0], stage);
            }
            finally {
                if (fs.existsSync(temp))
                    fs.rmSync(temp, { force: true });
            }
        }
        const tree = (await this.run(["write-tree"], [0], stage)).stdout.trim();
        const originalTree = (await this.run(["rev-parse", "HEAD^{tree}"], [0], stage)).stdout.trim();
        const baselineCreated = tree !== originalTree;
        let preparedHead = sourceHead;
        if (baselineCreated) {
            const config = [];
            if (this.plugin.settings.identityMode === "vault") {
                const name = (this.plugin.settings.authorName || "").trim();
                const email = (this.plugin.settings.authorEmail || "").trim();
                if (name && email)
                    config.push("-c", `user.name=${name}`, "-c", `user.email=${email}`);
            }
            const name = (await this.run([...config, "config", "--get", "user.name"], [0, 1], stage)).stdout.trim();
            const email = (await this.run([...config, "config", "--get", "user.email"], [0, 1], stage)).stdout.trim();
            if (!name || !email)
                throw new Error("Set a Git author name and email before remote initialization.");
            preparedHead = (await this.run([...config, "commit-tree", tree, "-p", sourceHead,
                "-m", "Initialize current Vault baseline", "--no-gpg-sign"], [0], stage)).stdout.trim();
            await this.run(["update-ref", `refs/heads/${sourceBranch}`, preparedHead, sourceHead], [0], stage);
        }
        const refs = (await this.run(["for-each-ref", "--format=%(refname) %(objectname)",
            "refs/remotes/origin"], [0], stage)).stdout;
        for (const line of refs.split("\n").filter(Boolean)) {
            const [ref, sha] = line.trim().split(" ");
            if (ref === "refs/remotes/origin/HEAD")
                continue;
            if (!ref.startsWith("refs/remotes/origin/") || !/^[0-9a-f]{40,64}$/.test(sha)) {
                throw new Error("Invalid source branch ref.");
            }
            await this.run(["update-ref", `refs/vvc/import/heads/${ref.slice("refs/remotes/origin/".length)}`, sha], [0], stage);
        }
        await this.run(["remote", "remove", "origin"], [0], stage);
        const finalHead = (await this.run(["rev-parse", "HEAD"], [0], stage)).stdout.trim();
        if (finalHead !== preparedHead)
            throw new Error("Prepared HEAD verification failed.");
        return { sourceHead, preparedHead, baselineCreated, plan,
            trackedLocalOnly: others, generatedGitignore, localSnapshot };
    }
    // Isolated/disposable-Vault integration path. A transaction marker is left
    // on ANY post-claim error; no existing Vault file may be removed or replaced.
    // Production UI remains gated on crash/recovery and live editor validation.
    async installPreparedRemoteBaseline(stage, prepared) {
        if (this.hasLocalRepository())
            throw new Error("The Vault already contains Git metadata.");
        const vault = this.vaultPath;
        const crypto = require("crypto");
        // Obsidian can hold debounced changes not visible to Git status or disk
        // preflight. Refuse writes until every Markdown buffer matches disk.
        assertNoUnsavedMarkdownViews(this.plugin.app, vault);
        const { spawn } = require("child_process");
        const { pipeline } = require("stream/promises");
        const hashAlgorithm = prepared.preparedHead.length === 64 ? "sha256" : "sha1";
        if (!/^[0-9a-f]{40,64}$/.test(prepared.preparedHead) ||
            !/^[0-9a-f]{40,64}$/.test(prepared.sourceHead)) {
            throw new Error("Invalid prepared Git commit identity.");
        }
        // Re-read C from the isolated repository: HEAD may now point at D.
        const sourceTree = (await this.run(["ls-tree", "--full-tree", "-rz", "-l",
            prepared.sourceHead], [0], stage)).stdout;
        const observedPlan = inspectRemoteImportTree(vault, sourceTree);
        if (JSON.stringify(observedPlan) !== JSON.stringify(prepared.plan)) {
            throw new Error("Vault file paths changed after import planning. Retry.");
        }
        const indexEntries = new Map();
        const indexed = (await this.run(["ls-files", "--stage", "-z"], [0], stage)).stdout;
        for (const record of indexed.split("\0").filter(Boolean)) {
            const match = /^(100644|100755|120000) ([0-9a-f]{40,64}) 0\t([^\0]+)$/.exec(record);
            if (!match || indexEntries.has(match[3]))
                throw new Error("Prepared Git index contains an unsupported entry.");
            indexEntries.set(match[3], { mode: match[1], objectId: match[2] });
        }
        const tree = (await this.run(["write-tree"], [0], stage)).stdout.trim();
        const committedTree = (await this.run(["rev-parse", `${prepared.preparedHead}^{tree}`], [0], stage)).stdout.trim();
        if (tree !== committedTree || (await this.run(["rev-parse", "HEAD"], [0], stage)).stdout.trim() !== prepared.preparedHead) {
            throw new Error("Prepared Git index and baseline commit disagree.");
        }
        if ((await this.run(["remote"], [0], stage)).stdout.trim()) {
            throw new Error("Imported source is still configured as a Push remote.");
        }
        const safeFile = (name, exists, mode) => {
            const parts = name.split("/");
            let current = vault;
            for (const part of parts.slice(0, -1)) {
                current = path.join(current, part);
                if (fs.existsSync(current)) {
                    const info = fs.lstatSync(current);
                    if (!info.isDirectory() || info.isSymbolicLink())
                        throw new Error("Vault path changed during import.");
                }
                else if (exists)
                    throw new Error("Existing Vault file directory disappeared.");
            }
            const absolute = path.join(current, parts[parts.length - 1]);
            if (exists) {
                const info = fs.lstatSync(absolute);
                if (mode === "120000" ? !info.isSymbolicLink() : !info.isFile() || info.isSymbolicLink()) {
                    throw new Error("Vault file changed during import.");
                }
            }
            else if (fs.existsSync(absolute) || fs.readdirSync(current).includes(parts[parts.length - 1])) {
                throw new Error("A planned remote-only file now exists. Import will not overwrite it.");
            }
            return absolute;
        };
        const blobHash = (absolute, mode) => {
            const info = fs.lstatSync(absolute);
            if (mode === "120000") {
                if (!info.isSymbolicLink())
                    throw new Error("Expected imported symbolic link is missing.");
                const data = fs.readlinkSync(absolute, { encoding: "buffer" });
                return crypto.createHash(hashAlgorithm).update(`blob ${data.length}\0`).update(data).digest("hex");
            }
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error("Unsupported file appeared during import.");
            const hash = crypto.createHash(hashAlgorithm);
            hash.update(`blob ${info.size}\0`);
            const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
                const chunk = Buffer.allocUnsafe(1024 * 128);
                for (;;) {
                    const count = fs.readSync(fd, chunk, 0, chunk.length, null);
                    if (count === 0)
                        break;
                    hash.update(chunk.subarray(0, count));
                }
            }
            finally {
                fs.closeSync(fd);
            }
            return hash.digest("hex");
        };
        for (const entry of prepared.localSnapshot) {
            const file = safeFile(entry.path, true);
            const mode = fs.lstatSync(file).mode & 0o111 ? "100755" : "100644";
            if (mode !== entry.mode || blobHash(file) !== entry.objectId ||
                indexEntries.get(entry.path)?.objectId !== entry.objectId) {
                throw new Error(`A local Vault file was modified after baseline preparation: ${entry.path}`);
            }
        }
        const plannedNew = prepared.plan.importFiles.concat(prepared.generatedGitignore === null ? [] : [".gitignore"]);
        const linkTargets = new Map();
        for (const file of plannedNew) {
            if (!indexEntries.has(file))
                throw new Error("Prepared baseline is missing a planned remote file.");
            const indexed = indexEntries.get(file);
            if (indexed.mode === "120000") {
                const blob = (await this.runBuffer(["cat-file", "blob", indexed.objectId], [0], stage)).stdout;
                const digest = crypto.createHash(hashAlgorithm).update(`blob ${blob.length}\0`).update(blob).digest("hex");
                if (digest !== indexed.objectId || !prepared.plan.symlinkFiles.includes(file)) {
                    throw new Error("Prepared symbolic link content differs from the remote Git tree.");
                }
                const link = checkedRemoteSymlinkTarget(file, blob, prepared.plan);
                const destination = indexEntries.get(link.resolved);
                if (!destination || !["100644", "100755"].includes(destination.mode)) {
                    throw new Error(`Cannot import symbolic link ${JSON.stringify(file)}: its target ${JSON.stringify(link.resolved)} is not a regular file in the final Git index.`);
                }
                linkTargets.set(file, link);
            }
            // Parent may not exist yet. Verify all existing ancestors now, before .git claim.
            let current = vault;
            for (const segment of file.split("/").slice(0, -1)) {
                current = path.join(current, segment);
                if (fs.existsSync(current)) {
                    const entry = fs.lstatSync(current);
                    if (!entry.isDirectory() || entry.isSymbolicLink()) {
                        throw new Error("Remote path no longer resolves to a regular directory.");
                    }
                }
            }
            if (fs.existsSync(path.join(vault, ...file.split("/")))) {
                throw new Error("Remote-only file was created by another process.");
            }
        }
        const executable = await this.effectiveExecutable();
        // The following call exclusively claims .git and installs the fail-closed
        // marker before copying any metadata; from here failures need recovery.
        const journal = {
            version: 2,
            phase: "claiming-git-directory",
            expectedHead: prepared.preparedHead,
            expectedFiles: plannedNew.map((name) => ({ path: name, ...indexEntries.get(name) })),
        };
        installStagedGitMetadata(vault, path.join(stage, ".git"), undefined, journal);
        const ensureParent = (filename) => {
            let current = vault;
            for (const part of filename.split("/").slice(0, -1)) {
                current = path.join(current, part);
                if (!fs.existsSync(current))
                    fs.mkdirSync(current);
                const info = fs.lstatSync(current);
                if (!info.isDirectory() || info.isSymbolicLink())
                    throw new Error("A remote target directory was replaced during import.");
            }
        };
        const copyBlob = async (file, objectId, mode) => {
            ensureParent(file);
            const target = path.join(vault, ...file.split("/"));
            const child = spawn(executable, ["-C", stage, "cat-file", "blob", objectId], {
                windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            });
            const exited = new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code) => resolve(code));
            });
            try {
                const output = fs.createWriteStream(target, { flags: "wx", mode: mode === "100755" ? 0o755 : 0o644 });
                const [, code] = await Promise.all([pipeline(child.stdout, output), exited]);
                if (code !== 0)
                    throw new Error("Git could not extract an imported file blob.");
                fs.chmodSync(target, mode === "100755" ? 0o755 : 0o644);
            }
            catch (error) {
                child.kill();
                throw error;
            }
        };
        // Create regular targets before links: no temporarily dangling links, even
        // when the source Git tree lists the link before its target file.
        const writeOrder = plannedNew.filter((file) => !linkTargets.has(file))
            .concat(plannedNew.filter((file) => linkTargets.has(file)));
        for (const file of writeOrder) {
            const index = indexEntries.get(file);
            if (file === ".gitignore" && prepared.generatedGitignore !== null) {
                fs.writeFileSync(path.join(vault, file), prepared.generatedGitignore, { flag: "wx", mode: 0o644 });
            }
            else if (index.mode === "120000") {
                const link = linkTargets.get(file);
                const expectedTarget = indexEntries.get(link.resolved);
                const targetFile = safeFile(link.resolved, true, expectedTarget.mode);
                const targetMode = fs.lstatSync(targetFile).mode & 0o111 ? "100755" : "100644";
                if (targetMode !== expectedTarget.mode) {
                    throw new Error(`Cannot install symbolic link ${JSON.stringify(file)}: target ${JSON.stringify(link.resolved)} changed during import.`);
                }
                ensureParent(file);
                fs.symlinkSync(link.target, path.join(vault, ...file.split("/")));
            }
            else {
                await copyBlob(file, index.objectId, index.mode);
            }
        }
        // Verify each index entry against the actual Vault bytes. Git status is
        // deliberately not invoked here; its clean/smudge filters are untrusted.
        for (const [name, entry] of indexEntries) {
            const absolute = safeFile(name, true, entry.mode);
            const info = fs.lstatSync(absolute);
            const actualMode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
            if (actualMode !== entry.mode || blobHash(absolute, entry.mode) !== entry.objectId) {
                throw new Error(`Installed Vault content does not match baseline Git index: ${name}`);
            }
        }
        // Clearing the marker is the final operation, never an intermediate step.
        fs.unlinkSync(path.join(vault, ".git", "vvc-import-pending"));
        // Keep the root marker until after the inner marker is removed, so no
        // observer can see an unguarded half-finished repository.
        fs.unlinkSync(path.join(vault, ".vvc-remote-import-pending"));
    }
    summarizePreparedImport(prepared, sourceBranch) {
        const crypto = require("crypto");
        const snapshot = JSON.stringify({
            sourceHead: prepared.sourceHead,
            sourceBranch,
            plan: prepared.plan,
            trackedLocalOnly: prepared.trackedLocalOnly,
            generatedGitignore: prepared.generatedGitignore,
            localSnapshot: prepared.localSnapshot,
        });
        return {
            sourceHead: prepared.sourceHead,
            sourceBranch,
            plan: prepared.plan,
            pluginIgnoresObsidian: !prepared.plan.tracksObsidian,
            trackedLocalOnly: prepared.trackedLocalOnly,
            baselineCreated: prepared.baselineCreated,
            snapshotFingerprint: crypto.createHash("sha256").update(snapshot).digest("hex"),
        };
    }
    async withStagedRemote(url, action) {
        const validated = this.validateRemoteUrl(url);
        if (this.hasLocalRepository())
            throw new Error("A Git repository already exists in this Vault.");
        if (this.isNetworkBusy())
            throw new Error("Another remote Git operation is in progress.");
        const os = require("os");
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "vvc-remote-import-"));
        const stage = path.join(folder, "source");
        try {
            await this.runNetwork(["clone", "--no-checkout", "--", validated, stage]);
            return await action(stage);
        }
        finally {
            fs.rmSync(folder, { recursive: true, force: true });
        }
    }
    /** Preview only; all Git objects and generated commits stay in disposable storage. */
    async previewRemoteImport(url) {
        if (this.remoteImportInProgress)
            throw new Error("Remote initialization is already running.");
        return this.withStagedRemote(url, async (stage) => {
            const { sourceBranch } = await this.inspectStagedRemoteImport(stage);
            const prepared = await this.prepareRemoteBaseline(stage);
            return this.summarizePreparedImport(prepared, sourceBranch);
        });
    }
    /**
     * Re-clone and recompute a complete snapshot after user confirmation.
     * Any change in source HEAD, Vault files, or effective Ignore decisions
     * invalidates the preview BEFORE installing Git metadata or other files.
     */
    async initializeFromRemote(url, approved, progress) {
        if (this.remoteImportInProgress)
            throw new Error("Remote initialization is already running.");
        this.remoteImportInProgress = true;
        try {
            progress?.("Rechecking remote and local files…");
            await this.withStagedRemote(url, async (stage) => {
                const { sourceBranch } = await this.inspectStagedRemoteImport(stage);
                const prepared = await this.prepareRemoteBaseline(stage);
                const current = this.summarizePreparedImport(prepared, sourceBranch);
                if (current.snapshotFingerprint !== approved.snapshotFingerprint ||
                    current.sourceHead !== approved.sourceHead ||
                    current.sourceBranch !== approved.sourceBranch) {
                    throw new Error("The source history or local Vault changed since preview. Review the updated import before confirming again.");
                }
                progress?.("Installing verified Git history…");
                await this.installPreparedRemoteBaseline(stage, prepared);
            });
        }
        finally {
            this.remoteImportInProgress = false;
        }
    }
    async initRepository() {
        // `git init` is intentionally idempotent. Running it even when a .git path
        // appears to exist makes recovery from an externally deleted/recreated or
        // partially-created repository deterministic instead of trusting stale UI state.
        await this.run(["init", "--quiet"]);
        // Verify that Git itself recognizes the repository before continuing with
        // staging/commit work. A filesystem existence check alone is not sufficient.
        const probe = await this.run(["rev-parse", "--git-dir"], [0, 128]);
        if (probe.code !== 0 || !probe.stdout.trim()) {
            throw new Error("Git initialization completed without creating a usable repository. Check Vault folder permissions and try again.");
        }
        const gitignorePath = path.join(this.vaultPath, ".gitignore");
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE, "utf8");
        }
        await this.applyConfiguredIdentity();
    }
    async applyConfiguredIdentity() {
        if (!this.hasLocalRepository())
            return;
        if (this.plugin.settings.identityMode !== "vault")
            return;
        const { authorName, authorEmail } = this.plugin.settings;
        if (authorName.trim())
            await this.run(["config", "--local", "user.name", authorName.trim()]);
        if (authorEmail.trim())
            await this.run(["config", "--local", "user.email", authorEmail.trim()]);
    }
    async getIdentity() {
        if (!this.hasLocalRepository())
            return { name: "", email: "" };
        const name = await this.run(["config", "--get", "user.name"], [0, 1]);
        const email = await this.run(["config", "--get", "user.email"], [0, 1]);
        return { name: name.stdout.trim(), email: email.stdout.trim() };
    }
    async setLocalIdentity(name, email) {
        await this.run(["config", "--local", "user.name", name.trim()]);
        await this.run(["config", "--local", "user.email", email.trim()]);
    }
    async status() {
        if (!this.hasLocalRepository())
            return [];
        // Porcelain v2 exposes submodule / embedded-repository state explicitly via
        // the <sub> field (for example SC.. or S.M.). That distinction is
        // important: an outer repository can stage only a nested repository's HEAD
        // pointer, never uncommitted working-tree changes inside that repository.
        const result = await this.run([
            "-c", "core.quotepath=false", "status", "--porcelain=v2", "-z", "--untracked-files=all",
        ]);
        const records = result.stdout.split("\0");
        const entries = [];
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (!record)
                continue;
            if (record.startsWith("? ")) {
                entries.push({
                    path: record.slice(2),
                    indexCode: "?",
                    workTreeCode: "?",
                    staged: false,
                    changed: true,
                    isGitLink: false,
                    gitLinkHeadChanged: false,
                    gitLinkDirty: false,
                    gitLinkUntracked: false,
                });
                continue;
            }
            if (record.startsWith("1 ")) {
                const parsed = splitPorcelainFields(record, 8);
                if (!parsed)
                    continue;
                const [, xy = "..", submoduleField = "N..."] = parsed.fields;
                const indexCode = statusCodeFromPorcelainV2(xy[0]);
                const workTreeCode = statusCodeFromPorcelainV2(xy[1]);
                const gitLink = gitLinkFlags(submoduleField);
                entries.push({
                    path: parsed.rest,
                    indexCode,
                    workTreeCode,
                    staged: indexCode !== " ",
                    changed: workTreeCode !== " ",
                    isGitLink: gitLink.isGitLink,
                    gitLinkHeadChanged: gitLink.headChanged,
                    gitLinkDirty: gitLink.dirty,
                    gitLinkUntracked: gitLink.untracked,
                });
                continue;
            }
            if (record.startsWith("2 ")) {
                const parsed = splitPorcelainFields(record, 9);
                if (!parsed)
                    continue;
                const [, xy = "..", submoduleField = "N..."] = parsed.fields;
                const indexCode = statusCodeFromPorcelainV2(xy[0]);
                const workTreeCode = statusCodeFromPorcelainV2(xy[1]);
                const gitLink = gitLinkFlags(submoduleField);
                const originalPath = i + 1 < records.length ? (records[++i] || "") : undefined;
                entries.push({
                    path: parsed.rest,
                    originalPath: originalPath || undefined,
                    indexCode,
                    workTreeCode,
                    staged: indexCode !== " ",
                    changed: workTreeCode !== " ",
                    isGitLink: gitLink.isGitLink,
                    gitLinkHeadChanged: gitLink.headChanged,
                    gitLinkDirty: gitLink.dirty,
                    gitLinkUntracked: gitLink.untracked,
                });
                continue;
            }
            if (record.startsWith("u ")) {
                const parsed = splitPorcelainFields(record, 10);
                if (!parsed)
                    continue;
                const [, xy = "UU", submoduleField = "N..."] = parsed.fields;
                const indexCode = statusCodeFromPorcelainV2(xy[0]);
                const workTreeCode = statusCodeFromPorcelainV2(xy[1]);
                const gitLink = gitLinkFlags(submoduleField);
                entries.push({
                    path: parsed.rest,
                    indexCode,
                    workTreeCode,
                    staged: indexCode !== " ",
                    changed: workTreeCode !== " ",
                    isGitLink: gitLink.isGitLink,
                    gitLinkHeadChanged: gitLink.headChanged,
                    gitLinkDirty: gitLink.dirty,
                    gitLinkUntracked: gitLink.untracked,
                });
            }
        }
        return entries;
    }
    async hasHead() {
        if (!this.hasLocalRepository())
            return false;
        const result = await this.run(["rev-parse", "--verify", "HEAD"], [0, 128]);
        return result.code === 0;
    }
    async isClean() {
        const entries = await this.status();
        return entries.length === 0;
    }
    async fileHasChanges(filePath) {
        if (!this.hasLocalRepository())
            return false;
        const result = await this.run([
            "-c", "core.quotepath=false", "status", "--porcelain=v1", "--", `:(literal)${filePath}`,
        ]);
        return result.stdout.trim().length > 0;
    }
    async stageFile(filePath) {
        await this.run(["add", "--", `:(literal)${filePath}`]);
    }
    async inspectIgnoreFiles(filePaths) {
        if (!this.hasLocalRepository())
            throw new Error("Initialize the local Git repository first.");
        this.assertImportComplete();
        if (!filePaths.length || filePaths.length > 256)
            throw new Error("Select 1–256 files or folders.");
        const unique = [...new Set(filePaths)];
        const result = [];
        for (const filePath of unique) {
            exactGitIgnoreRule(filePath);
            const segments = filePath.split("/");
            if (segments.some((segment) => segment.toLowerCase() === ".git") || filePath === ".gitignore") {
                throw new Error(`Protected Vault or Git configuration cannot be ignored: ${filePath}`);
            }
            let current = this.vaultPath;
            let directory = false;
            for (let i = 0; i < segments.length; i++) {
                current = path.join(current, segments[i]);
                const info = fs.lstatSync(current);
                if (info.isSymbolicLink() ||
                    (i === segments.length - 1 ? !info.isFile() && !info.isDirectory() : !info.isDirectory())) {
                    throw new Error(`Only regular files or directories inside the Vault can be ignored: ${filePath}`);
                }
                if (info.isDirectory() && fs.existsSync(path.join(current, ".git"))) {
                    throw new Error(`This path belongs to a nested Git repository; manage its ignore rules inside that repository: ${filePath}`);
                }
                if (i === segments.length - 1)
                    directory = info.isDirectory();
            }
            // A trailing slash selects descendants, not similarly named siblings.
            const literal = `:(literal)${filePath}${directory ? "/" : ""}`;
            const index = (await this.run(["ls-files", "--stage", "-z", "--", literal])).stdout
                .split("\0").filter(Boolean);
            if ((!directory && index.length > 1) || index.some((entry) => {
                const indexPath = entry.slice(entry.indexOf("\t") + 1);
                return !/^100(?:644|755) [0-9a-f]{40,64} 0\t/.test(entry) ||
                    (directory ? !indexPath.startsWith(filePath + "/") : indexPath !== filePath);
            })) {
                throw new Error(`Path has an unsupported or conflicted Git index entry: ${filePath}`);
            }
            if (directory) {
                // A directory in the worktree can still be a file in the Git index.
                const rootIndex = (await this.run(["ls-files", "--stage", "-z", "--", `:(literal)${filePath}`])).stdout
                    .split("\0").filter(Boolean);
                if (rootIndex.some((entry) => entry.slice(entry.indexOf("\t") + 1) === filePath)) {
                    throw new Error(`Directory conflicts with a tracked file in the Git index: ${filePath}`);
                }
            }
            const staged = (await this.run(["diff", "--cached", "--name-only", "-z", "--", literal])).stdout;
            if (staged)
                throw new Error(`Resolve staged changes for ${filePath} before excluding it from Git.`);
            const ignored = (await this.run(["check-ignore", "--no-index", "-q", "--",
                directory ? filePath + "/" : filePath], [0, 1])).code === 0;
            result.push({ path: filePath, tracked: index.length > 0, trackedFiles: index.length, ignored, directory });
        }
        // Selected parent directories subsume selected descendants.
        return result.filter((entry) => !result.some((parent) => parent.directory && entry.path.startsWith(parent.path + "/")));
    }
    // Capture only the target Git index entries; never reset unrelated staged work.
    async ignoreIndexEntries(files) {
        const map = new Map();
        if (!files.length)
            return map;
        const paths = files.map((file) => `:(literal)${file.path}${file.directory ? "/" : ""}`);
        const records = (await this.run(["ls-files", "--stage", "-z", "--", ...paths])).stdout.split("\0").filter(Boolean);
        for (const entry of records) {
            const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t(.+)$/s.exec(entry);
            if (!match || !files.some((file) => file.directory
                ? match[3].startsWith(file.path + "/") : match[3] === file.path)) {
                throw new Error("Selected paths have unexpected Git index entries; retry without changing the index.");
            }
            if (map.has(match[3]))
                throw new Error("Selected paths have duplicated Git index entries.");
            map.set(match[3], { mode: match[1], hash: match[2] });
        }
        return map;
    }
    sameIgnoreIndex(expected, actual, allowRemoved) {
        for (const [name, value] of actual) {
            const original = expected.get(name);
            if (!original || original.mode !== value.mode || original.hash !== value.hash)
                return false;
        }
        return allowRemoved || actual.size === expected.size;
    }
    async ignoreHead() {
        return await this.hasHead() ? (await this.run(["rev-parse", "HEAD"])).stdout.trim() : "";
    }
    async ignoreStageEntry() {
        const raw = (await this.run(["ls-files", "--stage", "-z", "--", ":(literal).gitignore"])).stdout;
        if (!raw)
            return null;
        const match = /^(100644|100755) ([0-9a-f]{40,64}) 0\t\.gitignore\0$/.exec(raw);
        if (!match)
            throw new Error("The staged .gitignore has an unsupported or conflicted entry.");
        return { mode: match[1], hash: match[2] };
    }
    sameIgnoreEntry(left, right) {
        return left?.mode === right?.mode && left?.hash === right?.hash && (left === null) === (right === null);
    }
    async ignoreStageText(entry) {
        if (!entry)
            return "";
        const bytes = (await this.runBuffer(["cat-file", "blob", entry.hash])).stdout;
        if (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
            throw new Error("Staged .gitignore is not valid UTF-8 text.");
        }
        return bytes.toString("utf8");
    }
    // Construct an index blob from the STAGED content, never the worktree.
    // This cannot accidentally stage pre-existing user edits.
    async ignoreWriteStage(before, text) {
        if (!this.sameIgnoreEntry(before, await this.ignoreStageEntry())) {
            throw new Error("Staged .gitignore changed during Ignore; retry.");
        }
        const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "vvc-ignore-"));
        const file = path.join(tmp, "rules");
        try {
            fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
            const hash = (await this.run(["hash-object", "-w", "--", file])).stdout.trim();
            if (!/^[0-9a-f]{40,64}$/.test(hash))
                throw new Error("Invalid hash for staged ignore rules.");
            if (!this.sameIgnoreEntry(before, await this.ignoreStageEntry())) {
                throw new Error("Staged .gitignore changed during Ignore; retry.");
            }
            const after = { mode: before?.mode || "100644", hash };
            try {
                await this.run(["update-index", "--add", "--cacheinfo", after.mode, after.hash, ".gitignore"]);
                if (!this.sameIgnoreEntry(after, await this.ignoreStageEntry())) {
                    throw new Error("Could not verify staged ignore rules.");
                }
            }
            catch (error) {
                // Git can change the index before an execution error is reported.
                // Recover our exact blob only when it is still the current entry.
                try {
                    const current = await this.ignoreStageEntry();
                    if (this.sameIgnoreEntry(current, after)) {
                        await this.ignoreRestoreStage(after, before);
                    }
                    else if (!this.sameIgnoreEntry(current, before)) {
                        throw new Error("Staged .gitignore was concurrently changed.");
                    }
                }
                catch {
                    throw new Error("Staging the ignore rule failed and the index could not be safely restored. Check .gitignore before retrying.");
                }
                throw error;
            }
            return after;
        }
        finally {
            try {
                fs.unlinkSync(file);
            }
            catch { }
            try {
                fs.rmdirSync(tmp);
            }
            catch { }
        }
    }
    async ignoreRestoreStage(after, before) {
        if (!this.sameIgnoreEntry(after, await this.ignoreStageEntry())) {
            throw new Error("Staged .gitignore changed; refusing to overwrite it.");
        }
        if (before) {
            await this.run(["update-index", "--add", "--cacheinfo", before.mode, before.hash, ".gitignore"]);
        }
        else {
            await this.run(["update-index", "--force-remove", "--", ".gitignore"]);
        }
        if (!this.sameIgnoreEntry(before, await this.ignoreStageEntry())) {
            throw new Error("Staged .gitignore could not be restored.");
        }
    }
    ignoreRestoreWorktree(before, after) {
        const dest = path.join(this.vaultPath, ".gitignore");
        const stat = fs.lstatSync(dest);
        if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(dest).equals(after)) {
            throw new Error(".gitignore has been changed by another operation.");
        }
        if (before === null)
            fs.unlinkSync(dest);
        else
            fs.writeFileSync(dest, before);
    }
    async ignoreRestoreTargets(files, snapshot) {
        const now = await this.ignoreIndexEntries(files);
        if (!this.sameIgnoreIndex(snapshot, now, true)) {
            throw new Error("Target Git index changed outside this Ignore operation.");
        }
        for (const [name, original] of snapshot) {
            if (now.has(name))
                continue;
            await this.run(["update-index", "--add", "--cacheinfo", original.mode, original.hash, name]);
        }
        if (!this.sameIgnoreIndex(snapshot, await this.ignoreIndexEntries(files), false)) {
            throw new Error("Could not verify restored target Git index.");
        }
    }
    async undoLastIgnore(id) {
        if (this.ignoreInProgress || this.isNetworkBusy())
            throw new Error("Another Git operation is in progress.");
        const undo = this.ignoreUndoStack[this.ignoreUndoStack.length - 1];
        if (!undo || undo.id !== id)
            throw new Error("Only the most recent Ignore operation can be undone.");
        this.ignoreInProgress = true;
        try {
            if ((await this.ignoreHead()) !== undo.head)
                throw new Error("Git HEAD changed; Undo is no longer safe.");
            if (!this.sameIgnoreEntry(undo.stageAfter, await this.ignoreStageEntry())) {
                throw new Error("Staged .gitignore changed since Ignore; Undo cannot overwrite it.");
            }
            const dest = path.join(this.vaultPath, ".gitignore");
            const stat = fs.lstatSync(dest);
            if (!stat.isFile() || stat.isSymbolicLink() ||
                !fs.readFileSync(dest).equals(undo.workAfter)) {
                throw new Error(".gitignore changed since Ignore; Undo cannot overwrite it.");
            }
            if ((await this.ignoreIndexEntries(undo.files)).size !== 0) {
                throw new Error("Target Git index changed since Ignore; Undo cannot overwrite it.");
            }
            await this.ignoreRestoreTargets(undo.files, undo.targets);
            await this.ignoreRestoreStage(undo.stageAfter, undo.stageBefore);
            this.ignoreRestoreWorktree(undo.workBefore, undo.workAfter);
            this.ignoreUndoStack.pop();
        }
        finally {
            this.ignoreInProgress = false;
        }
    }
    async verifyManagedIgnoreRules() {
        if (!this.ignoreUndoStack.length)
            return;
        const head = await this.ignoreHead();
        const staged = (await this.ignoreStageText(await this.ignoreStageEntry())).split(/\r?\n/);
        for (const undo of this.ignoreUndoStack) {
            if (undo.head !== head)
                continue;
            for (const rule of undo.rules) {
                if (!staged.includes(rule)) {
                    throw new Error("An Ignore from Git rule has been removed from staging. Review .gitignore before committing.");
                }
            }
        }
    }
    async ignoreFiles(filePaths) {
        if (this.ignoreInProgress || this.isNetworkBusy())
            throw new Error("Another Git operation is in progress.");
        this.ignoreInProgress = true;
        try {
            const inspected = await this.inspectIgnoreFiles(filePaths);
            const actionable = inspected.filter((entry) => entry.tracked || !entry.ignored);
            if (!actionable.length)
                return { changed: 0, untracked: 0, alreadyIgnored: inspected.length, trackedFiles: 0 };
            const tracked = actionable.filter((entry) => entry.tracked);
            const originalIndex = await this.ignoreIndexEntries(tracked);
            if (originalIndex.size !== tracked.reduce((sum, item) => sum + item.trackedFiles, 0)) {
                throw new Error("The selected Git index changed during inspection. Retry.");
            }
            const head = await this.ignoreHead();
            const ignorePath = path.join(this.vaultPath, ".gitignore");
            let before = null;
            try {
                const info = fs.lstatSync(ignorePath);
                if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
                    throw new Error("The Vault .gitignore is not a safe regular text file.");
                }
                before = fs.readFileSync(ignorePath);
                if (before.includes(0) || !Buffer.from(before.toString("utf8"), "utf8").equals(before)) {
                    throw new Error("The Vault .gitignore must be valid UTF-8 without NUL bytes.");
                }
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    throw error;
            }
            const stageBefore = await this.ignoreStageEntry();
            if (!stageBefore && await this.hasHead()) {
                const inHead = (await this.run(["ls-tree", "-z", "HEAD", "--", ".gitignore"])).stdout;
                if (inHead)
                    throw new Error(".gitignore is staged for deletion. Resolve its staged deletion before Ignore.");
            }
            const stageOriginal = await this.ignoreStageText(stageBefore);
            const original = before === null ? "" : before.toString("utf8");
            const rules = [...new Set(actionable.map((entry) => exactGitIgnoreRule(entry.path, entry.directory)))];
            const append = (text) => {
                const newline = text.includes("\r\n") ? "\r\n" : "\n";
                const existing = new Set(text.split(/\r?\n/));
                const missing = rules.filter((rule) => !existing.has(rule));
                return text + (missing.length
                    ? (text && !text.endsWith("\n") ? newline : "") + missing.join(newline) + newline : "");
            };
            const workAfter = Buffer.from(append(original), "utf8");
            const stageText = append(stageOriginal);
            let workChanged = false;
            let stageChanged = false;
            let stageAfter = null;
            let rmStarted = false;
            try {
                if (!workAfter.equals(before ?? Buffer.alloc(0))) {
                    if (before === null) {
                        fs.writeFileSync(ignorePath, workAfter, { flag: "wx" });
                    }
                    else {
                        if (!fs.readFileSync(ignorePath).equals(before)) {
                            throw new Error(".gitignore changed while Ignore was being prepared. Retry.");
                        }
                        fs.appendFileSync(ignorePath, workAfter.subarray(before.length));
                    }
                    workChanged = true;
                }
                for (const entry of actionable) {
                    const applied = await this.run(["check-ignore", "--no-index", "-q", "--",
                        entry.directory ? entry.path + "/" : entry.path], [0, 1]);
                    if (applied.code !== 0) {
                        throw new Error("An existing ignore rule overrides the selection: " + entry.path + ". No files were untracked.");
                    }
                }
                if (stageText !== stageOriginal) {
                    stageAfter = await this.ignoreWriteStage(stageBefore, stageText);
                    stageChanged = true;
                }
                else
                    stageAfter = stageBefore;
                if (tracked.length) {
                    if (!this.sameIgnoreIndex(originalIndex, await this.ignoreIndexEntries(tracked), false)) {
                        throw new Error("Selected Git index entries changed during Ignore. Retry.");
                    }
                    rmStarted = true;
                    await this.run(["rm", "--cached", "-r", "-q", "--",
                        ...tracked.map((entry) => ":(literal)" + entry.path + (entry.directory ? "/" : ""))]);
                    if ((await this.ignoreIndexEntries(tracked)).size) {
                        throw new Error("Not all selected Git index entries were removed.");
                    }
                }
            }
            catch (error) {
                let targetOK = true;
                let stageOK = !stageChanged;
                let workOK = !workChanged;
                try {
                    if (rmStarted)
                        await this.ignoreRestoreTargets(tracked, originalIndex);
                }
                catch {
                    targetOK = false;
                }
                if (targetOK) {
                    try {
                        if (stageChanged) {
                            await this.ignoreRestoreStage(stageAfter, stageBefore);
                            stageOK = true;
                        }
                    }
                    catch {
                        stageOK = false;
                    }
                    if (stageOK && workChanged) {
                        try {
                            this.ignoreRestoreWorktree(before, workAfter);
                            workOK = true;
                        }
                        catch {
                            workOK = false;
                        }
                    }
                }
                const cause = error instanceof Error ? error.message : String(error);
                if (!targetOK || !stageOK || !workOK) {
                    throw new Error("Ignore failed: " + cause +
                        ". Partial changes may remain; inspect the target Git index and .gitignore before retrying.");
                }
                throw error;
            }
            const undoId = ++this.ignoreUndoSerial;
            this.ignoreUndoStack.push({
                id: undoId, head, files: tracked, targets: originalIndex,
                workBefore: before, workAfter, stageBefore, stageAfter, rules,
            });
            return {
                changed: actionable.length, untracked: tracked.length,
                alreadyIgnored: inspected.length - actionable.length,
                trackedFiles: originalIndex.size, undoId,
            };
        }
        finally {
            this.ignoreInProgress = false;
        }
    }
    async stageAll() {
        await this.run(["add", "-A"]);
    }
    async unstageFile(filePath) {
        if (await this.hasHead()) {
            await this.run(["reset", "-q", "HEAD", "--", `:(literal)${filePath}`]);
        }
        else {
            await this.run(["rm", "--cached", "-q", "--ignore-unmatch", "--", `:(literal)${filePath}`]);
        }
    }
    async unstageAll() {
        if (await this.hasHead()) {
            await this.run(["reset", "-q", "HEAD", "--", "."]);
        }
        else {
            await this.run(["rm", "-r", "--cached", "-q", "--ignore-unmatch", "."]);
        }
    }
    async commit(message) {
        await this.verifyManagedIgnoreRules();
        await this.applyConfiguredIdentity();
        await this.run(["commit", "-m", message]);
        this.ignoreUndoStack = [];
    }
    async commitMessage(hash) {
        if (!/^[0-9a-f]{40,64}$/i.test(hash))
            throw new Error("Invalid commit identifier.");
        return (await this.run(["log", "-1", "--format=%B", hash])).stdout.trimEnd();
    }
    /**
     * Reword only the current, unpublished branch tip. Editing older commits
     * would rewrite all their descendants, which requires a separate workflow.
     */
    async editableHeadCommit(expectedHash) {
        if (!/^[0-9a-f]{40,64}$/i.test(expectedHash))
            throw new Error("Invalid commit identifier.");
        if (!this.hasLocalRepository())
            throw new Error("Git repository unavailable.");
        const head = (await this.run(["rev-parse", "--verify", "HEAD"])).stdout.trim();
        if (head !== expectedHash) {
            throw new Error("The selected commit is no longer the current branch tip. Refresh Vault History.");
        }
        const currentRef = (await this.run(["symbolic-ref", "--quiet", "HEAD"], [0, 1])).stdout.trim();
        if (!currentRef.startsWith("refs/heads/"))
            throw new Error("Switch to a local branch before editing its latest commit.");
        const refsAtHead = (await this.run(["for-each-ref", "--points-at", head, "--format=%(refname)"])).stdout.trim().split("\n").filter(Boolean);
        if (refsAtHead.length !== 1 || refsAtHead[0] !== currentRef) {
            throw new Error("This commit is shared by another reference or tag. Its message cannot be safely edited here.");
        }
        const containingRefs = (await this.run([
            "for-each-ref", `--contains=${head}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags",
        ])).stdout.trim().split("\n").filter(Boolean);
        if (containingRefs.length !== 1 || containingRefs[0] !== currentRef) {
            throw new Error("Another branch, remote reference or tag contains this commit. Editing it would rewrite shared history.");
        }
        // Remote-tracking refs are not proof of what has or has not been pushed:
        // they may be stale, or have been deleted. With no online verification,
        // fail closed for any repository that has configured remotes or retains
        // remote-tracking history. This intentionally excludes some unpushed tips.
        const configuredRemotes = (await this.run(["remote"])).stdout.trim();
        if (configuredRemotes) {
            throw new Error("This Vault has a configured Git remote. To avoid rewriting a possibly pushed commit, message editing is available only in local-only repositories.");
        }
        const remoteHistory = (await this.run(["for-each-ref", "--format=%(refname)", "refs/remotes"])).stdout.trim();
        if (remoteHistory) {
            throw new Error("This Vault retains remote-tracking history. Message editing is disabled because the commit may have been pushed.");
        }
        const remotePreviouslyConnected = await this.run(["config", "--local", "--bool", "--get", "vvc.remoteEverConfigured"], [0, 1]);
        const importedRefs = (await this.run(["for-each-ref", "--format=%(refname)", "refs/vvc/import"])).stdout.trim();
        if (remotePreviouslyConnected.stdout.trim() === "true" || importedRefs) {
            throw new Error("This Vault has previously connected or imported remote history. Rewording a possibly shared commit is disabled.");
        }
        const raw = (await this.run(["cat-file", "-p", head])).stdout;
        if (/^gpgsig(?:-| )/m.test(raw.split("\n\n", 1)[0])) {
            throw new Error("Signed commits cannot be reworded here because their signatures would be invalidated.");
        }
        const message = await this.commitMessage(head);
        return { hash: head, message, ref: currentRef };
    }
    async rewordHeadCommit(expectedHash, newMessage) {
        const message = newMessage.trim();
        if (!message)
            throw new Error("Enter a commit message.");
        if (message.includes("\0"))
            throw new Error("A commit message cannot contain null characters.");
        const old = await this.editableHeadCommit(expectedHash);
        if (message === old.message.trim())
            throw new Error("The commit message has not changed.");
        await this.applyConfiguredIdentity();
        const raw = (await this.runBuffer(["cat-file", "commit", old.hash])).stdout;
        if (!Buffer.from(raw.toString("utf8"), "utf8").equals(raw))
            throw new Error("Unsupported commit encoding.");
        const headers = raw.toString("utf8").split("\n\n", 1)[0].split("\n");
        if (headers.some((line) => !/^(tree|parent|author|committer) /.test(line))) {
            throw new Error("Commit contains unsupported metadata; its message cannot be rewritten safely.");
        }
        const tree = headers.find((line) => line.startsWith("tree "))?.slice(5);
        const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
        const author = /^author (.*) <([^<>]*)> ([0-9]+) ([+-][0-9]{4})$/.exec(headers.find((line) => line.startsWith("author ")) || "");
        if (!author || !/^[0-9a-f]{40,64}$/.test(tree || "") || parents.some((sha) => !/^[0-9a-f]{40,64}$/.test(sha))) {
            throw new Error("Malformed original commit metadata.");
        }
        const os = require("os");
        const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "vvc-reword-hooks-"));
        let updated;
        try {
            const executable = await this.effectiveExecutable();
            this.assertImportComplete();
            const args = ["-c", `core.hooksPath=${hooksDir}`, "commit-tree", tree,
                ...parents.flatMap((sha) => ["-p", sha]), "--no-gpg-sign", "-m", message];
            updated = await new Promise((resolve, reject) => {
                execFile(executable, args, { cwd: this.vaultPath, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024,
                    env: { ...process.env, GIT_AUTHOR_NAME: author[1], GIT_AUTHOR_EMAIL: author[2], GIT_AUTHOR_DATE: `@${author[3]} ${author[4]}` },
                }, (error, stdout, stderr) => {
                    if (error)
                        reject(new Error(stderr || "Unable to create replacement commit."));
                    else
                        resolve(stdout.trim());
                });
            });
            if (!/^[0-9a-f]{40,64}$/.test(updated) || updated === old.hash)
                throw new Error("Git did not create a replacement commit.");
            const currentRef = (await this.run(["symbolic-ref", "--quiet", "HEAD"], [0, 1])).stdout.trim();
            if (currentRef !== old.ref)
                throw new Error("Current branch changed. Refresh before editing its message.");
            // CAS applies only to the selected branch, never the later value of HEAD.
            await this.run(["-c", `core.hooksPath=${hooksDir}`, "update-ref", "-m", "vvc: edit commit message", old.ref, updated, old.hash]);
        }
        finally {
            fs.rmSync(hooksDir, { recursive: true, force: true });
        }
        return updated;
    }
    async currentBranch() {
        if (!this.hasLocalRepository())
            return "";
        const direct = await this.run(["branch", "--show-current"], [0, 128]);
        if (direct.stdout.trim())
            return direct.stdout.trim();
        const symbolic = await this.run(["symbolic-ref", "--short", "HEAD"], [0, 128]);
        return symbolic.stdout.trim() || "(detached)";
    }
    async branches() {
        if (!this.hasLocalRepository())
            return [];
        const result = await this.run([
            "branch",
            "--format=%(refname:short)\t%(HEAD)\t%(objectname)\t%(objectname:short)\t%(subject)",
        ]);
        const branches = result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
            const [name = "", head = "", hash = "", shortHash = "", ...subjectParts] = line.split("\t");
            return {
                name,
                current: head.trim() === "*",
                hash,
                shortHash,
                subject: subjectParts.join("\t"),
            };
        });
        const current = await this.currentBranch();
        if (current && current !== "(detached)" && !branches.some((branch) => branch.name === current)) {
            branches.unshift({ name: current, current: true, hash: "", shortHash: "", subject: "" });
        }
        return branches;
    }
    async switchBranch(name) {
        await this.effectiveExecutable();
        assertNoUnsavedMarkdownViews(this.plugin.app, this.vaultPath);
        await this.run(["switch", "--no-overwrite-ignore", name]);
    }
    async validateBranchName(name) {
        await this.run(["check-ref-format", "--branch", name]);
    }
    async createBranchFromCommit(name, commit) {
        await this.validateBranchName(name);
        assertNoUnsavedMarkdownViews(this.plugin.app, this.vaultPath);
        await this.run(["switch", "--no-overwrite-ignore", "-c", name, commit]);
    }
    async branchOrigins(branches) {
        if (!this.hasLocalRepository())
            return [];
        const separator = "\u001f";
        const candidates = branches.filter((branch) => Boolean(branch.name));
        const resolved = await Promise.all(candidates.map(async (branch) => {
            const result = await this.run([
                "reflog", "show", "-n1",
                "--grep-reflog=^branch: Created from ",
                `--format=%H${separator}%gs`,
                branch.name,
            ], [0, 1, 128]);
            if (result.code !== 0)
                return null;
            for (const line of result.stdout.split(/\r?\n/)) {
                if (!line)
                    continue;
                const [hash = "", ...subjectParts] = line.split(separator);
                const subject = subjectParts.join(separator);
                if (/^branch: Created from /i.test(subject) && hash) {
                    return { branch: branch.name, hash };
                }
            }
            return null;
        }));
        return resolved.filter((origin) => origin !== null);
    }
    async vaultGraph(limit = HISTORY_LIMIT) {
        if (!this.hasLocalRepository() || !(await this.hasHead()))
            return [];
        const marker = "\u0001";
        const separator = "\u001f";
        const result = await this.run([
            "log", "--all", "--decorate", "--topo-order", `-n${limit}`,
            `--pretty=format:${marker}%H${separator}%h${separator}%P${separator}%ct${separator}%D${separator}%s`,
        ]);
        const entries = [];
        for (const line of result.stdout.split(/\r?\n/)) {
            if (!line || !line.startsWith(marker))
                continue;
            const fields = line.slice(marker.length).split(separator);
            entries.push({
                hash: fields[0] || "",
                shortHash: fields[1] || "",
                parents: fields[2] || "",
                timestamp: Number(fields[3] || 0),
                decorations: fields[4] || "",
                subject: fields.slice(5).join(separator),
            });
        }
        return entries;
    }
    async historicalRemovalPatch(entry) {
        if (!/^[0-9a-f]{40,64}$/.test(entry.hash))
            throw new Error("Invalid historical commit.");
        if (await this.historicalFileBlob(entry)) {
            throw new Error("This commit contains a file version rather than a removal event.");
        }
        checkedVaultFilePath(this.vaultPath, entry.pathAtCommit);
        const output = await this.runBuffer([
            "show", "--format=", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=D",
            entry.hash, "--", `:(literal)${entry.pathAtCommit}`,
        ]);
        if (output.stdout.length > 1024 * 1024) {
            throw new Error("This historical patch is too large to display in the plugin.");
        }
        return output.stdout.toString("utf8");
    }
    async isFileTracked(filePath) {
        checkedVaultFilePath(this.vaultPath, filePath);
        return Boolean((await this.run(["ls-files", "--stage", "-z", "--", `:(literal)${filePath}`])).stdout);
    }
    async fileHistory(filePath, limit = 80) {
        if (!this.hasLocalRepository() || !(await this.hasHead()))
            return [];
        const result = await this.run([
            "log", "--follow", `-n${limit}`, "--name-only", "-z",
            "--format=%H%x00%h%x00%ct%x00%D%x00%s%x00", "--", `:(literal)${filePath}`,
        ]);
        const tokens = result.stdout.split("\0");
        const history = [];
        for (let i = 0; i < tokens.length;) {
            if (!tokens[i]) {
                i++;
                continue;
            }
            const hash = tokens[i++];
            if (!/^[0-9a-f]{40,64}$/.test(hash) || i + 4 > tokens.length) {
                throw new Error("Malformed file history; refusing to use an ambiguous file path.");
            }
            const shortHash = tokens[i++], timestamp = Number(tokens[i++]);
            const decorations = tokens[i++], subject = tokens[i++];
            if (tokens[i++] !== "")
                throw new Error("Malformed file history separator.");
            // Git inserts exactly one structural LF before the first name. All
            // remaining bytes, including a filename's own LF, are literal.
            const name = tokens[i++] || "";
            if (!name.startsWith("\n"))
                throw new Error("Malformed file history path.");
            history.push({ hash, shortHash, timestamp, decorations, subject,
                pathAtCommit: name.slice(1) || filePath });
        }
        // Git logs include the commit which removed the path from the tree.
        // Classify events using actual Git trees, with bounded parallel reads.
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(8, history.length) }, async () => {
            while (cursor < history.length) {
                const index = cursor++;
                history[index].contentAvailable = Boolean(await this.historicalFileBlob(history[index]));
            }
        }));
        return history;
    }
    async historicalFileBlob(entry) {
        if (!/^[0-9a-f]{40,64}$/.test(entry.hash))
            throw new Error("Invalid historical commit identifier.");
        const tree = (await this.run(["ls-tree", "--full-tree", "-z", entry.hash, "--",
            `:(literal)${entry.pathAtCommit}`])).stdout;
        if (!tree)
            return null;
        const records = tree.split("\0").filter(Boolean);
        const match = records.length === 1 &&
            /^(100644|100755) blob ([0-9a-f]{40,64})\t([^\0]+)$/.exec(records[0]);
        if (!match || match[3] !== entry.pathAtCommit) {
            throw new Error("Unsupported or ambiguous historical file type.");
        }
        return { mode: match[1], hash: match[2] };
    }
    ensureHistoryPreviewIgnored() {
        const gitDir = this.gitDirPath();
        const infoDir = path.join(gitDir, "info");
        const excludePath = path.join(infoDir, "exclude");
        const rule = "~vault-version-control-history-preview-*.md";
        fs.mkdirSync(infoDir, { recursive: true });
        let existing = "";
        try {
            if (fs.existsSync(excludePath))
                existing = fs.readFileSync(excludePath, "utf8");
        }
        catch {
            existing = "";
        }
        const lines = existing.split(/\r?\n/).map((line) => line.trim());
        if (lines.includes(rule))
            return;
        const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
        fs.appendFileSync(excludePath, `${prefix}# Vault Version Control temporary history previews\n${rule}\n`, "utf8");
    }
    async readFileVersion(entry) {
        const file = await this.historicalFileBlob(entry);
        if (!file)
            throw new Error("This commit does not contain this file. Choose an earlier version.");
        return (await this.runBuffer(["cat-file", "blob", file.hash])).stdout;
    }
    async assertSupportedWorkingAttributes(files, cwd, workTree, cached = false) {
        const batches = [];
        let batch = [], bytes = 0;
        for (const name of files) {
            const count = Buffer.byteLength(name, "utf8") + 1;
            if (batch.length && bytes + count > 8192) {
                batches.push(batch);
                batch = [];
                bytes = 0;
            }
            batch.push(name);
            bytes += count;
        }
        if (batch.length)
            batches.push(batch);
        for (const names of batches) {
            const args = workTree ? ["--work-tree", workTree] : [];
            args.push("check-attr", "-z", ...(cached ? ["--cached"] : []), "working-tree-encoding", "filter", "--", ...names);
            const fields = (await this.run(args, [0], cwd)).stdout.split("\0");
            if (fields.pop() !== "" || fields.length !== names.length * 6)
                throw new Error("Unable to verify effective Git attributes.");
            for (let i = 0; i < fields.length; i += 3) {
                if (!["unspecified", "unset"].includes(fields[i + 2])) {
                    throw new Error(`Unsupported ${fields[i + 1]} encoding/filter attribute for ${fields[i]}. Raw import/restore was refused.`);
                }
            }
        }
    }
    captureWorkingFileSnapshot(filePath) {
        return snapshotRegularFile(checkedVaultFilePath(this.vaultPath, filePath));
    }
    async restoreFile(filePath, entry, expected) {
        const before = expected ?? this.captureWorkingFileSnapshot(filePath);
        assertNoUnsavedMarkdownViews(this.plugin.app, this.vaultPath, new Set([filePath]));
        if (!/^[0-9a-f]{40,64}$/i.test(entry.hash))
            throw new Error("Invalid commit identifier.");
        await this.run(["cat-file", "-e", `${entry.hash}^{commit}`]);
        const historical = await this.historicalFileBlob(entry);
        // "Use this version" must never interpret missing history as a
        // request to physically delete a local file.
        if (!historical) {
            throw new Error("This commit does not contain this file. Choose an earlier version. The local file was not changed.");
        }
        const content = (await this.runBuffer(["cat-file", "blob", historical.hash])).stdout;
        const historicalMode = historical.mode === "100755" ? 0o755 : 0o644;
        await this.assertSupportedWorkingAttributes([filePath]);
        const needsUnstage = await this.fileHasChanges(filePath);
        const metadata = (await this.run(["rev-parse", "--absolute-git-dir"])).stdout.trim();
        const absolute = checkedVaultFilePath(this.vaultPath, filePath);
        const unchanged = (snapshot) => JSON.stringify(this.captureWorkingFileSnapshot(filePath)) === JSON.stringify(snapshot);
        if (!unchanged(before))
            throw new Error("File changed since confirmation. Review and retry.");
        assertNoUnsavedMarkdownViews(this.plugin.app, this.vaultPath, new Set([filePath]));
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        checkedVaultFilePath(this.vaultPath, filePath);
        const metadataStat = fs.lstatSync(metadata);
        if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink() ||
            metadataStat.dev !== fs.statSync(path.dirname(absolute)).dev) {
            throw new Error("Restore requires normal Git metadata on the same filesystem as the target.");
        }
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const tempPath = path.join(metadata, `vvc-restore-${nonce}.tmp`);
        const backupPath = path.join(metadata, `vvc-restore-${nonce}.bak`);
        const description = backupPath + ".json";
        let backedUp = false;
        let installed = null;
        let ownsTemp = false;
        try {
            fs.writeFileSync(tempPath, content, { flag: "wx", mode: historicalMode });
            ownsTemp = true;
            fs.chmodSync(tempPath, historicalMode);
            if (!unchanged(before))
                throw new Error("File changed before installation. Review and retry.");
            if (before.exists) {
                fs.writeFileSync(description, JSON.stringify({ path: filePath, sha256: before.sha256 }) + "\n", { flag: "wx", mode: 0o600 });
                fs.copyFileSync(absolute, backupPath, fs.constants.COPYFILE_EXCL);
                backedUp = true;
                if (snapshotRegularFile(backupPath).sha256 !== before.sha256 || !unchanged(before)) {
                    throw new Error("File changed while the restore backup was being made.");
                }
            }
            const published = snapshotRegularFile(tempPath);
            // Install historical content only. An absent historical file must never
            // be represented by a filesystem deletion in this restore API.
            if (before.exists)
                fs.renameSync(tempPath, absolute);
            else {
                fs.linkSync(tempPath, absolute);
                fs.unlinkSync(tempPath);
            }
            ownsTemp = false;
            installed = published;
            if (!unchanged(installed))
                throw new Error("File changed immediately after restore installation.");
            if (needsUnstage)
                await this.unstageFile(filePath);
        }
        catch (error) {
            if (installed) {
                let safe = false;
                try {
                    safe = unchanged(installed);
                }
                catch { /* preserve changed/unsafe target */ }
                if (!safe)
                    throw new Error(`Restore failed after a concurrent file change. Current content was preserved. Original backup: ${backupPath}. ${error.message || error}`);
                if (backedUp) {
                    fs.renameSync(backupPath, absolute);
                    backedUp = false;
                    fs.unlinkSync(description);
                }
                else if (installed.exists)
                    fs.unlinkSync(absolute);
            }
            if (backedUp)
                throw new Error(`${error.message || error} Original backup retained at: ${backupPath}`);
            throw error;
        }
        finally {
            if (ownsTemp) {
                try {
                    fs.unlinkSync(tempPath);
                }
                catch { /* leave identifiable temp */ }
            }
        }
        if (backedUp) {
            try {
                fs.unlinkSync(backupPath);
                fs.unlinkSync(description);
            }
            catch (error) {
                console.warn("Vault Version Control: retained restore backup", backupPath, error);
            }
        }
    }
    async readDiffSource(source) {
        if (source.kind === "working-tree") {
            const absolutePath = checkedVaultFilePath(this.vaultPath, source.filePath);
            let info;
            try {
                info = fs.lstatSync(absolutePath);
            }
            catch (error) {
                if (error?.code === "ENOENT")
                    throw new Error(`Current local file is no longer on disk: ${source.filePath}`);
                throw error;
            }
            if (!info.isFile() || info.isSymbolicLink()) {
                throw new Error("Current local comparison source must be a regular file.");
            }
            // Compare uses the saved bytes on disk, not unsaved Obsidian editor text.
            return fs.readFileSync(absolutePath);
        }
        if (source.absentAtCommit) {
            throw new Error("Removed from Git is a history event, not a file version. Compare a committed version with the current local file instead.");
        }
        return await this.readFileVersion(source);
    }
    async canAutoRestoreDiff(left, right) {
        const isSmallSource = async (source) => {
            let size;
            if (source.kind === "working-tree") {
                const file = path.join(this.vaultPath, ...source.filePath.split("/"));
                const stat = fs.statSync(file);
                if (!stat.isFile())
                    return false;
                size = stat.size;
            }
            else if (source.absentAtCommit) {
                return false;
            }
            else {
                const historical = await this.historicalFileBlob(source);
                if (!historical)
                    return false;
                const result = await this.run(["cat-file", "-s", historical.hash]);
                size = Number(result.stdout.trim());
            }
            if (!Number.isSafeInteger(size) || size < 0 || size > DIFF_AUTO_RESTORE_MAX_BYTES)
                return false;
            // Check actual line count as well as byte size, without loading large
            // historical Git blobs. Unusually long lines also stay on the manual path.
            const buffer = await this.readDiffSource(source);
            if (buffer.length > DIFF_AUTO_RESTORE_MAX_BYTES)
                return false;
            let lines = buffer.length ? 1 : 0;
            let lineBytes = 0;
            for (let index = 0; index < buffer.length; index += 1) {
                if (buffer[index] === 10) {
                    if (index < buffer.length - 1)
                        lines += 1;
                    lineBytes = 0;
                    if (lines > DIFF_PAGE_ROWS)
                        return false;
                }
                else {
                    lineBytes += 1;
                    if (lineBytes > DIFF_AUTO_RESTORE_MAX_LINE_BYTES)
                        return false;
                }
            }
            return true;
        };
        try {
            const [smallLeft, smallRight] = await Promise.all([isSmallSource(left), isSmallSource(right)]);
            return smallLeft && smallRight;
        }
        catch {
            // Missing sources or Git failures must not trigger an automatic Diff.
            return false;
        }
    }
    async diffSources(left, right, onProgress) {
        if ((left.kind === "revision" && left.absentAtCommit) ||
            (right.kind === "revision" && right.absentAtCommit)) {
            throw new Error("Removed from Git is a history event, not a file version. Select two available file contents to compare.");
        }
        onProgress?.({
            step: 1,
            totalSteps: 4,
            message: "Loading comparison sources…",
            detail: "0 of 2 sources loaded",
        });
        let loadedSources = 0;
        const readWithProgress = async (source) => {
            const content = await this.readDiffSource(source);
            loadedSources += 1;
            onProgress?.({
                step: 1,
                totalSteps: 4,
                message: "Loading comparison sources…",
                detail: `${loadedSources} of 2 sources loaded`,
            });
            return content;
        };
        const [leftContent, rightContent] = await Promise.all([
            readWithProgress(left),
            readWithProgress(right),
        ]);
        onProgress?.({
            step: 2,
            totalSteps: 4,
            message: "Preparing comparison…",
            detail: "Preparing temporary inputs",
        });
        const gitDirResult = await this.run(["rev-parse", "--git-dir"]);
        const gitDirText = gitDirResult.stdout.trim();
        const tempBase = path.isAbsolute(gitDirText)
            ? gitDirText
            : path.resolve(this.vaultPath, gitDirText || ".git");
        if (!fs.existsSync(tempBase) || !fs.statSync(tempBase).isDirectory()) {
            throw new Error("Unable to resolve the Git metadata directory for comparison.");
        }
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const leftTemp = path.join(tempBase, `vvc-diff-${nonce}-a.tmp`);
        const rightTemp = path.join(tempBase, `vvc-diff-${nonce}-b.tmp`);
        try {
            fs.writeFileSync(leftTemp, leftContent);
            fs.writeFileSync(rightTemp, rightContent);
            onProgress?.({
                step: 3,
                totalSteps: 4,
                message: "Comparing file contents…",
                detail: "Git is computing the differences",
            });
            const result = await this.run([
                "diff", "--no-index", "--no-color", "--text", "--histogram", "--unified=999999", "--", leftTemp, rightTemp,
            ], [0, 1]);
            onProgress?.({
                step: 4,
                totalSteps: 4,
                message: "Preparing comparison view…",
                detail: "Processing comparison result",
            });
            return result.stdout;
        }
        finally {
            if (fs.existsSync(leftTemp))
                fs.rmSync(leftTemp, { force: true });
            if (fs.existsSync(rightTemp))
                fs.rmSync(rightTemp, { force: true });
        }
    }
    async diffFiles(fileA, fileB) {
        return await this.diffSources(workingTreeDiffSource(fileA), workingTreeDiffSource(fileB));
    }
}
class InitializeFromRemoteModal extends obsidian_1.Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
        this.repositoryUrl = "";
        this.active = false;
        this.fetchingPreview = false;
    }
    onOpen() {
        this.showUrlEntry();
    }
    onClose() {
        if (this.fetchingPreview) {
            this.active = false;
            this.fetchingPreview = false;
            this.plugin.git.cancelNetwork();
        }
    }
    showUrlEntry(message = "") {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Initialize from Remote");
        htmlEl(content, "p", "vvc-modal-copy", "Import Git history into this Vault without overwriting its existing files or Obsidian settings.");
        htmlEl(content, "label", "vvc-field-label", "Repository URL (HTTPS or SSH)");
        const input = htmlEl(content, "input", "vvc-text-input");
        input.type = "text";
        input.placeholder = "https://github.com/you/notes.git";
        input.value = this.repositoryUrl;
        const status = htmlEl(content, "div", "vvc-import-status", message);
        if (message)
            status.classList.add("is-error");
        const authHelp = htmlEl(content, "div", "vvc-remote-auth-help");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const cancel = buttonEl(actions, "Cancel", "vvc-button");
        const previewButton = buttonEl(actions, "Preview import", "vvc-button vvc-button-primary");
        cancel.addEventListener("click", () => {
            if (this.active)
                this.plugin.git.cancelNetwork();
            this.active = false;
            this.close();
        });
        previewButton.addEventListener("click", async () => {
            if (this.active)
                return;
            this.repositoryUrl = input.value.trim();
            this.active = true;
            this.fetchingPreview = true;
            previewButton.disabled = true;
            input.disabled = true;
            status.textContent = "Checking remote history and Vault files…";
            authHelp.replaceChildren();
            try {
                const preview = await this.plugin.git.previewRemoteImport(this.repositoryUrl);
                if (!this.active)
                    return; // cancelled while Git was running
                this.active = false;
                this.fetchingPreview = false;
                this.showPreview(preview);
            }
            catch (error) {
                if (!this.active)
                    return;
                this.active = false;
                this.fetchingPreview = false;
                previewButton.disabled = false;
                input.disabled = false;
                status.textContent = error instanceof Error ? error.message : "Unable to preview remote repository.";
                status.classList.add("is-error");
                showGitAuthenticationFailure(authHelp, this.plugin, error);
                if (/Git author name and email/i.test(status.textContent)) {
                    const settings = buttonEl(content, "Configure Git author", "vvc-link-button");
                    settings.addEventListener("click", () => this.plugin.openPluginSettings());
                }
            }
        });
        window.setTimeout(() => input.focus(), 0);
    }
    showPreview(preview) {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Review remote import");
        htmlEl(content, "p", "vvc-modal-copy", `Source branch: ${preview.sourceBranch} · commit ${preview.sourceHead.slice(0, 7)}`);
        const summary = htmlEl(content, "div", "vvc-import-summary");
        const trackedObsidian = preview.trackedLocalOnly.filter((file) => file.startsWith(".obsidian/")).length;
        const lines = [
            `${preview.plan.trackedFileCount} files in source history's latest commit`,
            `${preview.plan.importFiles.length} remote files to add without overwriting local files`,
            ...(preview.plan.symlinkFiles?.filter((file) => preview.plan.importFiles.includes(file)).length
                ? [`${preview.plan.symlinkFiles.filter((file) => preview.plan.importFiles.includes(file)).length} safe internal symbolic links included`]
                : []),
            `${preview.plan.existingFiles.length} existing Vault files preserved`,
            `${preview.trackedLocalOnly.length} local-only files automatically added to Git (${trackedObsidian} Obsidian settings files)`,
            `${preview.plan.localOnlyFiles.length - preview.trackedLocalOnly.length} local-only files ignored`,
            `${preview.plan.deferredObsidian.length} remote-only Obsidian settings files not installed`,
        ];
        for (const line of lines)
            htmlEl(summary, "div", "vvc-modal-copy", line);
        htmlEl(content, "p", "vvc-modal-copy", preview.pluginIgnoresObsidian
            ? "The source does not track Obsidian settings; existing local settings remain ignored by default."
            : "The source tracks Obsidian settings; local settings are preserved and normal Git Ignore rules apply.");
        htmlEl(content, "p", "vvc-modal-copy", "Original Git history will be retained. The source repository will NOT be connected as a Push destination. History can contain sensitive files even if later deleted.");
        const paths = htmlEl(content, "details", "vvc-error-details");
        htmlEl(paths, "summary", "vvc-error-summary", "File details");
        const appendFiles = (title, files) => {
            if (!files.length)
                return;
            htmlEl(paths, "div", "vvc-field-label", `${title} (${files.length})`);
            const list = htmlEl(paths, "div", "vvc-import-file-list");
            for (const file of files.slice(0, 50))
                htmlEl(list, "div", "vvc-command-code", file);
            if (files.length > 50)
                htmlEl(list, "div", "vvc-modal-copy", `…and ${files.length - 50} more`);
        };
        appendFiles("Remote files to add", preview.plan.importFiles);
        appendFiles("Internal symbolic links", (preview.plan.symlinkFiles || []).filter((file) => preview.plan.importFiles.includes(file)));
        appendFiles("Local-only files to track", preview.trackedLocalOnly);
        appendFiles("Remote Obsidian settings not installed", preview.plan.deferredObsidian);
        const status = htmlEl(content, "div", "vvc-import-status");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const back = buttonEl(actions, "Back", "vvc-button");
        const confirm = buttonEl(actions, "Initialize from Remote", "vvc-button vvc-button-primary");
        back.addEventListener("click", () => this.showUrlEntry());
        confirm.addEventListener("click", async () => {
            if (this.active)
                return;
            this.active = true;
            back.disabled = true;
            confirm.disabled = true;
            status.textContent = "Preparing import…";
            try {
                await this.plugin.git.initializeFromRemote(this.repositoryUrl, preview, (message) => {
                    status.textContent = message;
                });
                this.active = false;
                this.close();
                new obsidian_1.Notice("Remote Git history imported. The source repository is not connected for Push.");
                await this.plugin.refreshVersionControlNow();
            }
            catch (error) {
                this.active = false;
                const detail = error instanceof Error ? error.message : "Unable to initialize from remote.";
                if (this.plugin.git.hasLocalRepository()) {
                    // Once a pending journal exists, do not offer a second attempt.
                    this.close();
                    new obsidian_1.Notice("Import interrupted. Existing Vault files were kept. Review the recovery status in Version Control.", 9000);
                    await this.plugin.refreshVersionControlNow();
                }
                else {
                    this.showUrlEntry(`${detail} Preview the import again before retrying.`);
                    if (error instanceof RemoteGitAuthenticationError) {
                        const authHelp = htmlEl(this.contentEl, "div", "vvc-remote-auth-help");
                        showGitAuthenticationFailure(authHelp, this.plugin, error);
                    }
                }
            }
        });
    }
}
class RemoteRepositoryModal extends obsidian_1.Modal {
    constructor(plugin, current) {
        super(plugin.app);
        this.plugin = plugin;
        this.current = current;
        this.createdRepositoryUrl = "";
        this.creationOutcomeUncertain = false;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Remote repository");
        htmlEl(content, "p", "vvc-modal-copy", "Connect your own Git repository. Connecting does not fetch or push any files.");
        if (this.current.configured) {
            htmlEl(content, "div", "vvc-field-label", "Current origin");
            htmlEl(content, "div", "vvc-command-code", this.current.displayUrl);
            htmlEl(content, "label", "vvc-field-label", "Change repository URL");
            const urlInput = htmlEl(content, "input", "vvc-text-input");
            urlInput.type = "text";
            urlInput.value = this.current.displayUrl;
            const error = htmlEl(content, "div", "vvc-inline-error");
            const actions = htmlEl(content, "div", "vvc-modal-actions");
            buttonEl(actions, "Close", "vvc-button").addEventListener("click", () => this.close());
            const update = buttonEl(actions, "Update URL", "vvc-button");
            update.addEventListener("click", async () => {
                update.disabled = true;
                try {
                    await this.plugin.git.updateRemoteUrl(urlInput.value);
                    this.close();
                    await this.plugin.refreshVersionControlNow();
                }
                catch (failure) {
                    update.disabled = false;
                    error.textContent = failure instanceof Error ? failure.message : "Unable to update URL.";
                }
            });
            const disconnect = buttonEl(actions, "Disconnect", "vvc-button");
            disconnect.addEventListener("click", async () => {
                disconnect.disabled = true;
                try {
                    await this.plugin.git.disconnectRemote();
                    this.close();
                    await this.plugin.refreshVersionControlNow();
                }
                catch (error) {
                    disconnect.disabled = false;
                    new obsidian_1.Notice(error instanceof Error ? error.message : "Could not disconnect remote.", 7000);
                }
            });
            return;
        }
        this.showChoice();
    }
    showChoice() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Remote repository");
        htmlEl(content, "p", "vvc-modal-copy", this.createdRepositoryUrl
            ? `GitHub repository already created: ${this.createdRepositoryUrl}. Connect it instead of creating again.`
            : this.creationOutcomeUncertain
                ? "GitHub creation result is uncertain. Check your GitHub account before attempting to create another repository."
                : "Create a GitHub repository or connect an existing Git repository. Nothing is pushed automatically.");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Cancel", "vvc-button").addEventListener("click", () => this.close());
        buttonEl(actions, "Connect existing repository", "vvc-button")
            .addEventListener("click", () => this.showConnectEntry(this.createdRepositoryUrl));
        if (!this.createdRepositoryUrl && !this.creationOutcomeUncertain) {
            buttonEl(actions, "Create GitHub Repository", "vvc-button vvc-button-primary")
                .addEventListener("click", () => this.showCreateEntry());
        }
    }
    showConnectEntry(prefill = "") {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Connect existing repository");
        htmlEl(content, "p", "vvc-modal-copy", "Connect origin without transferring files.");
        htmlEl(content, "label", "vvc-field-label", "Repository URL (HTTPS or SSH)");
        const input = htmlEl(content, "input", "vvc-text-input");
        input.type = "text";
        input.placeholder = "https://github.com/you/my-vault.git";
        input.value = prefill;
        const error = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Back", "vvc-button").addEventListener("click", () => this.showChoice());
        const connect = buttonEl(actions, "Connect", "vvc-button vvc-button-primary");
        connect.addEventListener("click", async () => {
            connect.disabled = true;
            error.textContent = "";
            try {
                await this.plugin.git.connectRemote(input.value);
                this.close();
                await this.plugin.refreshVersionControlNow();
            }
            catch (failure) {
                connect.disabled = false;
                error.textContent = failure instanceof Error ? failure.message : "Unable to connect remote.";
            }
        });
        window.setTimeout(() => input.focus(), 0);
    }
    showCreateEntry() {
        if (this.createdRepositoryUrl || this.creationOutcomeUncertain) {
            this.showChoice();
            return;
        }
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Create GitHub Repository");
        htmlEl(content, "p", "vvc-modal-copy", "Create an empty repository in your signed-in GitHub account. It will be connected as origin; no files will be uploaded.");
        htmlEl(content, "label", "vvc-field-label", "Repository name");
        const name = htmlEl(content, "input", "vvc-text-input");
        name.type = "text";
        name.placeholder = "my-vault";
        htmlEl(content, "label", "vvc-field-label", "Visibility");
        const visibility = htmlEl(content, "select", "vvc-text-input");
        htmlEl(visibility, "option", "", "Private").value = "private";
        htmlEl(visibility, "option", "", "Public").value = "public";
        visibility.value = "private";
        const notice = htmlEl(content, "p", "vvc-modal-copy", "Private by default. Creating a repository does not upload Git history.");
        visibility.addEventListener("change", () => {
            notice.textContent = visibility.value === "public"
                ? "Public repositories are visible to everyone. No Vault files or history will be uploaded now."
                : "Private by default. Creating a repository does not upload Git history.";
        });
        const error = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions vvc-github-create-actions");
        const setup = buttonEl(actions, "Set up GitHub CLI", "vvc-button");
        setup.style.display = "none";
        setup.addEventListener("click", () => new GitHubCliHelpModal(this.plugin).open());
        const back = buttonEl(actions, "Back", "vvc-button");
        back.addEventListener("click", () => this.showChoice());
        const create = buttonEl(actions, "Create repository", "vvc-button vvc-button-primary");
        create.addEventListener("click", async () => {
            create.disabled = true;
            back.disabled = true;
            name.disabled = true;
            visibility.disabled = true;
            error.replaceChildren();
            setup.style.display = "none";
            try {
                const result = await this.plugin.git.createGithubRepository(name.value, visibility.value);
                if (result.connected) {
                    this.close();
                    new obsidian_1.Notice("GitHub repository created and connected. No files were pushed.");
                    await this.plugin.refreshVersionControlNow();
                    return;
                }
                // The GitHub write succeeded; a retry here must only connect origin.
                this.createdRepositoryUrl = result.url;
                error.textContent = `${result.warning} URL: ${result.url}`;
                back.disabled = false;
                create.remove();
                buttonEl(actions, "Connect existing repository", "vvc-button vvc-button-primary")
                    .addEventListener("click", () => this.showConnectEntry(result.url));
            }
            catch (failure) {
                error.textContent = failure instanceof Error ? failure.message : "Unable to create GitHub repository.";
                if (/could not be confirmed|did not respond in time|may have created/.test(error.textContent)) {
                    // Unknown remote write outcome: never automatically issue another POST.
                    this.creationOutcomeUncertain = true;
                    create.remove();
                    buttonEl(actions, "Connect existing repository", "vvc-button")
                        .addEventListener("click", () => this.showConnectEntry());
                }
                else {
                    create.disabled = false;
                }
                back.disabled = false;
                if (/GitHub CLI \(gh\) is not installed|GitHub CLI is not signed in/.test(error.textContent)) {
                    setup.style.display = "";
                }
            }
            finally {
                name.disabled = false;
                visibility.disabled = false;
            }
        });
        window.setTimeout(() => name.focus(), 0);
    }
}
class GitHubCliHelpModal extends obsidian_1.Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
    }
    commandWithCopy(parent, command) {
        const row = htmlEl(parent, "div", "vvc-github-cli-command");
        htmlEl(row, "code", "vvc-github-cli-command-text", command);
        const copy = buttonEl(row, "Copy", "vvc-button vvc-github-cli-copy");
        copy.setAttribute("aria-label", `Copy ${command}`);
        copy.addEventListener("click", async () => {
            copy.disabled = true;
            try {
                await this.plugin.copyText(command);
                copy.textContent = "Copied";
                window.setTimeout(() => {
                    if (copy.textContent === "Copied")
                        copy.textContent = "Copy";
                }, 1800);
            }
            catch (failure) {
                new obsidian_1.Notice(failure instanceof Error ? failure.message : "Unable to copy command.", 6000);
            }
            finally {
                copy.disabled = false;
            }
        });
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Set up GitHub CLI");
        htmlEl(content, "p", "vvc-modal-copy", "Creating GitHub repositories requires a GitHub CLI login, separate from Git Push credentials. Install gh if needed:");
        this.commandWithCopy(content, "brew install gh");
        htmlEl(content, "p", "vvc-modal-copy", "Sign in once in Terminal, then retry:");
        this.commandWithCopy(content, "gh auth login");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Close", "vvc-button").addEventListener("click", () => this.close());
    }
}
// The setup guide is opened only on request; failures always retain a small
// actionable link and never require another Push/Fetch or a stored dismissal flag.
class GitAuthenticationHelpModal extends obsidian_1.Modal {
    constructor(plugin, method) {
        super(plugin.app);
        this.plugin = plugin;
        this.method = method;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Set up Git authentication");
        if (this.method === "ssh") {
            htmlEl(content, "p", "vvc-modal-copy", "Configure an SSH key with access to this repository and load it into your SSH agent. Use your Git provider's SSH key instructions, then retry Fetch or Push.");
            htmlEl(content, "div", "vvc-command-code", "ssh -T git@github.com");
            htmlEl(content, "p", "vvc-modal-copy", "This example tests GitHub; use the host in your repository URL for other providers.");
        }
        else {
            htmlEl(content, "p", "vvc-modal-copy", "Configure a system Git credential helper. Git Credential Manager supports browser sign-in; existing macOS Keychain or GitHub CLI helpers can also be used.");
            htmlEl(content, "div", "vvc-command-code", "brew install --cask git-credential-manager");
            htmlEl(content, "p", "vvc-modal-copy", "On macOS, installation normally configures Git automatically. If you already installed GCM but need to configure it, run git-credential-manager configure. Alternatively, use GitHub CLI:");
            htmlEl(content, "div", "vvc-command-code", "gh auth login");
            htmlEl(content, "div", "vvc-command-code", "gh auth setup-git");
        }
        htmlEl(content, "p", "vvc-modal-copy", "Use the Git executable selected in plugin settings. Credentials remain with your system Git helper, never in this plugin. Retry the operation after setup.");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Close", "vvc-button").addEventListener("click", () => this.close());
    }
}
function showGitAuthenticationFailure(parent, plugin, failure) {
    if (!(failure instanceof RemoteGitAuthenticationError))
        return false;
    htmlEl(parent, "span", "vvc-inline-error", failure.message);
    buttonEl(parent, "Set up authentication", "vvc-link-button").addEventListener("click", () => {
        new GitAuthenticationHelpModal(plugin, failure.method).open();
    });
    return true;
}
class ConfirmExcludeFilesModal extends obsidian_1.Modal {
    constructor(plugin, files, batch, onDone) {
        super(plugin.app);
        this.plugin = plugin;
        this.files = files;
        this.batch = batch;
        this.onDone = onDone;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        const tracked = this.files.reduce((count, file) => count + (file.trackedFiles ?? (file.tracked ? 1 : 0)), 0);
        const folder = !this.batch && this.files[0]?.directory;
        htmlEl(content, "h2", "vvc-modal-title", this.batch ? "Exclude files and folders from Git" : folder ? "Stop tracking folder" : "Stop tracking file");
        const list = htmlEl(content, "div", "vvc-ignore-confirm-files");
        for (const file of this.files.slice(0, 8)) {
            htmlEl(list, "div", "vvc-ignore-confirm-name", file.path + (file.directory ? "/" : ""));
        }
        if (this.files.length > 8)
            htmlEl(list, "div", "vvc-modal-copy", `And ${this.files.length - 8} more items.`);
        htmlEl(content, "p", "vvc-modal-copy", this.batch
            ? `${tracked} tracked ${tracked === 1 ? "file" : "files"} within the ${this.files.length} selected items will stop being tracked. Ignore rules will be added to .gitignore.`
            : folder
                ? `Git will stop tracking ${tracked} ${tracked === 1 ? "file" : "files"} within this folder and ignore the entire folder.`
                : "Git will stop tracking this file and add it to .gitignore.");
        htmlEl(content, "p", "vvc-modal-copy", "Local files will be kept. Previous versions remain in Git history. Committing the removal can also remove tracked copies when another device pulls it.");
        htmlEl(content, "p", "vvc-modal-copy", "No commit or push will be performed. Only the new ignore rules and tracked-file removals will be staged.");
        const error = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Cancel", "vvc-button").addEventListener("click", () => this.close());
        const confirm = buttonEl(actions, this.batch ? "Exclude selected items" : "Stop tracking", "vvc-button vvc-button-primary");
        confirm.addEventListener("click", async () => {
            confirm.disabled = true;
            try {
                const result = await this.plugin.git.ignoreFiles(this.files.map((file) => file.path));
                this.close();
                this.onDone?.();
                this.plugin.showIgnoreResult(result);
                await this.plugin.refreshVersionControlNow();
            }
            catch (failure) {
                confirm.disabled = false;
                error.textContent = failure instanceof Error ? failure.message : String(failure);
            }
        });
    }
}
class IgnoreFilesModal extends obsidian_1.Modal {
    constructor(plugin) {
        super(plugin.app);
        this.plugin = plugin;
        this.selected = new Set();
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Ignore files and folders from Git");
        htmlEl(content, "p", "vvc-modal-copy", "Search and select Vault files or folders. Selecting a folder includes all its contents. Local files will not be deleted.");
        const search = htmlEl(content, "input", "vvc-text-input");
        search.type = "search";
        search.value = "";
        search.placeholder = "Search Vault files or folders…";
        search.setAttribute("aria-label", "Search Vault files or folders");
        const files = this.plugin.app.vault.getFiles()
            .map((file) => ({ path: file.path, directory: false }))
            .filter((entry) => entry.path !== ".gitignore" && !this.plugin.isHistoryPreviewFilePath(entry.path));
        const folders = (this.plugin.app.vault.getAllLoadedFiles?.() || [])
            .filter((entry) => entry instanceof obsidian_1.TFolder && entry.path && entry.path !== "/")
            .map((entry) => ({ path: entry.path, directory: true }));
        const allPaths = [...files, ...folders].sort((a, b) => a.path.localeCompare(b.path));
        const count = htmlEl(content, "div", "vvc-ignore-count");
        const list = htmlEl(content, "div", "vvc-ignore-file-list");
        const error = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Cancel", "vvc-button").addEventListener("click", () => this.close());
        const exclude = buttonEl(actions, "Exclude selected items", "vvc-button vvc-button-primary");
        const render = () => {
            list.replaceChildren();
            const query = search.value.trim().toLocaleLowerCase();
            const matching = allPaths.filter((entry) => entry.path.toLocaleLowerCase().includes(query));
            for (const entry of matching.slice(0, 100)) {
                const filePath = entry.path;
                const row = htmlEl(list, "label", "vvc-ignore-file-row");
                const checkbox = htmlEl(row, "input");
                checkbox.type = "checkbox";
                checkbox.checked = this.selected.has(filePath);
                htmlEl(row, "span", "vvc-ignore-file-path", filePath + (entry.directory ? "/" : ""));
                checkbox.addEventListener("change", () => {
                    if (checkbox.checked)
                        this.selected.add(filePath);
                    else
                        this.selected.delete(filePath);
                    count.textContent = `${this.selected.size} items selected · ${matching.length} matching` +
                        (matching.length > 100 ? " (showing first 100)" : "");
                    exclude.disabled = this.selected.size === 0;
                });
            }
            count.textContent = `${this.selected.size} items selected · ${matching.length} matching` +
                (matching.length > 100 ? " (showing first 100)" : "");
            exclude.disabled = this.selected.size === 0;
        };
        search.addEventListener("input", render);
        exclude.addEventListener("click", async () => {
            exclude.disabled = true;
            error.textContent = "";
            const paths = [...this.selected];
            try {
                const inspected = await this.plugin.git.inspectIgnoreFiles(paths);
                if (this.plugin.needsIgnoreConfirmation(inspected)) {
                    new ConfirmExcludeFilesModal(this.plugin, inspected, true).open();
                    this.close();
                    return;
                }
                const result = await this.plugin.git.ignoreFiles(paths);
                this.close();
                this.plugin.showIgnoreResult(result);
                await this.plugin.refreshVersionControlNow();
            }
            catch (failure) {
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                exclude.disabled = false;
            }
        });
        render();
        window.setTimeout(() => search.focus(), 0);
    }
}
class FirstPushModal extends obsidian_1.Modal {
    constructor(plugin, branch, displayUrl, onConfirm) {
        super(plugin.app);
        this.plugin = plugin;
        this.branch = branch;
        this.displayUrl = displayUrl;
        this.onConfirm = onConfirm;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Push to remote repository?");
        htmlEl(content, "p", "vvc-modal-copy", `Push ${this.branch} to origin (${this.displayUrl}). Git will upload the complete reachable commit history, including files deleted in later commits. Check for private notes or credentials first.`);
        const error = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        buttonEl(actions, "Cancel", "vvc-button").addEventListener("click", () => this.close());
        const confirm = buttonEl(actions, "Push", "vvc-button vvc-button-primary");
        confirm.addEventListener("click", async () => {
            confirm.disabled = true;
            try {
                await this.onConfirm();
                this.close();
            }
            catch (failure) {
                confirm.disabled = false;
                error.replaceChildren();
                if (!showGitAuthenticationFailure(error, this.plugin, failure)) {
                    error.textContent = failure instanceof Error ? failure.message : "Push failed.";
                }
            }
        });
    }
}
class InitialCommitIdentityModal extends obsidian_1.Modal {
    constructor(plugin, initialName, initialEmail, onConfirm) {
        super(plugin.app);
        this.plugin = plugin;
        this.initialName = initialName;
        this.initialEmail = initialEmail;
        this.onConfirm = onConfirm;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Set Git author for this Vault");
        htmlEl(content, "p", "vvc-modal-copy", "Git needs an author name and email before Vault Version Control can create the initial commit. These values will be saved for this Vault.");
        htmlEl(content, "label", "vvc-field-label", "Author name");
        const nameInput = htmlEl(content, "input", "vvc-text-input");
        nameInput.type = "text";
        nameInput.value = this.initialName;
        nameInput.placeholder = "Your name";
        htmlEl(content, "label", "vvc-field-label", "Author email");
        const emailInput = htmlEl(content, "input", "vvc-text-input");
        emailInput.type = "email";
        emailInput.value = this.initialEmail;
        emailInput.placeholder = "you@example.com";
        const errorEl = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const cancel = buttonEl(actions, "Cancel", "vvc-button");
        const create = buttonEl(actions, "Save and create initial commit", "vvc-button vvc-button-primary");
        cancel.addEventListener("click", () => this.close());
        create.addEventListener("click", async () => {
            const name = nameInput.value.trim();
            const email = emailInput.value.trim();
            errorEl.textContent = "";
            if (!name || !email) {
                errorEl.textContent = "Enter both an author name and email.";
                return;
            }
            create.disabled = true;
            try {
                this.plugin.settings.identityMode = "vault";
                this.plugin.settings.authorName = name;
                this.plugin.settings.authorEmail = email;
                await this.plugin.saveSettings();
                await this.plugin.git.setLocalIdentity(name, email);
                await this.onConfirm(name, email);
                this.close();
            }
            catch (error) {
                create.disabled = false;
                errorEl.textContent = error instanceof Error ? error.message : String(error);
            }
        });
        window.setTimeout(() => (this.initialName ? emailInput : nameInput).focus(), 0);
    }
}
class ConfirmRestoreModal extends obsidian_1.Modal {
    constructor(app, filePath, commit, onConfirm) {
        super(app);
        this.filePath = filePath;
        this.commit = commit;
        this.onConfirm = onConfirm;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Use historical file version?");
        htmlEl(content, "p", "vvc-modal-copy", `${this.filePath} has uncommitted changes. Using ${this.commit.shortHash} will replace the working-tree contents and unstage any staged changes for this file. The current branch and committed history are not changed.`);
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const cancel = buttonEl(actions, "Cancel", "vvc-button");
        const restore = buttonEl(actions, "Use this version", "vvc-button vvc-button-primary");
        cancel.addEventListener("click", () => this.close());
        restore.addEventListener("click", async () => {
            restore.disabled = true;
            try {
                await this.onConfirm();
                this.close();
            }
            catch (error) {
                restore.disabled = false;
                new obsidian_1.Notice(gitFailureNotice(error, "restore"), 7000);
            }
        });
    }
}
class ViewCommitMessageModal extends obsidian_1.Modal {
    constructor(plugin, commit) {
        super(plugin.app);
        this.plugin = plugin;
        this.commit = commit;
    }
    onOpen() {
        this.modalEl.classList.add("vvc-view-commit-modal");
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Commit message");
        htmlEl(content, "p", "vvc-modal-copy", [this.commit.shortHash, this.commit.timestamp ? formatDate(this.commit.timestamp) : ""].filter(Boolean).join(" · "));
        const messageEl = htmlEl(content, "pre", "vvc-view-commit-message", "Loading commit message…");
        messageEl.setAttribute("aria-label", "Full commit message");
        const error = htmlEl(content, "div", "vvc-inline-error");
        error.setAttribute("role", "alert");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const copy = buttonEl(actions, "Copy message", "vvc-button");
        copy.disabled = true;
        const close = buttonEl(actions, "Close", "vvc-button");
        close.addEventListener("click", () => this.close());
        let fullMessage = null;
        void this.plugin.git.commitMessage(this.commit.hash).then((message) => {
            if (!this.contentEl.isConnected)
                return;
            fullMessage = message;
            messageEl.textContent = message || "(no commit message)";
            copy.disabled = false;
        }).catch((reason) => {
            if (!this.contentEl.isConnected)
                return;
            messageEl.textContent = "Unable to load commit message.";
            error.textContent = reason instanceof Error ? reason.message : String(reason);
        });
        copy.addEventListener("click", async () => {
            if (fullMessage === null)
                return;
            try {
                await this.plugin.copyText(fullMessage);
                new obsidian_1.Notice("Commit message copied.");
            }
            catch (reason) {
                error.textContent = reason instanceof Error ? reason.message : String(reason);
            }
        });
    }
}
class EditCommitMessageModal extends obsidian_1.Modal {
    constructor(plugin, commit) {
        super(plugin.app);
        this.plugin = plugin;
        this.commit = commit;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Edit commit message");
        const explanation = htmlEl(content, "p", "vvc-modal-copy");
        htmlEl(explanation, "span", "", "Edit the latest commit ");
        htmlEl(explanation, "code", "", `(${this.commit.shortHash})`);
        htmlEl(explanation, "span", "", " message. The commit hash will change, but file contents will not.");
        const label = htmlEl(content, "label", "vvc-field-label", "Commit message");
        const input = htmlEl(content, "textarea", "vvc-text-input vvc-edit-commit-message");
        input.rows = 4;
        input.disabled = true;
        const id = `vvc-reword-${this.commit.shortHash}`;
        input.id = id;
        label.htmlFor = id;
        const error = htmlEl(content, "div", "vvc-inline-error");
        error.setAttribute("role", "alert");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const cancel = buttonEl(actions, "Cancel", "vvc-button");
        const save = buttonEl(actions, "Save message", "vvc-button vvc-button-primary");
        save.disabled = true;
        cancel.addEventListener("click", () => this.close());
        let originalMessage = "";
        let editable = false;
        input.addEventListener("input", () => {
            save.disabled = !editable || !input.value.trim() || input.value.trim() === originalMessage.trim();
            if (editable)
                error.textContent = "";
        });
        void this.plugin.git.commitMessage(this.commit.hash).then(async (message) => {
            if (!this.contentEl.isConnected)
                return;
            // Display the original message even if safety checks will deny saving.
            originalMessage = message;
            input.value = message;
            input.disabled = false;
            input.readOnly = true;
            try {
                await this.plugin.git.editableHeadCommit(this.commit.hash);
                if (!this.contentEl.isConnected)
                    return;
                editable = true;
                input.readOnly = false;
                window.setTimeout(() => input.focus(), 0);
            }
            catch (reason) {
                if (this.contentEl.isConnected) {
                    error.textContent = reason instanceof Error ? reason.message : String(reason);
                }
            }
        }).catch((reason) => {
            if (this.contentEl.isConnected) {
                error.textContent = reason instanceof Error ? reason.message : String(reason);
            }
        });
        save.addEventListener("click", async () => {
            if (save.disabled)
                return;
            save.disabled = true;
            error.textContent = "";
            try {
                await this.plugin.git.rewordHeadCommit(this.commit.hash, input.value);
                this.close();
                new obsidian_1.Notice("Commit message updated. The commit hash has changed.");
                await this.plugin.refreshVersionControlNow();
            }
            catch (reason) {
                error.textContent = reason instanceof Error ? reason.message : String(reason);
                save.disabled = false;
            }
        });
    }
}
class StartFromVersionModal extends obsidian_1.Modal {
    constructor(plugin, commit) {
        super(plugin.app);
        this.plugin = plugin;
        this.commit = commit;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Start from this version");
        htmlEl(content, "p", "vvc-modal-copy", `Create a new branch from ${this.commit.shortHash || "the selected commit"}. Existing commits and branches remain unchanged.`);
        const label = htmlEl(content, "label", "vvc-field-label", "Branch name");
        const input = htmlEl(content, "input", "vvc-text-input");
        input.type = "text";
        const initialName = `from-${(this.commit.shortHash || "version").replace(/[^A-Za-z0-9._-]/g, "-")}`;
        input.value = initialName;
        void this.plugin.makeDefaultBranchName(this.commit.shortHash || "version").then((name) => {
            if (input.value === initialName)
                input.value = name;
        });
        label.htmlFor = "";
        const errorEl = htmlEl(content, "div", "vvc-inline-error");
        const actions = htmlEl(content, "div", "vvc-modal-actions");
        const cancel = buttonEl(actions, "Cancel", "vvc-button");
        const create = buttonEl(actions, "Create and switch", "vvc-button vvc-button-primary");
        cancel.addEventListener("click", () => this.close());
        create.addEventListener("click", async () => {
            const branchName = input.value.trim();
            errorEl.textContent = "";
            if (!branchName) {
                errorEl.textContent = "Enter a branch name.";
                return;
            }
            create.disabled = true;
            try {
                if (!(await this.plugin.git.isClean())) {
                    throw new Error("Working tree not clean: commit the current changes before starting from a historical version.");
                }
                await this.plugin.git.createBranchFromCommit(branchName, this.commit.hash || "");
                new obsidian_1.Notice(`Switched to new branch: ${branchName}`);
                this.close();
                await this.plugin.refreshVersionControlNow();
            }
            catch (error) {
                create.disabled = false;
                errorEl.textContent = gitFailureNotice(error, "branch");
            }
        });
        window.setTimeout(() => input.focus(), 0);
    }
}
function parseDiffSource(value) {
    if (!value || typeof value !== "object")
        return null;
    if (value.kind === "working-tree" && typeof value.filePath === "string") {
        return workingTreeDiffSource(value.filePath, typeof value.tracked === "boolean" ? value.tracked : undefined);
    }
    if (value.kind === "revision" &&
        typeof value.filePath === "string" &&
        typeof value.pathAtCommit === "string" &&
        typeof value.hash === "string") {
        return {
            kind: "revision",
            filePath: value.filePath,
            pathAtCommit: value.pathAtCommit,
            hash: value.hash,
            shortHash: typeof value.shortHash === "string" && value.shortHash ? value.shortHash : value.hash.slice(0, 7),
            timestamp: Number(value.timestamp || 0),
            // Preserve the event classification through Obsidian's view state.
            // Otherwise a removed commit is incorrectly read as a file blob.
            absentAtCommit: value.absentAtCommit === true,
        };
    }
    return null;
}
function inlineSegments(left, right) {
    if (left === right)
        return [[{ text: left, changed: false }], [{ text: right, changed: false }]];
    let prefix = 0;
    const minLength = Math.min(left.length, right.length);
    while (prefix < minLength && left[prefix] === right[prefix])
        prefix += 1;
    let suffix = 0;
    while (suffix < left.length - prefix &&
        suffix < right.length - prefix &&
        left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
        suffix += 1;
    }
    const make = (value) => {
        const segments = [];
        if (prefix > 0)
            segments.push({ text: value.slice(0, prefix), changed: false });
        const middleEnd = suffix > 0 ? value.length - suffix : value.length;
        if (middleEnd > prefix)
            segments.push({ text: value.slice(prefix, middleEnd), changed: true });
        if (suffix > 0)
            segments.push({ text: value.slice(value.length - suffix), changed: false });
        if (!segments.length)
            segments.push({ text: value, changed: true });
        return segments;
    };
    return [make(left), make(right)];
}
function parseUnifiedDiff(diffText) {
    if (!diffText.trim())
        return [];
    const rows = [];
    const lines = diffText.split(/\r?\n/);
    let leftLine = 0;
    let rightLine = 0;
    let inHunk = false;
    let sawHunk = false;
    let removed = [];
    let added = [];
    const flushChanges = () => {
        const count = Math.max(removed.length, added.length);
        for (let i = 0; i < count; i += 1) {
            const left = removed[i];
            const right = added[i];
            if (left && right) {
                const [leftSegments, rightSegments] = inlineSegments(left.text, right.text);
                left.segments = leftSegments;
                right.segments = rightSegments;
                rows.push({ kind: "changed", left, right });
            }
            else if (left) {
                rows.push({ kind: "removed", left });
            }
            else if (right) {
                rows.push({ kind: "added", right });
            }
        }
        removed = [];
        added = [];
    };
    for (const line of lines) {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            flushChanges();
            if (sawHunk)
                rows.push({ kind: "separator" });
            leftLine = Number(hunk[1]);
            rightLine = Number(hunk[2]);
            inHunk = true;
            sawHunk = true;
            continue;
        }
        if (!inHunk)
            continue;
        if (line.startsWith("\\ No newline at end of file"))
            continue;
        if (line.startsWith(" ")) {
            flushChanges();
            rows.push({
                kind: "equal",
                left: { lineNumber: leftLine, text: line.slice(1) },
                right: { lineNumber: rightLine, text: line.slice(1) },
            });
            leftLine += 1;
            rightLine += 1;
            continue;
        }
        if (line.startsWith("-")) {
            removed.push({ lineNumber: leftLine, text: line.slice(1) });
            leftLine += 1;
            continue;
        }
        if (line.startsWith("+")) {
            added.push({ lineNumber: rightLine, text: line.slice(1) });
            rightLine += 1;
            continue;
        }
    }
    flushChanges();
    return rows;
}
class DiffView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.state = { left: null, right: null, diffText: "", wrapLines: true };
        this.resizeObserver = null;
        this.diffBodyEl = null;
        this.overviewEl = null;
        this.overviewViewportEl = null;
        this.diffRows = null;
        this.diffWindowSize = DIFF_PAGE_ROWS;
        this.diffWindowGeneration = 0;
        this.diffJumpId = 0;
        this.diffJumpTimer = null;
        this.diffJumpHint = null;
        this.overviewRaf = null;
        this.horizontalMeasureRaf = null;
        this.horizontalScrollRaf = null;
        this.pendingHorizontalDelta = 0;
        this.horizontalOffset = 0;
        this.maxHorizontalOffset = 0;
        this.horizontalVisibilityObserver = null;
        this.visibleHorizontalContents = new Set();
        this.headerCenterEl = null;
        this.headerEl = null;
        this.wrapActionEl = null;
        this.comparisonRequestId = 0;
        this.comparisonRunning = false;
        this.comparisonCompleted = false;
        this.comparisonIdentical = false;
        this.diffWindowStart = 0;
        this.diffWindowEnd = 0;
        this.diffWindowBusy = false;
        this.diffRowHeight = 28;
        this.diffRowHeightMeasured = false;
        this.lastDiffTypographySignature = "";
        this.diffTopSpacer = null;
        this.diffBottomSpacer = null;
        this.diffScrollRaf = null;
        this.progressOverlayEl = null;
        this.progressMessageEl = null;
        this.progressDetailEl = null;
        this.progressMetaEl = null;
        this.progressBarEl = null;
        this.progressStartedAt = 0;
        this.progressTimer = null;
        this.plugin = plugin;
    }
    getViewType() {
        return DIFF_VIEW_TYPE;
    }
    getDisplayText() {
        const left = this.state.left;
        const right = this.state.right;
        if (!left || !right)
            return "Compare files";
        const sameFile = left.filePath === right.filePath;
        if (sameFile) {
            return `Diff: ${path.basename(left.filePath)} · ${diffSourceLabel(left)} ↔ ${diffSourceLabel(right)}`;
        }
        return `Diff: ${path.basename(left.filePath)} ↔ ${path.basename(right.filePath)}`;
    }
    getIcon() {
        return "diff";
    }
    getState() {
        return {
            left: this.state.left,
            right: this.state.right,
            wrapLines: this.state.wrapLines !== false,
        };
    }
    async setState(state, result) {
        await super.setState(state, result);
        // fileA/fileB are accepted for workspace states created by <= 0.1.18.
        const legacyLeft = typeof state?.fileA === "string" && state.fileA ? workingTreeDiffSource(state.fileA) : null;
        const legacyRight = typeof state?.fileB === "string" && state.fileB ? workingTreeDiffSource(state.fileB) : null;
        this.state = {
            left: parseDiffSource(state?.left) || legacyLeft,
            right: parseDiffSource(state?.right) || legacyRight,
            diffText: typeof state?.diffText === "string" ? state.diffText : "",
            wrapLines: state?.wrapLines !== false,
        };
        this.comparisonRequestId += 1;
        this.comparisonRunning = false;
        this.comparisonCompleted = false;
        this.diffWindowGeneration += 1;
        this.comparisonIdentical = false;
        this.diffJumpId += 1;
        this.clearDiffJumpHint();
        this.diffRows = null;
        this.diffWindowBusy = false;
        if (this.diffScrollRaf !== null)
            window.cancelAnimationFrame(this.diffScrollRaf);
        this.diffScrollRaf = null;
        this.stopProgressTimer();
        this.leaf.updateHeader?.();
        this.updateNativeHeader();
        if (!this.state.left || !this.state.right || !this.plugin.git?.canAutoRestoreDiff) {
            this.render();
            return;
        }
        // Show progress rather than a mandatory button while deciding whether
        // this saved comparison is small enough to restore automatically.
        const requestId = this.comparisonRequestId;
        this.comparisonRunning = true;
        this.progressStartedAt = Date.now();
        this.renderProgress({
            step: 1,
            totalSteps: 4,
            message: "Restoring comparison…",
            detail: "Checking document size",
        });
        this.startProgressTimer();
        // A freshly opened Diff calls startComparison() immediately after
        // setViewState; defer the probe so it cannot compete with that action.
        window.setTimeout(() => {
            if (requestId !== this.comparisonRequestId)
                return;
            void this.autoRestoreSmallComparison(requestId);
        }, 0);
    }
    async autoRestoreSmallComparison(requestId) {
        if (!this.state.left || !this.state.right)
            return;
        let small = false;
        try {
            small = await this.plugin.git.canAutoRestoreDiff(this.state.left, this.state.right);
        }
        catch {
            // A failed preflight is an unknown size, never a reason to auto-run.
        }
        if (requestId !== this.comparisonRequestId)
            return;
        this.comparisonRunning = false;
        this.stopProgressTimer();
        if (small) {
            this.startComparison(true);
        }
        else {
            this.render();
            this.updateNativeHeader();
        }
    }
    startComparison(forceReload = false) {
        if (!this.state.left || !this.state.right)
            return;
        const requestId = ++this.comparisonRequestId;
        if (forceReload)
            this.state.diffText = "";
        this.diffWindowStart = 0;
        this.diffWindowEnd = 0;
        this.diffWindowBusy = false;
        this.diffWindowSize = DIFF_PAGE_ROWS;
        this.diffWindowGeneration += 1;
        this.diffJumpId += 1;
        this.clearDiffJumpHint();
        this.diffRows = null;
        this.diffRowHeight = 28;
        this.diffRowHeightMeasured = false;
        this.lastDiffTypographySignature = "";
        this.diffTopSpacer = null;
        this.diffBottomSpacer = null;
        if (this.diffScrollRaf !== null)
            window.cancelAnimationFrame(this.diffScrollRaf);
        this.diffScrollRaf = null;
        this.comparisonCompleted = false;
        this.comparisonRunning = true;
        this.updateWrapAction();
        this.comparisonIdentical = false;
        this.progressStartedAt = Date.now();
        this.stopProgressTimer();
        this.renderProgress({
            step: this.state.diffText ? 4 : 1,
            totalSteps: 4,
            message: this.state.diffText ? "Preparing comparison view…" : "Starting comparison…",
            detail: this.state.diffText ? "Processing comparison result" : "Initializing",
        });
        this.startProgressTimer();
        // Allow the new Diff tab to paint before launching Git and rendering.
        window.setTimeout(() => {
            void this.loadAndRenderComparison(requestId);
        }, 0);
    }
    async loadAndRenderComparison(requestId) {
        try {
            if (!this.state.left || !this.state.right)
                return;
            if (!this.state.diffText) {
                this.state.diffText = await this.plugin.git.diffSources(this.state.left, this.state.right, (progress) => {
                    if (requestId !== this.comparisonRequestId)
                        return;
                    this.updateProgress(progress);
                });
            }
            if (requestId !== this.comparisonRequestId)
                return;
            await this.renderDiffIncrementally(requestId);
            if (requestId === this.comparisonRequestId)
                this.comparisonCompleted = true;
        }
        catch (error) {
            if (requestId !== this.comparisonRequestId)
                return;
            this.comparisonRunning = false;
            this.comparisonCompleted = false;
            this.stopProgressTimer();
            // A failed comparison is terminal, not a loading state.
            this.progressOverlayEl?.remove();
            this.clearProgressRefs();
            this.state.diffText = "";
            const message = error instanceof Error ? error.message : String(error);
            this.leaf.updateHeader?.();
            this.render(message);
            this.updateNativeHeader();
        }
    }
    async onOpen() {
        this.installNativeHeaderControls();
        if (!this.comparisonRunning)
            this.render();
        this.updateNativeHeader();
        this.resizeObserver = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width || 0;
            this.contentEl.classList.toggle("is-narrow", width > 0 && width < 760);
            this.measureHorizontalRange();
            this.scheduleOverviewUpdate();
        });
        this.resizeObserver.observe(this.contentEl);
    }
    async onClose() {
        this.comparisonRequestId += 1;
        this.comparisonRunning = false;
        this.stopProgressTimer();
        this.clearProgressRefs();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.overviewRaf !== null)
            window.cancelAnimationFrame(this.overviewRaf);
        if (this.horizontalMeasureRaf !== null)
            window.cancelAnimationFrame(this.horizontalMeasureRaf);
        if (this.horizontalScrollRaf !== null)
            window.cancelAnimationFrame(this.horizontalScrollRaf);
        if (this.diffScrollRaf !== null)
            window.cancelAnimationFrame(this.diffScrollRaf);
        this.horizontalVisibilityObserver?.disconnect();
        this.horizontalVisibilityObserver = null;
        this.visibleHorizontalContents.clear();
        this.pendingHorizontalDelta = 0;
        this.overviewRaf = null;
        this.horizontalMeasureRaf = null;
        this.horizontalScrollRaf = null;
        this.diffBodyEl = null;
        this.diffScrollRaf = null;
        this.diffWindowBusy = false;
        this.diffTopSpacer = null;
        this.diffBottomSpacer = null;
        this.overviewEl = null;
        this.overviewViewportEl = null;
        this.diffRows = null;
        this.headerCenterEl?.remove();
        this.headerCenterEl = null;
        this.wrapActionEl?.remove();
        this.wrapActionEl = null;
        this.headerEl?.classList.remove("vvc-diff-native-header");
        this.headerEl = null;
    }
    onPaneMenu(menu, _source) {
        if (!this.comparisonCompleted || this.comparisonIdentical)
            return;
        const gridLines = this.plugin.settings.diffGridLines !== false;
        menu.addItem((item) => {
            item
                .setTitle("Grid lines")
                .setChecked(gridLines)
                .onClick(async () => {
                this.plugin.settings.diffGridLines = !gridLines;
                this.contentEl.classList.toggle("is-gridless", this.plugin.settings.diffGridLines === false);
                await this.plugin.saveSettings();
                this.scheduleOverviewUpdate();
            });
        });
    }
    refreshTypography() {
        const content = this.contentEl;
        const typography = this.plugin.resolveMarkdownTypography(content);
        const values = {
            "--vvc-diff-font-family": typography?.fontFamily,
            "--vvc-diff-font-size": typography?.fontSize,
            "--vvc-diff-font-weight": typography?.fontWeight,
            "--vvc-diff-line-height": typography?.lineHeight,
            "--vvc-diff-letter-spacing": typography?.letterSpacing,
        };
        for (const [name, value] of Object.entries(values)) {
            if (value)
                content.style.setProperty(name, value);
            else
                content.style.removeProperty(name); // Preserve live Theme CSS fallbacks.
        }
        this.refreshVirtualRowHeight();
        this.measureHorizontalRange();
        this.scheduleOverviewUpdate();
    }
    diffTypographySignature(body) {
        const style = window.getComputedStyle(body);
        return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight, style.letterSpacing].join("|");
    }
    refreshVirtualRowHeight() {
        const body = this.diffBodyEl;
        if (!body?.isConnected || !this.diffRowHeightMeasured || !this.diffTopSpacer || !this.diffBottomSpacer)
            return;
        const signature = this.diffTypographySignature(body);
        if (signature === this.lastDiffTypographySignature)
            return;
        this.lastDiffTypographySignature = signature;
        const rows = body.querySelectorAll(".vvc-diff-row, .vvc-diff-separator");
        if (!rows.length)
            return;
        const height = Array.from(rows).reduce((total, row) => total + row.offsetHeight, 0) / rows.length;
        if (height <= 0)
            return;
        const oldTop = this.diffTopSpacer.offsetHeight;
        const previousScrollTop = body.scrollTop;
        this.diffRowHeight = Math.max(16, Math.min(160, height));
        const newTop = this.diffWindowStart * this.diffRowHeight;
        this.diffTopSpacer.style.height = `${newTop}px`;
        this.diffBottomSpacer.style.height = `${Math.max(0, (this.diffRows?.length ?? this.diffWindowEnd) - this.diffWindowEnd) * this.diffRowHeight}px`;
        body.scrollTop = previousScrollTop + newTop - oldTop;
    }
    installNativeHeaderControls() {
        // Do not rely on ItemView.addAction() here. Obsidian may rebuild the native
        // view header while restoring/updating a custom view, which can remove an
        // action that was added earlier in the lifecycle. Re-inject the Wrap action
        // into the current native .view-actions container whenever we update the
        // header so the control remains visible.
        window.requestAnimationFrame(() => this.updateNativeHeader());
    }
    ensureWrapAction(header) {
        const viewActions = header.querySelector(".view-actions");
        if (!viewActions) {
            this.wrapActionEl = null;
            return;
        }
        let action = viewActions.querySelector(".vvc-diff-wrap-native-action");
        if (!action) {
            action = document.createElement("button");
            action.type = "button";
            action.className = "clickable-icon view-action vvc-diff-wrap-native-action";
            action.setAttribute("aria-label", "Toggle line wrapping");
            (0, obsidian_1.setIcon)(action, "wrap-text");
            htmlEl(action, "span", "vvc-diff-wrap-action-label", "Wrap");
            action.addEventListener("click", () => this.toggleWrap());
            // Place the control at the start of the native action group so Obsidian's
            // built-in pane menu remains on the far right, producing `Wrap  …` while
            // keeping everything in the single native toolbar.
            viewActions.prepend(action);
        }
        this.wrapActionEl = action;
        this.updateWrapAction();
    }
    updateNativeHeader() {
        const leafContent = this.contentEl.closest(".workspace-leaf-content");
        const header = leafContent?.querySelector(".view-header");
        if (!header) {
            this.wrapActionEl = null;
            return;
        }
        this.ensureWrapAction(header);
        if (this.headerEl !== header) {
            this.headerCenterEl?.remove();
            this.headerEl?.classList.remove("vvc-diff-native-header");
            this.headerEl = header;
            header.classList.add("vvc-diff-native-header");
            this.headerCenterEl = htmlEl(header, "div", "vvc-diff-header-center");
        }
        if (!this.headerCenterEl)
            return;
        this.headerCenterEl.replaceChildren();
        const leftSource = this.state.left;
        const rightSource = this.state.right;
        const left = htmlEl(this.headerCenterEl, "div", "vvc-diff-header-file");
        htmlEl(left, "span", "vvc-diff-header-label", "A");
        const leftText = htmlEl(left, "div", "vvc-diff-header-file-text");
        const leftName = htmlEl(leftText, "span", "vvc-diff-header-file-name", leftSource ? path.basename(leftSource.filePath) : "File A");
        leftName.title = leftSource?.filePath || "File A";
        if (leftSource)
            htmlEl(leftText, "span", "vvc-diff-header-version", diffSourceDetail(leftSource));
        htmlEl(this.headerCenterEl, "span", "vvc-diff-header-arrow", "↔");
        const right = htmlEl(this.headerCenterEl, "div", "vvc-diff-header-file");
        htmlEl(right, "span", "vvc-diff-header-label", "B");
        const rightText = htmlEl(right, "div", "vvc-diff-header-file-text");
        const rightName = htmlEl(rightText, "span", "vvc-diff-header-file-name", rightSource ? path.basename(rightSource.filePath) : "File B");
        rightName.title = rightSource?.filePath || "File B";
        if (rightSource)
            htmlEl(rightText, "span", "vvc-diff-header-version", diffSourceDetail(rightSource));
        this.updateWrapAction();
    }
    updateWrapAction() {
        if (!this.wrapActionEl)
            return;
        const wrapped = this.state.wrapLines !== false;
        this.wrapActionEl.classList.toggle("is-active", wrapped);
        this.wrapActionEl.classList.toggle("is-hidden", !this.comparisonCompleted || this.comparisonRunning || this.comparisonIdentical);
        this.wrapActionEl.setAttribute("aria-pressed", wrapped ? "true" : "false");
        this.wrapActionEl.setAttribute("aria-label", wrapped ? "Disable line wrapping" : "Enable line wrapping");
        this.wrapActionEl.title = wrapped ? "Disable line wrapping" : "Enable line wrapping";
    }
    toggleWrap() {
        this.state.wrapLines = this.state.wrapLines === false;
        const content = this.contentEl;
        content.classList.toggle("is-nowrap", this.state.wrapLines === false);
        content.classList.toggle("is-wrap", this.state.wrapLines !== false);
        this.updateWrapAction();
        this.pendingHorizontalDelta = 0;
        if (this.state.wrapLines !== false) {
            this.horizontalOffset = 0;
            for (const element of Array.from(content.querySelectorAll(".vvc-diff-code-content"))) {
                element.style.transform = "";
            }
        }
        else {
            if (this.diffBodyEl)
                this.installHorizontalVisibilityObserver(this.diffBodyEl);
            this.applyHorizontalOffsetToVisible();
            this.measureHorizontalRange();
        }
        this.scheduleOverviewUpdate();
    }
    renderCell(parent, side, cell) {
        const element = htmlEl(parent, "div", `vvc-diff-cell vvc-diff-cell-${side}${cell ? "" : " is-empty"}`);
        const number = htmlEl(element, "div", "vvc-diff-line-number", cell?.lineNumber == null ? "" : String(cell.lineNumber));
        number.setAttribute("aria-hidden", "true");
        const code = htmlEl(element, "div", "vvc-diff-code");
        const codeContent = htmlEl(code, "div", "vvc-diff-code-content");
        if (!cell)
            return;
        if (cell.segments?.length) {
            for (const segment of cell.segments) {
                const span = htmlEl(codeContent, "span", segment.changed ? "vvc-diff-inline-change" : "");
                span.textContent = segment.text || "";
            }
        }
        else {
            codeContent.textContent = cell.text || " ";
        }
    }
    installSharedHorizontalScroll(body) {
        body.addEventListener("wheel", (event) => {
            if (this.state.wrapLines !== false)
                return;
            let horizontalDelta = event.deltaX;
            let claimedShiftWheel = false;
            if (event.shiftKey && Math.abs(horizontalDelta) < 0.01 && Math.abs(event.deltaY) > 0.01) {
                horizontalDelta = event.deltaY;
                claimedShiftWheel = true;
            }
            if (Math.abs(horizontalDelta) < 0.01)
                return;
            if (event.deltaMode === 1)
                horizontalDelta *= 16;
            else if (event.deltaMode === 2)
                horizontalDelta *= Math.max(1, body.clientWidth);
            this.pendingHorizontalDelta += horizontalDelta;
            this.scheduleHorizontalScrollFrame();
            // Native touchpad deltaY stays available for smooth vertical scrolling.
            // Only suppress the browser's vertical interpretation when Shift+wheel is
            // explicitly being used as the horizontal input.
            if (claimedShiftWheel && this.maxHorizontalOffset > 0)
                event.preventDefault();
        }, { passive: false });
    }
    scheduleHorizontalScrollFrame() {
        if (this.horizontalScrollRaf !== null)
            return;
        this.horizontalScrollRaf = window.requestAnimationFrame(() => {
            this.horizontalScrollRaf = null;
            const delta = this.pendingHorizontalDelta;
            this.pendingHorizontalDelta = 0;
            if (!delta)
                return;
            this.setHorizontalOffset(this.horizontalOffset + delta);
        });
    }
    installHorizontalVisibilityObserver(body) {
        this.horizontalVisibilityObserver?.disconnect();
        this.horizontalVisibilityObserver = null;
        this.visibleHorizontalContents.clear();
        if (this.state.wrapLines !== false)
            return;
        const rows = Array.from(body.querySelectorAll(".vvc-diff-row"));
        if (!rows.length)
            return;
        if (typeof IntersectionObserver === "undefined") {
            for (const row of rows) {
                for (const content of Array.from(row.querySelectorAll(".vvc-diff-code-content"))) {
                    this.visibleHorizontalContents.add(content);
                    content.classList.add("is-hscroll-active");
                }
            }
            this.applyHorizontalOffsetToVisible();
            return;
        }
        this.horizontalVisibilityObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const row = entry.target;
                const contents = Array.from(row.querySelectorAll(".vvc-diff-code-content"));
                if (entry.isIntersecting) {
                    for (const content of contents) {
                        this.visibleHorizontalContents.add(content);
                        content.classList.add("is-hscroll-active");
                        if (this.state.wrapLines === false) {
                            content.style.transform = `translate3d(${-this.horizontalOffset}px, 0, 0)`;
                        }
                    }
                }
                else {
                    for (const content of contents) {
                        this.visibleHorizontalContents.delete(content);
                        content.classList.remove("is-hscroll-active");
                    }
                }
            }
        }, {
            root: body,
            rootMargin: "600px 0px 600px 0px",
            threshold: 0,
        });
        for (const row of rows)
            this.horizontalVisibilityObserver.observe(row);
    }
    applyHorizontalOffsetToVisible() {
        if (this.state.wrapLines !== false)
            return;
        const transform = `translate3d(${-this.horizontalOffset}px, 0, 0)`;
        for (const content of this.visibleHorizontalContents) {
            content.style.transform = transform;
        }
    }
    setHorizontalOffset(value) {
        const next = Math.max(0, Math.min(this.maxHorizontalOffset, value));
        if (Math.abs(next - this.horizontalOffset) < 0.01)
            return;
        this.horizontalOffset = next;
        this.applyHorizontalOffsetToVisible();
    }
    measureHorizontalRange() {
        if (this.horizontalMeasureRaf !== null)
            window.cancelAnimationFrame(this.horizontalMeasureRaf);
        this.horizontalMeasureRaf = window.requestAnimationFrame(() => {
            this.horizontalMeasureRaf = null;
            const body = this.diffBodyEl;
            if (!body)
                return;
            if (this.state.wrapLines !== false) {
                this.maxHorizontalOffset = 0;
                this.horizontalOffset = 0;
                return;
            }
            let max = 0;
            for (const viewport of Array.from(body.querySelectorAll(".vvc-diff-code"))) {
                const line = viewport.querySelector(".vvc-diff-code-content");
                if (!line)
                    continue;
                max = Math.max(max, line.scrollWidth - viewport.clientWidth);
            }
            this.maxHorizontalOffset = Math.max(0, max);
            const clamped = Math.max(0, Math.min(this.maxHorizontalOffset, this.horizontalOffset));
            this.horizontalOffset = clamped;
            this.applyHorizontalOffsetToVisible();
        });
    }
    scheduleOverviewUpdate() {
        if (this.overviewRaf !== null)
            window.cancelAnimationFrame(this.overviewRaf);
        this.overviewRaf = window.requestAnimationFrame(() => {
            this.overviewRaf = null;
            this.updateActiveOverviewMarker();
        });
    }
    updateActiveOverviewMarker() {
        const body = this.diffBodyEl;
        const viewport = this.overviewViewportEl;
        if (!body || !viewport)
            return;
        // Only two geometry reads per frame, regardless of the total Diff length.
        const height = Math.max(1, body.scrollHeight);
        viewport.style.top = `${Math.min(100, body.scrollTop / height * 100)}%`;
        viewport.style.height = `${Math.min(100, Math.max(1, body.clientHeight / height * 100))}%`;
    }
    buildDiffOverview(rows, overview) {
        overview.replaceChildren();
        this.overviewViewportEl = null;
        this.diffRows = rows;
        if (!rows.length)
            return;
        // Aggregate markers at the physical ruler's pixel resolution. Never
        // create one button per changed row in a large diff.
        const buckets = Math.max(1, Math.min(480, Math.floor((overview.clientHeight || 800) / 2)));
        const changes = new Map();
        rows.forEach((row, index) => {
            if (row.kind === "equal" || row.kind === "separator")
                return;
            const bin = Math.min(buckets - 1, Math.floor(index / Math.max(1, rows.length - 1) * buckets));
            if (!changes.has(bin)) {
                changes.set(bin, {
                    index, kind: row.kind,
                    line: row.right?.lineNumber ?? row.left?.lineNumber ?? null,
                });
            }
        });
        for (const [bin, change] of changes) {
            const marker = buttonEl(overview, "", `vvc-diff-overview-marker is-${change.kind}`);
            marker.style.top = `${((bin + 0.5) / buckets) * 100}%`;
            marker.title = change.line == null ? "Jump to difference" : `Jump to line ${change.line}`;
            marker.setAttribute("aria-label", marker.title);
            marker.addEventListener("click", (event) => {
                event.stopPropagation();
                void this.jumpToDiffRow(change.index);
            });
        }
        const viewport = htmlEl(overview, "div", "vvc-diff-overview-viewport");
        viewport.setAttribute("aria-hidden", "true");
        this.overviewViewportEl = viewport;
        overview.addEventListener("click", (event) => {
            if (event.target !== overview || !this.diffRows?.length)
                return;
            const box = overview.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)));
            void this.jumpToDiffRow(Math.min(rows.length - 1, Math.floor(ratio * rows.length)));
        });
        this.scheduleOverviewUpdate();
    }
    async jumpToDiffRow(index) {
        const body = this.diffBodyEl;
        const overview = this.overviewEl;
        const rows = this.diffRows;
        if (!body || !overview || !rows?.length)
            return;
        const target = Math.max(0, Math.min(rows.length - 1, index));
        if (rows.length <= DIFF_PAGE_ROWS || (target >= this.diffWindowStart && target < this.diffWindowEnd)) {
            const node = body.querySelectorAll(".vvc-diff-row, .vvc-diff-separator")[target - this.diffWindowStart];
            if (node)
                body.scrollTop = Math.max(0, node.offsetTop - body.clientHeight * 0.2);
            return;
        }
        // A jump renders only the target neighbourhood (not a 3,000-row window).
        // Subsequent scrolling keeps a small bounded window for responsiveness.
        const jump = ++this.diffJumpId;
        const requestId = this.comparisonRequestId;
        this.diffWindowSize = DIFF_JUMP_ROWS;
        const start = Math.min(Math.max(0, rows.length - DIFF_JUMP_ROWS), Math.max(0, target - 20));
        this.clearDiffJumpHint();
        this.diffJumpTimer = window.setTimeout(() => {
            if (jump !== this.diffJumpId || requestId !== this.comparisonRequestId)
                return;
            const hint = htmlEl(this.contentEl, "div", "vvc-diff-jump-hint", `Loading differences near row ${(target + 1).toLocaleString()}…`);
            hint.setAttribute("role", "status");
            this.diffJumpHint = hint;
        }, 200);
        try {
            await this.renderDiffWindow(body, overview, rows, start, requestId, target);
        }
        finally {
            if (jump === this.diffJumpId) {
                this.clearDiffJumpHint();
                this.scheduleOverviewUpdate();
            }
        }
    }
    clearDiffJumpHint() {
        if (typeof this.diffJumpTimer === "number")
            window.clearTimeout(this.diffJumpTimer);
        this.diffJumpTimer = null;
        this.diffJumpHint?.remove();
        this.diffJumpHint = null;
    }
    progressElapsedText() {
        if (!this.progressStartedAt)
            return "";
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.progressStartedAt) / 1000));
        if (elapsedSeconds < 60)
            return `${elapsedSeconds}s elapsed`;
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = elapsedSeconds % 60;
        return `${minutes}m ${String(seconds).padStart(2, "0")}s elapsed`;
    }
    startProgressTimer() {
        this.stopProgressTimer();
        this.progressTimer = window.setInterval(() => {
            if (!this.progressMetaEl)
                return;
            const step = Number(this.progressBarEl?.dataset.step || "0");
            const total = Number(this.progressBarEl?.dataset.totalSteps || "4");
            this.progressMetaEl.textContent = `Step ${Math.max(1, step)} of ${total} · ${this.progressElapsedText()}`;
        }, 1000);
    }
    stopProgressTimer() {
        if (this.progressTimer !== null)
            window.clearInterval(this.progressTimer);
        this.progressTimer = null;
    }
    clearProgressRefs() {
        this.progressOverlayEl = null;
        this.progressMessageEl = null;
        this.progressDetailEl = null;
        this.progressMetaEl = null;
        this.progressBarEl = null;
    }
    ensureProgressOverlay() {
        if (this.progressOverlayEl?.isConnected)
            return;
        const content = this.contentEl;
        const overlay = htmlEl(content, "div", "vvc-diff-progress-overlay");
        overlay.setAttribute("role", "status");
        overlay.setAttribute("aria-live", "polite");
        const panel = htmlEl(overlay, "div", "vvc-diff-progress-panel");
        htmlEl(panel, "div", "vvc-diff-progress-spinner").setAttribute("aria-hidden", "true");
        const copy = htmlEl(panel, "div", "vvc-diff-progress-copy");
        this.progressMessageEl = htmlEl(copy, "div", "vvc-diff-progress-message", "Comparing files…");
        this.progressDetailEl = htmlEl(copy, "div", "vvc-diff-progress-detail", "Initializing");
        const progress = htmlEl(panel, "progress", "vvc-diff-progress-bar");
        progress.max = 4;
        progress.value = 0;
        progress.dataset.step = "1";
        progress.dataset.totalSteps = "4";
        this.progressMetaEl = htmlEl(panel, "div", "vvc-diff-progress-meta", "Step 1 of 4");
        this.progressOverlayEl = overlay;
        this.progressBarEl = progress;
    }
    renderProgress(progress) {
        const content = this.contentEl;
        content.replaceChildren();
        content.className = "view-content vvc-diff-view is-comparing";
        content.classList.toggle("is-nowrap", this.state.wrapLines === false);
        content.classList.toggle("is-wrap", this.state.wrapLines !== false);
        content.classList.toggle("is-gridless", this.plugin.settings.diffGridLines === false);
        this.horizontalVisibilityObserver?.disconnect();
        this.horizontalVisibilityObserver = null;
        this.visibleHorizontalContents.clear();
        this.diffBodyEl = null;
        this.overviewEl = null;
        this.overviewViewportEl = null;
        this.diffRows = null;
        this.refreshTypography();
        this.clearProgressRefs();
        this.ensureProgressOverlay();
        this.updateProgress(progress);
    }
    updateProgress(progress) {
        this.ensureProgressOverlay();
        if (this.progressMessageEl)
            this.progressMessageEl.textContent = progress.message;
        if (this.progressDetailEl)
            this.progressDetailEl.textContent = progress.detail || "";
        if (this.progressBarEl) {
            this.progressBarEl.max = Math.max(1, progress.totalSteps);
            // The bar represents completed stages rather than a synthetic time
            // percentage. The spinner and elapsed timer continue to show activity
            // while Git is inside a long-running comparison stage.
            this.progressBarEl.value = Math.max(0, Math.min(progress.totalSteps, progress.step - 1));
            this.progressBarEl.dataset.step = String(progress.step);
            this.progressBarEl.dataset.totalSteps = String(progress.totalSteps);
        }
        if (this.progressMetaEl) {
            this.progressMetaEl.textContent = `Step ${progress.step} of ${progress.totalSteps} · ${this.progressElapsedText()}`;
        }
    }
    async nextRenderFrame() {
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    prepareDiffContent() {
        this.horizontalVisibilityObserver?.disconnect();
        this.horizontalVisibilityObserver = null;
        this.visibleHorizontalContents.clear();
        const content = this.contentEl;
        content.replaceChildren();
        content.className = "view-content vvc-diff-view is-comparing";
        content.classList.toggle("is-nowrap", this.state.wrapLines === false);
        content.classList.toggle("is-wrap", this.state.wrapLines !== false);
        content.classList.toggle("is-gridless", this.plugin.settings.diffGridLines === false);
        this.refreshTypography();
        this.overviewViewportEl = null;
        this.diffRows = null;
        const main = htmlEl(content, "div", "vvc-diff-main");
        const body = htmlEl(main, "div", "vvc-diff-body");
        const overview = htmlEl(main, "div", "vvc-diff-overview");
        overview.setAttribute("aria-label", "Difference overview");
        this.diffBodyEl = body;
        this.overviewEl = overview;
        this.clearProgressRefs();
        this.ensureProgressOverlay();
        return { body, overview };
    }
    appendDiffRows(body, overview, rows, start, end) {
        for (let index = start; index < end; index += 1) {
            const row = rows[index];
            if (row.kind === "separator") {
                const separator = htmlEl(body, "div", "vvc-diff-separator", "⋯ unchanged lines ⋯");
                separator.setAttribute("role", "separator");
                continue;
            }
            const rowEl = htmlEl(body, "div", `vvc-diff-row is-${row.kind}`);
            this.renderCell(rowEl, "left", row.left);
            this.renderCell(rowEl, "right", row.right);
            // The minimap is derived from the full Diff, not visible rows.
        }
    }
    scheduleDiffScroll(body, overview, rows, requestId) {
        if (this.diffScrollRaf !== null)
            return;
        this.diffScrollRaf = window.requestAnimationFrame(() => {
            this.diffScrollRaf = null;
            if (requestId !== this.comparisonRequestId || this.diffBodyEl !== body)
                return;
            void this.advanceDiffWindow(body, overview, rows, requestId);
        });
    }
    async advanceDiffWindow(body, overview, rows, requestId) {
        if (this.diffWindowBusy || rows.length <= DIFF_PAGE_ROWS || requestId !== this.comparisonRequestId)
            return;
        const viewport = Math.max(1, body.clientHeight);
        const scroll = body.scrollTop;
        const top = this.diffTopSpacer?.offsetHeight ?? 0;
        const bottom = this.diffBottomSpacer?.offsetTop ?? body.scrollHeight;
        const windowSize = this.diffWindowSize || DIFF_PAGE_ROWS;
        const maxStart = Math.max(0, rows.length - windowSize);
        const half = Math.max(1, Math.floor((this.diffWindowEnd - this.diffWindowStart) / 2));
        let next = this.diffWindowStart;
        const nearBottom = scroll + viewport >= bottom - viewport;
        const nearTop = scroll <= top + viewport;
        if (nearBottom && this.diffWindowEnd < rows.length) {
            next = Math.min(maxStart, this.diffWindowStart + half);
            if (scroll > bottom + viewport) {
                next = Math.min(maxStart, Math.max(0, Math.floor(scroll / this.diffRowHeight) - half));
            }
        }
        else if (nearTop && this.diffWindowStart > 0) {
            next = Math.max(0, this.diffWindowStart - half);
            if (scroll + viewport < top - viewport) {
                next = Math.min(maxStart, Math.max(0, Math.floor(scroll / this.diffRowHeight) - half));
            }
        }
        if (next !== this.diffWindowStart) {
            await this.renderDiffWindow(body, overview, rows, next, requestId);
        }
    }
    async renderDiffWindow(body, overview, rows, start, requestId, targetIndex) {
        if (requestId !== this.comparisonRequestId || (this.diffWindowBusy && targetIndex === undefined))
            return;
        const generation = ++this.diffWindowGeneration;
        this.diffWindowBusy = true;
        try {
            const end = Math.min(rows.length, start + (this.diffWindowSize || DIFF_PAGE_ROWS));
            const previousScrollTop = body.scrollTop;
            const previousNodes = Array.from(body.querySelectorAll(".vvc-diff-row, .vvc-diff-separator"));
            // Anchor the first visible row shared by both windows. Its screen
            // position must not change when old rows are recycled.
            let anchorIndex = -1;
            let anchorTop = 0;
            for (let i = 0; i < previousNodes.length; i += 1) {
                const node = previousNodes[i];
                if (node.offsetTop + node.offsetHeight > previousScrollTop) {
                    anchorIndex = this.diffWindowStart + i;
                    anchorTop = node.offsetTop;
                    break;
                }
            }
            const staging = document.createDocumentFragment();
            // Preserve the global minimap while recycling only the visible rows.
            const topSpacer = htmlEl(staging, "div", "vvc-diff-virtual-spacer");
            topSpacer.style.height = `${start * this.diffRowHeight}px`;
            for (let index = start; index < end;) {
                if (requestId !== this.comparisonRequestId || generation !== this.diffWindowGeneration)
                    return;
                const frameStart = Date.now();
                const frameLimit = Math.min(end, index + DIFF_RENDER_BATCH_ROWS);
                do {
                    const partEnd = Math.min(frameLimit, index + 50);
                    this.appendDiffRows(staging, overview, rows, index, partEnd);
                    index = partEnd;
                } while (index < frameLimit && Date.now() - frameStart < DIFF_FRAME_BUDGET_MS);
                const batchEnd = index;
                if (this.comparisonRunning) {
                    this.updateProgress({
                        step: 4, totalSteps: 4, message: "Rendering differences…",
                        detail: `${batchEnd.toLocaleString()} of ${rows.length.toLocaleString()} rows`,
                    });
                    if (this.progressBarEl) {
                        this.progressBarEl.max = Math.max(1, end);
                        this.progressBarEl.value = batchEnd;
                    }
                }
                await this.nextRenderFrame();
            }
            if (requestId !== this.comparisonRequestId || generation !== this.diffWindowGeneration)
                return;
            const bottomSpacer = htmlEl(staging, "div", "vvc-diff-virtual-spacer");
            bottomSpacer.style.height = `${(rows.length - end) * this.diffRowHeight}px`;
            this.horizontalVisibilityObserver?.disconnect();
            this.horizontalVisibilityObserver = null;
            this.visibleHorizontalContents.clear();
            body.replaceChildren(staging);
            this.diffWindowStart = start;
            this.diffWindowEnd = end;
            this.diffTopSpacer = topSpacer;
            this.diffBottomSpacer = bottomSpacer;
            const currentNodes = Array.from(body.querySelectorAll(".vvc-diff-row, .vvc-diff-separator"));
            if (targetIndex !== undefined && targetIndex >= start && targetIndex < end) {
                body.scrollTop = Math.max(0, currentNodes[targetIndex - start].offsetTop - body.clientHeight * 0.2);
            }
            else if (anchorIndex >= start && anchorIndex < end) {
                body.scrollTop = previousScrollTop + currentNodes[anchorIndex - start].offsetTop - anchorTop;
            }
            // Sample the first page once, then keep spacer geometry stable while
            // scrolling; continually changing the estimate would make the thumb jump.
            if (!this.diffRowHeightMeasured && currentNodes.length) {
                const totalHeight = currentNodes.reduce((height, node) => height + node.offsetHeight, 0);
                if (totalHeight > 0) {
                    this.diffRowHeight = Math.max(16, Math.min(160, totalHeight / currentNodes.length));
                    this.diffRowHeightMeasured = true;
                    this.lastDiffTypographySignature = this.diffTypographySignature(body);
                    topSpacer.style.height = `${start * this.diffRowHeight}px`;
                    bottomSpacer.style.height = `${(rows.length - end) * this.diffRowHeight}px`;
                }
            }
            this.installHorizontalVisibilityObserver(body);
            this.measureHorizontalRange();
            this.scheduleOverviewUpdate();
        }
        finally {
            if (generation === this.diffWindowGeneration) {
                this.diffWindowBusy = false;
                if (requestId === this.comparisonRequestId && !this.comparisonRunning) {
                    this.scheduleDiffScroll(body, overview, rows, requestId);
                }
            }
        }
    }
    async renderOrdinaryDiff(body, overview, rows, requestId) {
        // Ordinary Markdown comparisons are rendered in full. No spacer geometry,
        // virtual window movement, or scroll-driven content replacement is used.
        for (let start = 0; start < rows.length;) {
            if (requestId !== this.comparisonRequestId)
                return;
            const frameStart = Date.now();
            const frameLimit = Math.min(rows.length, start + DIFF_RENDER_BATCH_ROWS);
            do {
                const partEnd = Math.min(frameLimit, start + 50);
                this.appendDiffRows(body, overview, rows, start, partEnd);
                start = partEnd;
            } while (start < frameLimit && Date.now() - frameStart < DIFF_FRAME_BUDGET_MS);
            const end = start;
            this.updateProgress({
                step: 4,
                totalSteps: 4,
                message: "Rendering differences…",
                detail: `${end.toLocaleString()} of ${rows.length.toLocaleString()} rows`,
            });
            if (this.progressBarEl) {
                this.progressBarEl.max = Math.max(1, rows.length);
                this.progressBarEl.value = end;
            }
            await this.nextRenderFrame();
        }
        if (requestId !== this.comparisonRequestId)
            return;
        this.installHorizontalVisibilityObserver(body);
        this.measureHorizontalRange();
        this.scheduleOverviewUpdate();
    }
    async renderDiffIncrementally(requestId) {
        this.updateProgress({
            step: 4,
            totalSteps: 4,
            message: "Preparing comparison view…",
            detail: "Parsing differences",
        });
        await this.nextRenderFrame();
        if (requestId !== this.comparisonRequestId)
            return;
        const rows = parseUnifiedDiff(this.state.diffText);
        if (requestId !== this.comparisonRequestId)
            return;
        this.comparisonIdentical = rows.length === 0;
        if (!rows.length) {
            this.comparisonRunning = false;
            this.comparisonCompleted = true;
            this.stopProgressTimer();
            this.updateWrapAction();
            this.clearProgressRefs();
            this.render();
            return;
        }
        const { body, overview } = this.prepareDiffContent();
        this.buildDiffOverview(rows, overview);
        const largeDiff = rows.length > DIFF_PAGE_ROWS;
        if (largeDiff) {
            await this.renderDiffWindow(body, overview, rows, 0, requestId);
        }
        else {
            await this.renderOrdinaryDiff(body, overview, rows, requestId);
        }
        if (requestId !== this.comparisonRequestId)
            return;
        this.installSharedHorizontalScroll(body);
        body.addEventListener("scroll", () => {
            this.scheduleOverviewUpdate();
            if (largeDiff)
                this.scheduleDiffScroll(body, overview, rows, requestId);
        }, { passive: true });
        await this.nextRenderFrame();
        await this.nextRenderFrame();
        if (requestId !== this.comparisonRequestId)
            return;
        this.progressOverlayEl?.remove();
        this.clearProgressRefs();
        this.comparisonRunning = false;
        this.stopProgressTimer();
        this.contentEl.classList.remove("is-comparing");
        this.comparisonCompleted = true;
        this.updateWrapAction();
        this.scheduleOverviewUpdate();
        if (largeDiff)
            this.scheduleDiffScroll(body, overview, rows, requestId);
    }
    render(errorMessage = "") {
        const content = this.contentEl;
        if (!content)
            return;
        content.replaceChildren();
        this.clearProgressRefs();
        content.className = "view-content vvc-diff-view";
        content.classList.toggle("is-nowrap", this.state.wrapLines === false);
        content.classList.toggle("is-wrap", this.state.wrapLines !== false);
        content.classList.toggle("is-gridless", this.plugin.settings.diffGridLines === false);
        this.refreshTypography();
        this.overviewViewportEl = null;
        this.diffRows = null;
        const main = htmlEl(content, "div", "vvc-diff-main");
        const body = htmlEl(main, "div", "vvc-diff-body");
        const overview = htmlEl(main, "div", "vvc-diff-overview");
        overview.setAttribute("aria-label", "Difference overview");
        this.diffBodyEl = body;
        this.overviewEl = overview;
        if (errorMessage) {
            const failure = describeGitFailure(errorMessage, "diff");
            content.classList.add("is-restored");
            const panel = htmlEl(body, "div", "vvc-diff-restored-state");
            panel.setAttribute("role", "alert");
            htmlEl(panel, "h2", "vvc-diff-restored-title", failure.title);
            htmlEl(panel, "p", "vvc-diff-restored-description", failure.guidance);
            const retry = buttonEl(panel, "Retry comparison", "mod-cta");
            retry.addEventListener("click", () => {
                retry.disabled = true;
                this.startComparison(true);
            });
            const details = htmlEl(panel, "details", "vvc-error-details");
            htmlEl(details, "summary", "vvc-error-summary", "Technical details");
            htmlEl(details, "pre", "vvc-error-raw", failure.technical);
            overview.classList.add("is-empty");
            return;
        }
        if (!this.state.left || !this.state.right) {
            htmlEl(body, "div", "vvc-empty", "No comparison selected.");
            overview.classList.add("is-empty");
            return;
        }
        if (!this.comparisonCompleted) {
            content.classList.add("is-restored");
            const restored = htmlEl(body, "div", "vvc-diff-restored-state");
            const icon = htmlEl(restored, "div", "vvc-diff-restored-icon");
            icon.setAttribute("aria-hidden", "true");
            (0, obsidian_1.setIcon)(icon, "diff");
            htmlEl(restored, "h2", "vvc-diff-restored-title", "Comparison not loaded");
            htmlEl(restored, "p", "vvc-diff-restored-description", "Load the comparison to view differences.");
            const load = buttonEl(restored, "Load comparison", "mod-cta");
            load.addEventListener("click", () => {
                load.disabled = true;
                this.startComparison(true);
            });
            overview.classList.add("is-empty");
            return;
        }
        content.classList.add("is-identical");
        const identical = htmlEl(body, "div", "vvc-diff-identical-state");
        identical.setAttribute("role", "status");
        const icon = htmlEl(identical, "div", "vvc-diff-restored-icon");
        icon.setAttribute("aria-hidden", "true");
        (0, obsidian_1.setIcon)(icon, "check-circle");
        htmlEl(identical, "h2", "vvc-diff-restored-title", "No differences");
        htmlEl(identical, "p", "vvc-diff-restored-description", "The selected files have identical content.");
        overview.classList.add("is-empty");
    }
}
class TextFileSuggestModal extends obsidian_1.FuzzySuggestModal {
    constructor(plugin, excludedPath, resolveChoice) {
        super(plugin.app);
        this.selectedFile = null;
        this.resolved = false;
        this.resolveTimer = null;
        this.plugin = plugin;
        this.excludedPath = excludedPath;
        this.resolveChoice = resolveChoice;
        this.setPlaceholder(excludedPath ? "Compare with…" : "Choose a text file");
    }
    getItems() {
        return this.plugin.app.vault
            .getFiles()
            .filter((file) => isTextFile(file) && file.path !== this.excludedPath)
            .sort((a, b) => a.path.localeCompare(b.path));
    }
    getItemText(file) {
        return file.path;
    }
    scheduleResolve() {
        if (this.resolved || this.resolveTimer !== null)
            return;
        // Obsidian's FuzzySuggestModal callback/close ordering can vary by input path.
        // Delay resolution until the selection event and modal teardown have both finished.
        // This makes the result independent of whether onChooseItem or onClose happens first,
        // and prevents the newly opened Diff modal from being consumed by the old modal's close.
        this.resolveTimer = window.setTimeout(() => {
            this.resolveTimer = null;
            if (this.resolved)
                return;
            this.resolved = true;
            this.resolveChoice(this.selectedFile);
        }, 200);
    }
    onChooseItem(file, _evt) {
        this.selectedFile = file;
        this.scheduleResolve();
    }
    onClose() {
        this.scheduleResolve();
    }
}
class HistoricalRemovalDiffModal extends obsidian_1.Modal {
    constructor(app, filePath, patch) {
        super(app);
        this.filePath = filePath;
        this.patch = patch;
    }
    onOpen() {
        const content = this.contentEl;
        content.replaceChildren();
        htmlEl(content, "h2", "vvc-modal-title", "Git removal change");
        htmlEl(content, "p", "vvc-modal-copy", "This commit removed the file from the Git tree. This is a history diff, not a comparison with the current local file.");
        htmlEl(content, "div", "vvc-history-removal-path", this.filePath);
        htmlEl(content, "pre", "vvc-history-removal-patch", this.patch || "No file-removal patch is available for this commit.");
    }
}
class FileHistoryPopover {
    constructor(plugin) {
        this.currentPath = "";
        this.currentFileTracked = null;
        this.history = [];
        this.compareMode = false;
        this.compareSelections = [];
        this.comparePinned = false;
        this.pinned = false;
        this.hideTimer = null;
        this.requestId = 0;
        this.onDocumentMouseDown = (event) => {
            if (this.rootEl.hidden)
                return;
            if (!this.rootEl.contains(event.target))
                this.close();
        };
        this.plugin = plugin;
        this.rootEl = document.createElement("div");
        this.rootEl.className = "vvc-file-history-popover";
        this.rootEl.hidden = true;
        const header = htmlEl(this.rootEl, "div", "vvc-popover-header");
        const headingRow = htmlEl(header, "div", "vvc-popover-heading-row");
        htmlEl(headingRow, "div", "vvc-popover-heading", "File History");
        this.compareButtonEl = buttonEl(headingRow, "Compare", "vvc-link-button vvc-history-compare-button");
        this.compareButtonEl.addEventListener("click", () => this.toggleCompareMode());
        this.titleEl = htmlEl(header, "div", "vvc-popover-path");
        this.historyEl = htmlEl(this.rootEl, "div", "vvc-popover-history");
        document.body.appendChild(this.rootEl);
        this.rootEl.addEventListener("mouseenter", () => this.cancelHide());
        this.rootEl.addEventListener("mouseleave", () => {
            if (!this.pinned)
                this.scheduleHide();
        });
        this.rootEl.addEventListener("mousedown", (event) => event.stopPropagation());
        document.addEventListener("mousedown", this.onDocumentMouseDown, true);
    }
    destroy() {
        if (this.hideTimer !== null)
            window.clearTimeout(this.hideTimer);
        document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
        this.rootEl.remove();
    }
    cancelHide() {
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }
    scheduleHide() {
        this.cancelHide();
        this.hideTimer = window.setTimeout(() => {
            if (!this.pinned)
                this.close();
        }, HOVER_CLOSE_MS);
    }
    close() {
        this.cancelHide();
        this.rootEl.hidden = true;
        this.pinned = false;
        this.currentPath = "";
        this.currentFileTracked = null;
        this.history = [];
        this.compareMode = false;
        this.compareSelections = [];
        this.comparePinned = false;
    }
    async showHover(filePath, anchor) {
        this.pinned = false;
        await this.show(filePath, { anchor });
    }
    async showPinned(filePath, point) {
        this.pinned = true;
        await this.show(filePath, { point });
    }
    async show(filePath, position) {
        this.cancelHide();
        this.currentPath = filePath;
        this.currentFileTracked = null;
        this.history = [];
        this.compareMode = false;
        this.compareSelections = [];
        this.comparePinned = false;
        this.updateCompareButton();
        const thisRequest = ++this.requestId;
        this.titleEl.textContent = filePath;
        this.historyEl.replaceChildren();
        htmlEl(this.historyEl, "div", "vvc-empty", "Loading history…");
        this.rootEl.hidden = false;
        this.position(position);
        try {
            const [history, tracked] = await Promise.all([
                this.plugin.git.fileHistory(filePath),
                this.plugin.git.isFileTracked(filePath).catch(() => null),
            ]);
            if (thisRequest !== this.requestId || this.currentPath !== filePath)
                return;
            this.currentFileTracked = tracked;
            this.history = history;
            this.renderHistory();
        }
        catch (error) {
            if (thisRequest !== this.requestId)
                return;
            this.historyEl.replaceChildren();
            htmlEl(this.historyEl, "div", "vvc-inline-error", gitFailureNotice(error, "history"));
        }
    }
    updateCompareButton() {
        this.compareButtonEl.textContent = this.compareMode ? "Cancel" : "Compare";
        this.compareButtonEl.classList.toggle("is-active", this.compareMode);
        this.compareButtonEl.setAttribute("aria-pressed", this.compareMode ? "true" : "false");
    }
    toggleCompareMode() {
        this.compareMode = !this.compareMode;
        this.compareSelections = [];
        if (this.compareMode && !this.pinned) {
            this.pinned = true;
            this.comparePinned = true;
        }
        else if (!this.compareMode && this.comparePinned) {
            this.pinned = false;
            this.comparePinned = false;
        }
        this.updateCompareButton();
        this.renderHistory();
    }
    renderHistory() {
        this.historyEl.replaceChildren();
        if (!this.history.length) {
            htmlEl(this.historyEl, "div", "vvc-empty", "No committed history for this file.");
            return;
        }
        let mergedRemoval = null;
        if (this.compareMode) {
            const hint = this.compareSelections.length === 0
                ? "Select two file contents: current local file or committed versions."
                : "Select another available file content (B).";
            htmlEl(this.historyEl, "div", "vvc-history-compare-hint", hint);
            const currentFile = this.plugin.app.vault.getAbstractFileByPath(this.currentPath);
            if (currentFile instanceof obsidian_1.TFile && isTextFile(currentFile) &&
                this.localFileAvailable(this.currentPath)) {
                // The latest removal of this exact path is historical metadata for an
                // existing untracked local file, not another selectable file version.
                // Older removal events and renamed paths remain separate history rows.
                const latest = this.history[0];
                if (this.currentFileTracked === false && latest?.contentAvailable === false &&
                    latest.pathAtCommit === this.currentPath) {
                    mergedRemoval = latest;
                }
                this.renderWorkingCopyEntry(mergedRemoval);
            }
        }
        for (const entry of this.history) {
            if (entry === mergedRemoval)
                continue;
            this.renderHistoryEntry(entry);
        }
    }
    position(position) {
        const width = 320;
        const maxHeight = Math.min(420, window.innerHeight - 16);
        let left = 8;
        let top = 8;
        if (position.anchor) {
            const anchor = position.anchor;
            left = anchor.left - width - 10;
            if (left < 8)
                left = Math.min(anchor.right + 10, window.innerWidth - width - 8);
            top = Math.min(Math.max(8, anchor.top - 16), window.innerHeight - maxHeight - 8);
        }
        else if (position.point) {
            left = Math.min(Math.max(8, position.point.x), window.innerWidth - width - 8);
            top = Math.min(Math.max(8, position.point.y), window.innerHeight - maxHeight - 8);
        }
        this.rootEl.style.left = `${left}px`;
        this.rootEl.style.top = `${top}px`;
        this.rootEl.style.width = `${width}px`;
        this.rootEl.style.maxHeight = `${maxHeight}px`;
    }
    sourceKey(source) {
        return source.kind === "working-tree"
            ? `working:${source.filePath}`
            : `revision:${source.hash}:${source.pathAtCommit}`;
    }
    selectionIndex(source) {
        const key = this.sourceKey(source);
        return this.compareSelections.findIndex((candidate) => this.sourceKey(candidate) === key);
    }
    async selectCompareSource(source) {
        if (source.kind === "revision" && source.absentAtCommit)
            return;
        const existing = this.selectionIndex(source);
        if (existing >= 0) {
            this.compareSelections.splice(existing, 1);
            this.renderHistory();
            return;
        }
        this.compareSelections.push(source);
        if (this.compareSelections.length < 2) {
            this.renderHistory();
            return;
        }
        const [first, second] = this.compareSelections;
        const order = (candidate) => candidate.kind === "working-tree"
            ? Number.POSITIVE_INFINITY
            : candidate.timestamp;
        const [left, right] = order(first) <= order(second) ? [first, second] : [second, first];
        // The comparison reader also checks disk existence immediately before
        // reading; this preflight avoids opening a stale local comparison tab.
        if ([left, right].some((item) => item.kind === "working-tree" &&
            !this.localFileAvailable(item.filePath))) {
            new obsidian_1.Notice("Current local file is no longer on disk. Select another version.");
            this.compareSelections = [];
            this.renderHistory();
            return;
        }
        this.close();
        await this.plugin.compareHistorySources(left, right);
    }
    localFileAvailable(filePath) {
        try {
            const stat = fs.lstatSync(checkedVaultFilePath(this.plugin.git.vaultPath, filePath));
            return stat.isFile() && !stat.isSymbolicLink();
        }
        catch {
            return false;
        }
    }
    makeSelectable(row, source) {
        const selectedIndex = this.selectionIndex(source);
        row.classList.toggle("is-compare-selectable", this.compareMode);
        row.classList.toggle("is-selected-a", selectedIndex === 0);
        row.classList.toggle("is-selected-b", selectedIndex === 1);
        if (!this.compareMode)
            return;
        row.setAttribute("role", "button");
        row.setAttribute("aria-label", selectedIndex >= 0
            ? `Remove ${selectedIndex === 0 ? "A" : "B"} selection`
            : "Select version for comparison");
        row.addEventListener("click", () => void this.selectCompareSource(source));
        row.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ")
                return;
            event.preventDefault();
            void this.selectCompareSource(source);
        });
    }
    renderSelectionBadge(row, source) {
        if (!this.compareMode)
            return;
        const selectedIndex = this.selectionIndex(source);
        const badge = htmlEl(row, "div", "vvc-history-selection-badge", selectedIndex === 0 ? "A" : selectedIndex === 1 ? "B" : "");
        badge.setAttribute("aria-hidden", "true");
    }
    renderWorkingCopyEntry(removal = null) {
        const source = workingTreeDiffSource(this.currentPath, this.currentFileTracked ?? undefined);
        const row = htmlEl(this.historyEl, "div", "vvc-file-history-entry vvc-working-copy-entry");
        row.tabIndex = 0;
        const timeline = htmlEl(row, "div", "vvc-file-history-timeline");
        timeline.setAttribute("aria-hidden", "true");
        htmlEl(timeline, "span", "vvc-file-history-dot");
        const content = htmlEl(row, "div", "vvc-file-history-content");
        htmlEl(content, "div", "vvc-history-subject", "Current local file");
        const trackStatus = removal
            ? ` · Removed from Git in ${removal.shortHash} · ${new Date(removal.timestamp * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`
            : this.currentFileTracked === false ? " · Not tracked by Git" :
                this.currentFileTracked === true ? " · Tracked by Git" : "";
        const meta = htmlEl(content, "div", "vvc-history-meta", `Saved on disk${trackStatus}`);
        meta.title = removal
            ? `Saved on disk · Removed from Git in ${removal.shortHash} · ${formatDate(removal.timestamp)}. Comparison uses saved bytes, not unsaved editor changes.`
            : "Comparison reads saved bytes from disk, not unsaved Obsidian editor changes.";
        if (removal)
            this.renderRemovalChangeAction(content, removal, false);
        this.renderSelectionBadge(row, source);
        this.makeSelectable(row, source);
    }
    renderRemovalChangeAction(content, entry, closeOnOpen) {
        const actions = htmlEl(content, "div", "vvc-history-actions");
        const change = buttonEl(actions, "View Git change", "vvc-link-button vvc-history-view-button");
        change.addEventListener("keydown", (event) => event.stopPropagation());
        change.addEventListener("click", async (event) => {
            event.stopPropagation();
            if (change.disabled)
                return;
            change.disabled = true;
            try {
                const patch = await this.plugin.git.historicalRemovalPatch(entry);
                new HistoricalRemovalDiffModal(this.plugin.app, this.currentPath, patch).open();
                if (closeOnOpen)
                    this.close();
                else
                    change.disabled = false;
            }
            catch (error) {
                change.disabled = false;
                new obsidian_1.Notice(error instanceof Error ? error.message : String(error));
            }
        });
    }
    renderHistoryEntry(entry) {
        const source = revisionDiffSource(this.currentPath, entry);
        const row = htmlEl(this.historyEl, "div", "vvc-file-history-entry");
        row.tabIndex = 0;
        const timeline = htmlEl(row, "div", "vvc-file-history-timeline");
        timeline.setAttribute("aria-hidden", "true");
        htmlEl(timeline, "span", "vvc-file-history-dot");
        const content = htmlEl(row, "div", "vvc-file-history-content");
        const subject = htmlEl(content, "div", "vvc-history-subject", entry.subject || "(no commit message)");
        subject.title = entry.subject || "(no commit message)";
        const metaParts = [entry.shortHash, formatDate(entry.timestamp)];
        if (entry.decorations)
            metaParts.push(entry.decorations);
        htmlEl(content, "div", "vvc-history-meta", metaParts.filter(Boolean).join(" · "));
        if (entry.contentAvailable === false) {
            const eventLabel = htmlEl(content, "div", "vvc-history-event-label", "Removed from Git");
            eventLabel.title = "No file content in this commit";
            eventLabel.setAttribute("aria-label", "Removed from Git; no file content in this commit");
        }
        if (this.compareMode) {
            if (entry.contentAvailable === false) {
                row.tabIndex = -1;
                row.setAttribute("aria-label", "Removed from Git: historical event, not a comparison version");
            }
            else {
                this.renderSelectionBadge(row, source);
                this.makeSelectable(row, source);
            }
            return;
        }
        // A removal event has its own read-only patch, never file content actions.
        if (entry.contentAvailable === false) {
            this.renderRemovalChangeAction(content, entry, true);
            return;
        }
        const actions = htmlEl(content, "div", "vvc-history-actions");
        if (isMarkdownPath(this.currentPath)) {
            const view = buttonEl(actions, "View", "vvc-link-button vvc-history-view-button");
            view.addEventListener("click", async (event) => {
                event.stopPropagation();
                view.disabled = true;
                try {
                    await this.plugin.viewFileFromHistory(this.currentPath, entry);
                    this.close();
                }
                catch (error) {
                    view.disabled = false;
                    new obsidian_1.Notice(error instanceof Error ? error.message : String(error));
                }
            });
        }
        const restore = buttonEl(actions, "Use this version", "vvc-link-button vvc-restore-button");
        restore.addEventListener("click", async (event) => {
            event.stopPropagation();
            restore.disabled = true;
            try {
                await this.plugin.restoreFileFromHistory(this.currentPath, entry);
                this.close();
            }
            catch (error) {
                restore.disabled = false;
                new obsidian_1.Notice(error instanceof Error ? error.message : String(error));
            }
        });
    }
}
class VersionControlView extends obsidian_1.ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.refreshSerial = 0;
        this.branchOrigins = [];
        this.remote = { configured: false, remote: "", displayUrl: "", upstream: "", ahead: null, behind: null, lastFetchedAt: null };
        this.remoteAuthenticationFailure = null;
        this.historyFocusBranch = "";
        this.observedCurrentBranch = "";
        this.commitDraft = defaultCommitMessage();
        this.commitDraftIsAutomatic = true;
        this.plugin = plugin;
    }
    getViewType() {
        return VIEW_TYPE;
    }
    getDisplayText() {
        return "Version Control";
    }
    getIcon() {
        return "git-branch";
    }
    async onOpen() {
        const container = this.containerEl;
        container.replaceChildren();
        container.classList.add("vvc-view");
        this.bodyEl = htmlEl(container, "div", "vvc-view-body");
        this.statusMessageEl = htmlEl(container, "div", "vvc-status-message");
        await this.refresh();
    }
    showMoreActions(event) {
        const menu = new obsidian_1.Menu();
        menu.addItem((item) => {
            item.setTitle("Ignore files or folders…").setIcon("file-minus").onClick(() => {
                new IgnoreFilesModal(this.plugin).open();
            });
        });
        menu.addItem((item) => {
            item.setTitle("Remote repository…").setIcon("cloud").onClick(() => {
                new RemoteRepositoryModal(this.plugin, this.remote).open();
            });
        });
        if (this.plugin.git.isNetworkBusy())
            menu.addItem((item) => {
                item.setTitle("Cancel remote operation").setIcon("x-circle").onClick(() => this.plugin.git.cancelNetwork());
            });
        if (this.remote.configured)
            menu.addItem((item) => {
                item.setTitle("Fetch from origin").setIcon("download").onClick(async () => {
                    this.remoteAuthenticationFailure = null;
                    this.setStatusMessage("Fetching from remote…");
                    // Re-render the action menu while the operation is running so the user
                    // can reach Cancel; refreshing the view itself never fetches.
                    window.setTimeout(() => { void this.refresh(); }, 250);
                    try {
                        await this.plugin.git.fetchRemote();
                        new obsidian_1.Notice("Remote references updated. Files were not modified.");
                    }
                    catch (error) {
                        if (error instanceof RemoteGitAuthenticationError)
                            this.remoteAuthenticationFailure = error;
                        else
                            new obsidian_1.Notice(error instanceof Error ? error.message : "Fetch failed.", 7000);
                    }
                    finally {
                        await this.refresh();
                    }
                });
            });
        menu.addItem((item) => {
            item
                .setTitle("Refresh Git Status")
                .setIcon("refresh-cw")
                .onClick(async () => {
                await this.refresh(true);
            });
        });
        menu.showAtMouseEvent(event);
    }
    async onClose() {
        // View-owned DOM listeners are removed with the view DOM.
    }
    async refresh(manual = false) {
        const serial = ++this.refreshSerial;
        if (!this.bodyEl)
            return;
        if (manual) {
            this.setStatusMessage("Refreshing Git status…");
            this.plugin.git.invalidateDetection();
        }
        const environment = await this.plugin.git.detectGit();
        if (serial !== this.refreshSerial)
            return;
        if (!environment.available) {
            this.renderGitEnvironmentError(environment);
            return;
        }
        try {
            if (!this.plugin.git.hasLocalRepository()) {
                this.renderNotInitialized();
                if (manual)
                    this.setStatusMessage("Git status refreshed.");
                return;
            }
            const [status, currentBranch, branches, graph, remote] = await Promise.all([
                this.plugin.git.status(),
                this.plugin.git.currentBranch(),
                this.plugin.git.branches(),
                this.plugin.git.vaultGraph(),
                this.plugin.git.remoteSummary(),
            ]);
            const branchOrigins = await this.plugin.git.branchOrigins(branches);
            if (serial !== this.refreshSerial)
                return;
            this.branchOrigins = branchOrigins;
            this.remote = remote;
            const scrollTop = this.bodyEl.scrollTop;
            const scrollLeft = this.bodyEl.scrollLeft;
            this.renderRepository(status, currentBranch, branches, graph);
            this.bodyEl.scrollTop = scrollTop;
            this.bodyEl.scrollLeft = scrollLeft;
            if (manual)
                this.setStatusMessage("Git status refreshed.");
        }
        catch (error) {
            if (serial !== this.refreshSerial)
                return;
            this.renderGitCommandError(error instanceof Error ? error.message : String(error));
        }
    }
    setStatusMessage(message) {
        if (!this.statusMessageEl)
            return;
        this.statusMessageEl.textContent = message;
        if (message) {
            window.setTimeout(() => {
                if (this.statusMessageEl?.textContent === message)
                    this.statusMessageEl.textContent = "";
            }, 3500);
        }
    }
    renderGitEnvironmentError(environment) {
        this.bodyEl.replaceChildren();
        const panel = htmlEl(this.bodyEl, "div", "vvc-state-panel vvc-git-error-panel");
        let title = "Git is unavailable";
        let copy = "No usable Git executable was found. Vault Version Control can check again or you can choose a custom Git executable in settings.";
        let command = "";
        if (environment.kind === "xcode_license") {
            title = "Git needs one-time macOS setup";
            copy = "Apple Git is installed, but the Xcode license has not been accepted. Open Terminal and complete Apple's license prompt, then check again.";
            command = "sudo xcodebuild -license";
        }
        else if (environment.kind === "command_line_tools") {
            title = "Git requires Apple Command Line Tools";
            copy = "The Command Line Tools required by Apple Git are not installed or are not configured. Start the macOS installer, then check again when installation finishes.";
            command = "xcode-select --install";
        }
        else if (environment.kind === "permission") {
            title = "Git is not accessible";
            copy = "Obsidian cannot run the selected Git executable. Check its execute permissions and the configured path, then try again.";
        }
        else if (environment.mode === "custom") {
            title = "Custom Git is unavailable";
            copy = "The configured Git executable could not be used. Check the path, switch back to Auto detect, or test the configuration again.";
        }
        htmlEl(panel, "div", "vvc-state-title", title);
        htmlEl(panel, "div", "vvc-state-copy", copy);
        if (command)
            htmlEl(panel, "code", "vvc-command-code", command);
        const actions = htmlEl(panel, "div", "vvc-state-actions");
        if (environment.kind === "xcode_license") {
            const terminal = buttonEl(actions, "Open Terminal", "vvc-button");
            terminal.addEventListener("click", () => void this.plugin.openTerminal());
            const copyButton = buttonEl(actions, "Copy command", "vvc-button");
            copyButton.addEventListener("click", async () => {
                await this.plugin.copyText(command);
                new obsidian_1.Notice("Command copied.");
            });
        }
        else if (environment.kind === "command_line_tools") {
            const install = buttonEl(actions, "Start installation", "vvc-button");
            install.addEventListener("click", async () => {
                install.disabled = true;
                try {
                    await this.plugin.startCommandLineToolsInstall();
                    new obsidian_1.Notice("macOS Command Line Tools installer started.");
                }
                catch (error) {
                    new obsidian_1.Notice(error instanceof Error ? error.message : String(error), 7000);
                }
                finally {
                    install.disabled = false;
                }
            });
        }
        const check = buttonEl(actions, "Check again", "vvc-button vvc-button-primary");
        check.addEventListener("click", async () => {
            check.disabled = true;
            await this.refresh(true);
        });
        const advanced = buttonEl(actions, "Configure Git executable", "vvc-link-button vvc-settings-link");
        advanced.addEventListener("click", () => this.plugin.openPluginSettings());
        if (environment.message && environment.kind !== "xcode_license" && environment.kind !== "command_line_tools") {
            const details = htmlEl(panel, "details", "vvc-error-details");
            htmlEl(details, "summary", "vvc-error-summary", "Technical details");
            htmlEl(details, "pre", "vvc-error-raw", environment.message);
        }
    }
    renderGitCommandError(message) {
        const failure = describeGitFailure(message, "status");
        this.bodyEl.replaceChildren();
        const panel = htmlEl(this.bodyEl, "div", "vvc-state-panel vvc-git-error-panel");
        htmlEl(panel, "div", "vvc-state-title", failure.title);
        htmlEl(panel, "div", "vvc-state-copy", failure.guidance);
        const actions = htmlEl(panel, "div", "vvc-state-actions");
        const check = buttonEl(actions, "Check again", "vvc-button vvc-button-primary");
        check.addEventListener("click", () => {
            check.disabled = true;
            void this.refresh(true);
        });
        if (/interrupted remote initialization detected/i.test(message)) {
            try {
                const report = this.plugin.git.inspectInterruptedRemoteImport();
                const diagnostic = report.state === "journaled"
                    ? `Imported files: ${report.matchingFiles.length} verified, ${report.missingFiles.length} missing, ${report.changedOrUnsafeFiles.length} changed or unsafe.`
                    : "This interrupted import needs a manual review before it can be recovered.";
                htmlEl(panel, "div", "vvc-state-copy", diagnostic);
                if (report.state === "journaled" && report.metadataPresent &&
                    !report.missingFiles.length && !report.changedOrUnsafeFiles.length) {
                    const recover = buttonEl(actions, "Verify and finish initialization", "vvc-button");
                    recover.addEventListener("click", async () => {
                        recover.disabled = true;
                        try {
                            await this.plugin.git.finalizeVerifiedInterruptedImport();
                            new obsidian_1.Notice("Interrupted initialization verified and completed.");
                            await this.refresh(true);
                        }
                        catch (error) {
                            recover.disabled = false;
                            new obsidian_1.Notice(error instanceof Error ? error.message : "Recovery could not complete.", 7000);
                        }
                    });
                }
                else {
                    htmlEl(panel, "div", "vvc-state-copy", "No files will be deleted automatically. Keep the Vault unchanged and review the interrupted import before trying again.");
                }
            }
            catch {
                htmlEl(panel, "div", "vvc-state-copy", "The recovery journal cannot be verified. Do not delete or overwrite the existing Vault Git metadata.");
            }
        }
        if (failure.configureGit) {
            const configure = buttonEl(actions, "Configure Git executable", "vvc-button");
            configure.addEventListener("click", () => void this.plugin.openPluginSettings());
        }
        if (failure.technical) {
            const details = htmlEl(panel, "details", "vvc-error-details");
            htmlEl(details, "summary", "vvc-error-summary", "Technical details");
            htmlEl(details, "pre", "vvc-error-raw", failure.technical);
        }
    }
    renderNotInitialized() {
        this.bodyEl.replaceChildren();
        const panel = htmlEl(this.bodyEl, "div", "vvc-state-panel vvc-setup-panel");
        htmlEl(panel, "div", "vvc-state-title", "Set Up Git");
        htmlEl(panel, "div", "vvc-state-copy", "Start tracking changes locally or connect this Vault to an existing remote repository.");
        const initActions = htmlEl(panel, "div", "vvc-initialize-actions");
        const initButton = buttonEl(initActions, "Initialize Local Repository", "vvc-button vvc-button-primary vvc-wide-button");
        initButton.addEventListener("click", async () => {
            initButton.disabled = true;
            const originalLabel = initButton.textContent || "Initialize repository";
            const setProgress = (message) => {
                initButton.textContent = message;
                this.setStatusMessage(message);
            };
            try {
                const committed = await this.plugin.initializeRepository(setProgress);
                if (committed) {
                    new obsidian_1.Notice("Git repository initialized and initial commit created.");
                }
                else {
                    new obsidian_1.Notice("Git repository initialized. Complete the Git author prompt to create the initial commit.");
                }
                await this.refresh();
            }
            catch (error) {
                initButton.disabled = false;
                initButton.textContent = originalLabel;
                new obsidian_1.Notice(gitFailureNotice(error, "repository"), 7000);
                // `git init` may have succeeded even if staging or the initial commit failed.
                // Re-render from disk so the sidebar never remains stuck on the stale
                // "not initialized" state after a partial initialization.
                await this.refresh();
            }
        });
        const remoteButton = buttonEl(initActions, "Initialize from Remote…", "vvc-button vvc-wide-button");
        remoteButton.addEventListener("click", () => new InitializeFromRemoteModal(this.plugin).open());
    }
    renderRepository(status, currentBranch, branches, graph) {
        const branchNames = new Set(branches.map((branch) => branch.name));
        const currentChanged = Boolean(this.observedCurrentBranch && this.observedCurrentBranch !== currentBranch);
        if (!this.historyFocusBranch
            || !branchNames.has(this.historyFocusBranch)
            || (currentChanged && branchNames.has(currentBranch))) {
            this.historyFocusBranch = branchNames.has(currentBranch)
                ? currentBranch
                : (branches.find((branch) => branch.current)?.name || branches[0]?.name || "");
        }
        this.observedCurrentBranch = currentBranch;
        this.bodyEl.replaceChildren();
        const branchCard = htmlEl(this.bodyEl, "div", "vvc-current-branch");
        const branchToolbar = htmlEl(branchCard, "div", "vvc-current-branch-toolbar");
        const branchInfo = htmlEl(branchToolbar, "div", "vvc-current-branch-info");
        htmlEl(branchInfo, "span", "vvc-small-label vvc-branch-label", "Current branch");
        htmlEl(branchInfo, "span", "vvc-current-name", currentBranch || "(unborn branch)");
        const moreButton = buttonEl(branchToolbar, "", "vvc-icon-button vvc-current-more");
        (0, obsidian_1.setIcon)(moreButton, "more-vertical");
        moreButton.setAttribute("aria-label", "More actions");
        moreButton.addEventListener("click", (event) => this.showMoreActions(event));
        const remoteLine = htmlEl(branchCard, "div", "vvc-remote-status");
        if (this.remote.configured) {
            const tracking = htmlEl(remoteLine, "span", "vvc-small-label", remoteTrackingStatus(this.remote));
            tracking.setAttribute("title", this.remote.lastFetchedAt
                ? `Compared with locally stored remote tracking refs. Last fetched: ${new Date(this.remote.lastFetchedAt).toLocaleString()}. Not a live server check.`
                : "Compared with locally stored remote tracking refs, not a live server check.");
            const push = buttonEl(remoteLine, "Push", "vvc-title-action");
            push.disabled = this.plugin.git.isNetworkBusy() || !currentBranch || currentBranch === "(detached)" || !branches.some((b) => b.current && b.hash);
            push.addEventListener("click", async () => {
                const perform = async () => {
                    this.remoteAuthenticationFailure = null;
                    push.disabled = true;
                    this.setStatusMessage("Pushing to origin… Complete Git sign-in if requested.");
                    window.setTimeout(() => { void this.refresh(); }, 250);
                    try {
                        await this.plugin.git.pushRemote(currentBranch);
                        new obsidian_1.Notice("Current branch pushed to origin.");
                        await this.refresh();
                    }
                    catch (error) {
                        push.disabled = false;
                        throw error;
                    }
                };
                if (!this.remote.upstream.startsWith("origin/")) {
                    new FirstPushModal(this.plugin, currentBranch, this.remote.displayUrl, perform).open();
                }
                else {
                    try {
                        await perform();
                    }
                    catch (error) {
                        if (error instanceof RemoteGitAuthenticationError) {
                            this.remoteAuthenticationFailure = error;
                            await this.refresh();
                        }
                        else
                            new obsidian_1.Notice(error instanceof Error ? error.message : "Push failed.", 7000);
                    }
                }
            });
        }
        else {
            const connect = buttonEl(remoteLine, "Set up remote repository", "vvc-link-button");
            connect.addEventListener("click", () => new RemoteRepositoryModal(this.plugin, this.remote).open());
        }
        if (this.remote.configured && this.remoteAuthenticationFailure) {
            const help = htmlEl(this.bodyEl, "div", "vvc-remote-auth-help");
            showGitAuthenticationFailure(help, this.plugin, this.remoteAuthenticationFailure);
        }
        const commitSection = htmlEl(this.bodyEl, "div", "vvc-section vvc-commit-section");
        const commitHeading = htmlEl(commitSection, "div", "vvc-commit-heading");
        const label = htmlEl(commitHeading, "label", "vvc-field-label vvc-panel-title", "Commit message");
        const commitButton = buttonEl(commitHeading, "Commit", "vvc-title-action vvc-commit-action");
        const textarea = htmlEl(commitSection, "textarea", "vvc-commit-input");
        textarea.rows = 2;
        textarea.placeholder = "Describe this version…";
        textarea.value = this.commitDraft;
        textarea.addEventListener("input", () => {
            this.commitDraft = textarea.value;
            // Once the user edits the draft, it becomes an explicit message and must
            // never be replaced by the automatic timestamp at commit time.
            this.commitDraftIsAutomatic = false;
        });
        label.htmlFor = "";
        const hasStaged = status.some((entry) => entry.staged);
        commitButton.disabled = !hasStaged;
        commitButton.addEventListener("click", async () => {
            // The timestamp shown as the default is only a preview. Generate the
            // actual automatic message at the last possible moment so its time
            // reflects the commit being created rather than when the view rendered.
            let message;
            if (this.commitDraftIsAutomatic) {
                message = defaultCommitMessage();
                this.commitDraft = message;
                textarea.value = message;
            }
            else {
                message = textarea.value.trim();
            }
            if (!message) {
                new obsidian_1.Notice("Enter a commit message first.");
                textarea.focus();
                return;
            }
            const finishCommit = async () => {
                await this.plugin.git.commit(message);
                this.commitDraft = defaultCommitMessage();
                this.commitDraftIsAutomatic = true;
                textarea.value = this.commitDraft;
                new obsidian_1.Notice("Commit created.");
                await this.refresh();
            };
            commitButton.disabled = true;
            try {
                await finishCommit();
            }
            catch (error) {
                commitButton.disabled = false;
                const messageText = error instanceof Error ? error.message : String(error);
                if (/user\.email|user\.name|identity|who you are/i.test(messageText)) {
                    new obsidian_1.Notice("Git author identity is not configured. Set it in Vault Version Control settings or Git config.", 7000);
                }
                else {
                    new obsidian_1.Notice(gitFailureNotice(error, "commit"), 7000);
                }
            }
        });
        this.renderChangeSection("Staged changes", status.filter((entry) => entry.staged), true);
        this.renderChangeSection("Changes", status.filter((entry) => entry.changed), false);
        this.renderVaultHistory(status, currentBranch, branches, graph);
    }
    renderChangeSection(title, entries, stagedSection) {
        const settingKey = stagedSection
            ? "stagedChangesCollapsed"
            : "changesCollapsed";
        const section = htmlEl(this.bodyEl, "div", "vvc-change-section");
        const header = htmlEl(section, "div", "vvc-section-header");
        const toggle = buttonEl(header, "", "vvc-section-toggle");
        const chevron = htmlEl(toggle, "span", "vvc-section-chevron");
        const collapsed = this.plugin.settings[settingKey];
        (0, obsidian_1.setIcon)(chevron, collapsed ? "chevron-right" : "chevron-down");
        htmlEl(toggle, "span", "vvc-panel-title", title);
        htmlEl(toggle, "span", "vvc-section-count", String(entries.length));
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${title}`);
        const allButton = buttonEl(header, stagedSection ? "Unstage all" : "Stage all", "vvc-title-action");
        allButton.disabled = entries.length === 0;
        allButton.addEventListener("click", async () => {
            allButton.disabled = true;
            try {
                if (stagedSection) {
                    await this.plugin.git.unstageAll();
                }
                else {
                    const nestedDirty = entries.filter((entry) => entry.isGitLink && entry.gitLinkDirty);
                    await this.plugin.git.stageAll();
                    if (nestedDirty.length) {
                        const noun = nestedDirty.length === 1 ? "repository has" : "repositories have";
                        new obsidian_1.Notice(`Stage all completed. ${nestedDirty.length} nested Git ${noun} uncommitted internal changes that the Vault repository cannot stage. Commit inside ${nestedDirty.length === 1 ? "that repository" : "those repositories"} first, then stage the updated repository reference here.`, 9000);
                    }
                }
                await this.refresh();
            }
            catch (error) {
                allButton.disabled = false;
                new obsidian_1.Notice(gitFailureNotice(error, "stage"), 7000);
            }
        });
        const content = htmlEl(section, "div", "vvc-change-content");
        if (collapsed)
            section.classList.add("is-collapsed");
        toggle.addEventListener("click", async () => {
            const next = !this.plugin.settings[settingKey];
            this.plugin.settings[settingKey] = next;
            section.classList.toggle("is-collapsed", next);
            (0, obsidian_1.setIcon)(chevron, next ? "chevron-right" : "chevron-down");
            toggle.setAttribute("aria-expanded", String(!next));
            toggle.setAttribute("aria-label", `${next ? "Expand" : "Collapse"} ${title}`);
            await this.plugin.saveSettings();
        });
        const list = htmlEl(content, "div", "vvc-file-list");
        if (!entries.length) {
            htmlEl(list, "div", "vvc-empty vvc-empty-compact", stagedSection ? "No staged changes." : "Working tree clean.");
            return;
        }
        for (const entry of entries)
            this.renderFileRow(list, entry, stagedSection);
    }
    renderFileRow(parent, entry, stagedSection) {
        const row = htmlEl(parent, "div", "vvc-file-row");
        row.dataset.path = entry.path;
        const code = stagedSection ? entry.indexCode : (entry.indexCode === "?" ? "?" : entry.workTreeCode);
        const controls = htmlEl(row, "div", "vvc-file-controls");
        const toggle = buttonEl(controls, "", "vvc-icon-button vvc-stage-button");
        (0, obsidian_1.setIcon)(toggle, stagedSection ? "minus" : "plus");
        const stageLabel = stagedSection
            ? `Unstage ${entry.path}`
            : entry.isGitLink && entry.gitLinkDirty && !entry.gitLinkHeadChanged
                ? `Nested Git repository: commit its internal changes first`
                : `Stage ${entry.path}`;
        toggle.setAttribute("aria-label", stageLabel);
        // Staged deletion plus a still-present worktree file means Git stopped
        // tracking that path rather than deleting the user's local copy.
        // Derive this from Git/worktree state so it also survives app restarts.
        const stoppedTracking = stagedSection && code === "D" &&
            fs.existsSync(path.join(this.plugin.git.vaultPath, entry.path));
        const status = htmlEl(controls, "span", "vvc-file-status", stoppedTracking ? "I" : statusLetter(code));
        status.setAttribute("aria-label", stoppedTracking ? "Stopped tracking; local file kept" :
            code === "?" || code === "A" ? "Added" : code === "D" ? "Deleted" :
                code === "R" ? "Renamed" : code === "C" ? "Copied" : code === "U" ? "Unmerged" : "Modified");
        if (stoppedTracking) {
            row.classList.add("vvc-stopped-tracking");
            row.title = "Stopped tracking · local file kept";
        }
        const name = buttonEl(row, entry.path, "vvc-file-name");
        const pathTitle = entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path;
        if (entry.isGitLink) {
            const nestedState = entry.gitLinkDirty
                ? "Nested Git repository — contains uncommitted internal changes"
                : "Nested Git repository";
            name.title = `${pathTitle} · ${nestedState}`;
            row.classList.add("is-gitlink");
        }
        else {
            name.title = pathTitle;
        }
        let hoverTimer = null;
        const cancelOpen = () => {
            if (hoverTimer !== null) {
                window.clearTimeout(hoverTimer);
                hoverTimer = null;
            }
        };
        name.addEventListener("mouseenter", () => {
            cancelOpen();
            this.plugin.fileHistoryPopover.cancelHide();
            hoverTimer = window.setTimeout(() => {
                hoverTimer = null;
                void this.plugin.fileHistoryPopover.showHover(entry.path, name.getBoundingClientRect());
            }, HOVER_OPEN_MS);
        });
        name.addEventListener("mouseleave", () => {
            cancelOpen();
            this.plugin.fileHistoryPopover.scheduleHide();
        });
        row.addEventListener("mouseenter", () => this.plugin.fileHistoryPopover.cancelHide());
        row.addEventListener("mouseleave", () => this.plugin.fileHistoryPopover.scheduleHide());
        name.addEventListener("click", async () => {
            const file = this.plugin.app.vault.getAbstractFileByPath(entry.path);
            if (file instanceof obsidian_1.TFile)
                await this.plugin.app.workspace.getLeaf(false).openFile(file);
        });
        row.addEventListener("contextmenu", (event) => {
            event.preventDefault();
            const menu = new obsidian_1.Menu();
            menu.addItem((item) => {
                item
                    .setTitle("View File History")
                    .setIcon("history")
                    .onClick(() => {
                    void this.plugin.fileHistoryPopover.showPinned(entry.path, { x: event.clientX, y: event.clientY });
                });
            });
            const currentFile = this.plugin.app.vault.getAbstractFileByPath(entry.path);
            if (currentFile instanceof obsidian_1.TFile && isTextFile(currentFile)) {
                menu.addItem((item) => {
                    item
                        .setTitle("Compare with…")
                        .setIcon("diff")
                        .onClick(() => {
                        void this.plugin.compareFileWith(currentFile);
                    });
                });
            }
            menu.showAtMouseEvent(event);
        });
        toggle.addEventListener("click", async () => {
            toggle.disabled = true;
            try {
                if (stagedSection) {
                    await this.plugin.git.unstageFile(entry.path);
                }
                else if (entry.isGitLink && entry.gitLinkDirty && !entry.gitLinkHeadChanged) {
                    new obsidian_1.Notice(`${entry.path} is a nested Git repository with uncommitted internal changes. The Vault repository cannot stage those files directly. Commit them inside the nested repository first; then its updated commit reference can be staged here.`, 9000);
                }
                else {
                    await this.plugin.git.stageFile(entry.path);
                    if (entry.isGitLink && entry.gitLinkDirty) {
                        new obsidian_1.Notice(`Staged the current commit reference for ${entry.path}. Uncommitted changes inside that nested repository are not included.`, 7000);
                    }
                }
                await this.refresh();
            }
            catch (error) {
                toggle.disabled = false;
                new obsidian_1.Notice(gitFailureNotice(error, "stage"), 7000);
            }
        });
    }
    renderVaultHistory(status, currentBranch, branches, graph) {
        const section = htmlEl(this.bodyEl, "div", "vvc-history-section");
        const header = htmlEl(section, "div", "vvc-history-header vvc-history-toggle-header");
        const toggle = buttonEl(header, "", "vvc-history-toggle");
        const chevron = htmlEl(toggle, "span", "vvc-history-chevron");
        (0, obsidian_1.setIcon)(chevron, this.plugin.settings.vaultHistoryCollapsed ? "chevron-right" : "chevron-down");
        htmlEl(toggle, "span", "vvc-history-title", "Vault History");
        toggle.setAttribute("aria-expanded", String(!this.plugin.settings.vaultHistoryCollapsed));
        toggle.setAttribute("aria-label", this.plugin.settings.vaultHistoryCollapsed ? "Expand Vault History" : "Collapse Vault History");
        toggle.addEventListener("click", async () => {
            this.plugin.settings.vaultHistoryCollapsed = !this.plugin.settings.vaultHistoryCollapsed;
            await this.plugin.saveSettings();
            this.renderRepository(status, currentBranch, branches, graph);
        });
        if (this.plugin.settings.vaultHistoryCollapsed)
            return;
        const switchRow = htmlEl(section, "div", "vvc-switch-row");
        const select = htmlEl(switchRow, "select", "vvc-branch-select");
        for (const branch of branches) {
            const option = document.createElement("option");
            option.value = branch.name;
            option.textContent = branch.name;
            option.selected = branch.name === currentBranch;
            select.appendChild(option);
        }
        if (!branches.length && currentBranch && currentBranch !== "(detached)") {
            const option = document.createElement("option");
            option.value = currentBranch;
            option.textContent = currentBranch;
            option.selected = true;
            select.appendChild(option);
        }
        const switchButton = buttonEl(switchRow, "Switch", "vvc-button");
        switchButton.disabled = select.options.length === 0 || select.value === currentBranch;
        select.addEventListener("change", () => {
            switchButton.disabled = !select.value || select.value === currentBranch;
        });
        switchButton.addEventListener("click", async () => {
            const branch = select.value;
            if (!branch || branch === currentBranch)
                return;
            switchButton.disabled = true;
            try {
                if (!(await this.plugin.git.isClean())) {
                    switchButton.disabled = false;
                    new obsidian_1.Notice(gitFailureNotice(new Error("Working tree not clean"), "branch"), 7000);
                    return;
                }
                await this.plugin.git.switchBranch(branch);
                new obsidian_1.Notice(`Switched to branch: ${branch}`);
                await this.refresh();
            }
            catch (error) {
                switchButton.disabled = false;
                new obsidian_1.Notice(gitFailureNotice(error, "branch"), 7000);
            }
        });
        const graphEl = htmlEl(section, "div", "vvc-graph");
        if (!graph.length) {
            htmlEl(graphEl, "div", "vvc-empty", "No committed Vault history yet.");
            return;
        }
        const branchesAtHash = new Map();
        const localBranchNames = new Set(branches.map((branch) => branch.name));
        for (const branch of branches) {
            if (!branch.hash)
                continue;
            const list = branchesAtHash.get(branch.hash) ?? [];
            list.push(branch);
            branchesAtHash.set(branch.hash, list);
        }
        const originsAtHash = new Map();
        for (const origin of this.branchOrigins) {
            const list = originsAtHash.get(origin.hash) ?? [];
            if (!list.includes(origin.branch))
                list.push(origin.branch);
            originsAtHash.set(origin.hash, list);
        }
        for (const laneRow of computeGraphLaneRows(graph, branches, this.historyFocusBranch || currentBranch, this.branchOrigins)) {
            const entry = laneRow.entry;
            const row = htmlEl(graphEl, "div", "vvc-graph-row");
            this.renderGraphLanes(row, laneRow);
            const details = htmlEl(row, "div", "vvc-graph-details");
            const top = htmlEl(details, "div", "vvc-graph-top");
            htmlEl(top, "div", "vvc-history-subject", entry.subject || "(no commit message)");
            const actions = htmlEl(top, "div", "vvc-graph-row-actions");
            const viewMessage = buttonEl(actions, "", "vvc-icon-button vvc-start-button vvc-view-commit-button");
            (0, obsidian_1.setIcon)(viewMessage, "message-square-text");
            viewMessage.title = "View full message";
            viewMessage.addEventListener("click", (event) => {
                event.stopPropagation();
                new ViewCommitMessageModal(this.plugin, entry).open();
            });
            const currentTip = branches.some((branch) => branch.current && branch.hash === entry.hash);
            if (currentTip) {
                const edit = buttonEl(actions, "Edit message", "vvc-link-button vvc-start-button");
                edit.setAttribute("aria-label", `Edit message for latest commit ${entry.shortHash}`);
                edit.addEventListener("click", () => new EditCommitMessageModal(this.plugin, entry).open());
            }
            const start = buttonEl(actions, "Start Here", "vvc-link-button vvc-start-button");
            start.addEventListener("click", async () => {
                if (!(await this.plugin.git.isClean())) {
                    new obsidian_1.Notice("Commit the current changes before starting from a historical version.", 6000);
                    return;
                }
                new StartFromVersionModal(this.plugin, entry).open();
            });
            const originBranches = originsAtHash.get(entry.hash) ?? [];
            if (originBranches.length) {
                htmlEl(details, "div", "vvc-branch-origin-hint", `branched to ${originBranches.join(", ")}`);
            }
            const tipBranches = branchesAtHash.get(entry.hash) ?? [];
            const extraDecorations = entry.decorations
                .split(/,\s*/)
                .filter(Boolean)
                .map((raw) => raw.replace(/^HEAD\s*->\s*/, "").trim())
                .filter((label) => label && label !== "HEAD" && !localBranchNames.has(label));
            const isRoot = !entry.parents.trim();
            if (tipBranches.length || extraDecorations.length || isRoot) {
                const decorations = htmlEl(details, "div", "vvc-history-decorations");
                for (const branch of tipBranches) {
                    const chip = buttonEl(decorations, branch.name, "vvc-history-decoration vvc-branch-focus-chip");
                    if (branch.current)
                        chip.classList.add("is-current");
                    const isFocused = branch.name === this.historyFocusBranch;
                    if (isFocused)
                        chip.classList.add("is-focus");
                    chip.setAttribute("aria-pressed", String(isFocused));
                    chip.setAttribute("aria-label", isFocused
                        ? branch.current
                            ? `${branch.name} is the current Git branch and the focused history branch`
                            : `${branch.name} is the focused history branch`
                        : branch.current
                            ? `${branch.name} is the current Git branch; focus Vault History on it`
                            : `Focus Vault History on ${branch.name}`);
                    chip.title = isFocused
                        ? branch.current
                            ? `${branch.name} · Current branch · Focused in Vault History`
                            : `${branch.name} · Focused in Vault History`
                        : branch.current
                            ? `${branch.name} · Current branch`
                            : `Focus Vault History on ${branch.name}`;
                    chip.addEventListener("click", (event) => {
                        event.stopPropagation();
                        if (branch.name === this.historyFocusBranch)
                            return;
                        const scrollTop = this.bodyEl.scrollTop;
                        const scrollLeft = this.bodyEl.scrollLeft;
                        this.historyFocusBranch = branch.name;
                        this.renderRepository(status, currentBranch, branches, graph);
                        this.bodyEl.scrollTop = scrollTop;
                        this.bodyEl.scrollLeft = scrollLeft;
                    });
                }
                for (const label of extraDecorations) {
                    htmlEl(decorations, "span", "vvc-history-decoration", label);
                }
                if (isRoot) {
                    htmlEl(decorations, "span", "vvc-history-decoration is-root", "Root");
                }
            }
            const meta = [entry.shortHash, entry.timestamp ? formatDate(entry.timestamp) : ""];
            htmlEl(details, "div", "vvc-history-meta", meta.filter(Boolean).join(" · "));
        }
    }
    renderGraphLanes(parent, laneRow) {
        const laneCount = Math.min(MAX_VISIBLE_GRAPH_LANES, Math.max(1, laneRow.beforeCount, laneRow.afterCount, laneRow.nodeLane + 1));
        const laneSpacing = 16;
        const laneInset = 9;
        const nodeCenterY = 15;
        const laneWidth = Math.max(34, laneInset * 2 + (laneCount - 1) * laneSpacing + 2);
        const lanesEl = htmlEl(parent, "div", "vvc-graph-lanes");
        lanesEl.style.width = `${laneWidth}px`;
        const laneX = (lane) => laneInset + lane * laneSpacing;
        const addVertical = (lane, top, bottom, extraClass = "") => {
            const segment = htmlEl(lanesEl, "span", `vvc-lane-line vvc-lane-vertical ${extraClass}`.trim());
            segment.style.left = `${laneX(lane)}px`;
            segment.style.top = top;
            segment.style.bottom = bottom;
        };
        const addHorizontal = (fromLane, toLane, top, extraClass = "") => {
            if (fromLane === toLane)
                return;
            const left = Math.min(laneX(fromLane), laneX(toLane));
            const right = Math.max(laneX(fromLane), laneX(toLane));
            const segment = htmlEl(lanesEl, "span", `vvc-lane-line vvc-lane-horizontal ${extraClass}`.trim());
            segment.style.left = `${left}px`;
            segment.style.width = `${right - left}px`;
            segment.style.top = top;
        };
        // Paths unrelated to this commit pass through the row. When lane pressure
        // shifts a path sideways, keep the connection explicit rather than making
        // it appear to jump between columns.
        for (const continuation of laneRow.continuations) {
            if (continuation.fromLane === continuation.toLane) {
                addVertical(continuation.fromLane, "0", "0");
            }
            else {
                addVertical(continuation.fromLane, "0", "50%");
                addHorizontal(continuation.fromLane, continuation.toLane, "50%");
                addVertical(continuation.toLane, "50%", "0");
            }
        }
        // Every child edge that targets this commit converges on the commit node.
        // This is what makes a branch visibly fork from the actual base commit.
        if (!laneRow.startsHere) {
            for (const incomingLane of laneRow.incomingLanes) {
                addVertical(incomingLane, "0", `calc(100% - ${nodeCenterY}px)`, "vvc-lane-incoming");
                const above = lanesEl.lastElementChild;
                if (above) {
                    above.style.bottom = "auto";
                    above.style.height = `${nodeCenterY}px`;
                }
                addHorizontal(incomingLane, laneRow.nodeLane, `${nodeCenterY}px`, "vvc-lane-incoming");
            }
        }
        // Parent edges leave the commit toward older history. Merge commits can
        // therefore fan out into multiple lanes below the node.
        for (const parentLane of laneRow.parentLanes) {
            addHorizontal(laneRow.nodeLane, parentLane, `${nodeCenterY}px`, "vvc-lane-parent");
            addVertical(parentLane, `${nodeCenterY}px`, "0", "vvc-lane-parent");
        }
        for (const lane of [SOURCE_GRAPH_LANE, OTHER_GRAPH_LANE]) {
            const count = laneRow.aggregatePathCounts[lane] || 0;
            if (count <= 1)
                continue;
            const aggregate = htmlEl(lanesEl, "span", "vvc-lane-aggregate", "⋯");
            aggregate.style.left = `${laneX(lane)}px`;
            aggregate.title = lane === SOURCE_GRAPH_LANE
                ? `${count} source / ancestor paths are aggregated in this lane`
                : `${count} other branch paths are aggregated in this lane`;
        }
        const node = htmlEl(lanesEl, "span", "vvc-lane-node");
        node.style.left = `${laneX(laneRow.nodeLane)}px`;
        node.style.top = `${nodeCenterY}px`;
        node.title = laneRow.entry.shortHash;
        if (/\bHEAD\s*->/.test(laneRow.entry.decorations))
            node.classList.add("is-current");
        if (laneRow.isFocusTip)
            node.classList.add("is-focus");
        if (laneRow.entry.decorations)
            node.classList.add("is-ref-tip");
        if (!laneRow.entry.parents.trim())
            node.classList.add("is-root");
    }
}
class VaultVersionControlSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const container = this.containerEl;
        container.replaceChildren();
        const heading = htmlEl(container, "h2", "vvc-settings-heading", "Vault Version Control");
        htmlEl(heading, "span", "vvc-settings-version", `v${this.plugin.manifest.version}`);
        new obsidian_1.Setting(container)
            .setName("Git executable")
            .setDesc("Auto detect is recommended. Use Custom only when you need a specific Git installation.")
            .addDropdown((dropdown) => {
            dropdown
                .addOption("auto", "Auto detect (recommended)")
                .addOption("custom", "Custom")
                .setValue(this.plugin.settings.gitMode)
                .onChange(async (value) => {
                this.plugin.settings.gitMode = value;
                this.plugin.git.invalidateDetection();
                await this.plugin.saveSettings();
                await this.plugin.refreshVersionControlNow();
                this.display();
            });
        });
        if (this.plugin.settings.gitMode === "custom") {
            new obsidian_1.Setting(container)
                .setName("Custom Git executable")
                .setDesc("Executable name or full path, for example /opt/homebrew/bin/git.")
                .addText((text) => {
                text
                    .setPlaceholder("/path/to/git")
                    .setValue(this.plugin.settings.gitExecutable)
                    .onChange(async (value) => {
                    this.plugin.settings.gitExecutable = value.trim();
                    this.plugin.git.invalidateDetection();
                    await this.plugin.saveSettings();
                });
            })
                .addButton((button) => {
                button.setButtonText("Test").onClick(async () => {
                    button.setDisabled(true);
                    try {
                        this.plugin.git.invalidateDetection();
                        const environment = await this.plugin.git.detectGit(true);
                        if (environment.available) {
                            new obsidian_1.Notice(`Git is available: ${environment.resolvedPath || environment.executable}`);
                        }
                        else {
                            new obsidian_1.Notice(environment.message || "Custom Git is unavailable.", 7000);
                        }
                        this.display();
                        await this.plugin.refreshVersionControlNow();
                    }
                    finally {
                        button.setDisabled(false);
                    }
                });
            });
        }
        const environmentPanel = htmlEl(container, "div", "vvc-settings-status");
        htmlEl(environmentPanel, "div", "vvc-settings-status-title", "Git environment");
        const environmentText = htmlEl(environmentPanel, "div", "vvc-settings-status-copy", "Checking…");
        const environmentActions = htmlEl(environmentPanel, "div", "vvc-settings-actions");
        const checkButton = buttonEl(environmentActions, "Check again", "vvc-button");
        const updateEnvironment = async (force = false) => {
            checkButton.disabled = true;
            try {
                const environment = await this.plugin.git.detectGit(force);
                if (environment.available) {
                    const modeLabel = environment.mode === "auto" ? "Auto detected" : "Custom";
                    environmentText.textContent = `${modeLabel}: ${environment.resolvedPath || environment.executable} · ${environment.version}`;
                }
                else if (environment.kind === "xcode_license") {
                    environmentText.textContent = "Apple Git was found, but the Xcode license has not been accepted.";
                }
                else if (environment.kind === "command_line_tools") {
                    environmentText.textContent = "Apple Git requires the macOS Command Line Tools.";
                }
                else {
                    environmentText.textContent = environment.message || "No usable Git installation was found.";
                }
            }
            catch (error) {
                environmentText.textContent = error instanceof Error ? error.message : String(error);
            }
            finally {
                checkButton.disabled = false;
            }
        };
        checkButton.addEventListener("click", async () => {
            this.plugin.git.invalidateDetection();
            await updateEnvironment(true);
            await this.plugin.refreshVersionControlNow();
        });
        void updateEnvironment(false);
        const identitySection = htmlEl(container, "section", "vvc-settings-section vvc-identity-section");
        htmlEl(identitySection, "div", "vvc-settings-section-title", "Commit identity");
        htmlEl(identitySection, "div", "vvc-settings-section-copy", "Identity used when creating commits in this Vault.");
        const identityOptions = htmlEl(identitySection, "div", "vvc-identity-options");
        const gitOption = htmlEl(identityOptions, "label", "vvc-identity-option");
        const gitRadio = htmlEl(gitOption, "input", "vvc-identity-radio");
        gitRadio.type = "radio";
        gitRadio.name = "vvc-identity-mode";
        gitRadio.value = "git";
        gitRadio.checked = this.plugin.settings.identityMode === "git";
        const gitOptionBody = htmlEl(gitOption, "div", "vvc-identity-option-body");
        htmlEl(gitOptionBody, "div", "vvc-identity-option-title", "Use Git configuration (recommended)");
        htmlEl(gitOptionBody, "div", "vvc-identity-option-copy", "Use the author identity currently resolved by Git for this Vault.");
        const resolvedIdentity = htmlEl(gitOptionBody, "div", "vvc-identity-resolved", "Checking current identity…");
        const vaultOption = htmlEl(identityOptions, "label", "vvc-identity-option");
        const vaultRadio = htmlEl(vaultOption, "input", "vvc-identity-radio");
        vaultRadio.type = "radio";
        vaultRadio.name = "vvc-identity-mode";
        vaultRadio.value = "vault";
        vaultRadio.checked = this.plugin.settings.identityMode === "vault";
        const vaultOptionBody = htmlEl(vaultOption, "div", "vvc-identity-option-body");
        htmlEl(vaultOptionBody, "div", "vvc-identity-option-title", "Override for this Vault");
        htmlEl(vaultOptionBody, "div", "vvc-identity-option-copy", "Use a Vault-specific author name and email managed by Vault Version Control.");
        const overrideFields = htmlEl(identityOptions, "div", "vvc-identity-fields");
        overrideFields.hidden = this.plugin.settings.identityMode !== "vault";
        new obsidian_1.Setting(overrideFields)
            .setName("Name")
            .addText((text) => {
            text
                .setPlaceholder("Your name")
                .setValue(this.plugin.settings.authorName)
                .onChange(async (value) => {
                this.plugin.settings.authorName = value;
                await this.plugin.saveSettings();
            });
        });
        new obsidian_1.Setting(overrideFields)
            .setName("Email")
            .addText((text) => {
            text
                .setPlaceholder("you@example.com")
                .setValue(this.plugin.settings.authorEmail)
                .onChange(async (value) => {
                this.plugin.settings.authorEmail = value;
                await this.plugin.saveSettings();
            });
        });
        const updateOptionState = () => {
            gitOption.classList.toggle("is-selected", this.plugin.settings.identityMode === "git");
            vaultOption.classList.toggle("is-selected", this.plugin.settings.identityMode === "vault");
            overrideFields.hidden = this.plugin.settings.identityMode !== "vault";
        };
        updateOptionState();
        const readResolvedIdentity = async () => {
            try {
                const environment = await this.plugin.git.detectGit();
                if (!environment.available) {
                    resolvedIdentity.textContent = "Git is unavailable; the current identity cannot be checked yet.";
                    return { name: "", email: "" };
                }
                if (!this.plugin.git.hasLocalRepository()) {
                    resolvedIdentity.textContent = "No Git repository is initialized in this Vault.";
                    return { name: "", email: "" };
                }
                await this.plugin.git.applyConfiguredIdentity();
                const identity = await this.plugin.git.getIdentity();
                if (!identity.name && !identity.email) {
                    resolvedIdentity.textContent = "No author identity is currently configured.";
                }
                else {
                    resolvedIdentity.textContent = `${identity.name || "(no name)"} <${identity.email || "no email"}>`;
                }
                return identity;
            }
            catch (error) {
                resolvedIdentity.textContent = error instanceof Error ? error.message : String(error);
                return { name: "", email: "" };
            }
        };
        let currentIdentityPromise = readResolvedIdentity();
        gitRadio.addEventListener("change", async () => {
            if (!gitRadio.checked)
                return;
            this.plugin.settings.identityMode = "git";
            await this.plugin.saveSettings();
            updateOptionState();
            currentIdentityPromise = readResolvedIdentity();
        });
        vaultRadio.addEventListener("change", async () => {
            if (!vaultRadio.checked)
                return;
            if (!this.plugin.settings.authorName.trim() && !this.plugin.settings.authorEmail.trim()) {
                const identity = await currentIdentityPromise;
                this.plugin.settings.authorName = identity.name;
                this.plugin.settings.authorEmail = identity.email;
            }
            this.plugin.settings.identityMode = "vault";
            await this.plugin.saveSettings();
            this.display();
        });
        const funding = fundingLinkFromManifest(this.plugin.manifest.fundingUrl);
        if (funding) {
            const supportSection = htmlEl(container, "section", "vvc-settings-section vvc-support-section");
            htmlEl(supportSection, "div", "vvc-settings-section-title", "Support Development");
            htmlEl(supportSection, "div", "vvc-settings-section-copy", "Vault Version Control is free to use. If you find it useful, you can support its continued development.");
            new obsidian_1.Setting(supportSection)
                .setName(funding.label)
                .setDesc("Optional support. Opens in your system's default browser.")
                .addButton((button) => {
                button.setButtonText("Open in browser").onClick(async () => {
                    try {
                        await this.plugin.openFundingPage(funding.url);
                    }
                    catch (error) {
                        new obsidian_1.Notice(error instanceof Error ? error.message : "Unable to open funding page.", 7000);
                    }
                });
            });
        }
    }
}
class VaultVersionControlPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.settings = DEFAULT_SETTINGS;
        this.refreshTimer = null;
        this.repositoryInitializationPromise = null;
        this.lastContextMenuPoint = { x: 24, y: 24 };
        this.lastMarkdownTypography = null;
        this.typographyRefreshRaf = null;
        this.historyPreviewPaths = new Set();
        this.historyPreviewInfo = new Map();
        this.historyPreviewMaintenanceTimer = null;
        this.ignoreConfirmationThreshold = 100;
    }
    isHistoryPreviewFilePath(filePath) {
        return this.historyPreviewPaths.has(filePath);
    }
    needsIgnoreConfirmation(items) {
        return items.reduce((count, entry) => count + entry.trackedFiles, 0) >= this.ignoreConfirmationThreshold;
    }
    showIgnoreResult(result) {
        if (!result.changed)
            return;
        const label = `Ignored ${result.changed} ${result.changed === 1 ? "item" : "items"} · Local files kept`;
        const detail = result.trackedFiles > 0
            ? `${result.trackedFiles} ${result.trackedFiles === 1 ? "file" : "files"} stopped tracking. Local files kept.`
            : "Local files kept.";
        const content = document.createDocumentFragment();
        const row = htmlEl(content, "div", "vvc-ignore-notice");
        const message = htmlEl(row, "span", "vvc-ignore-notice-message", label);
        message.title = detail;
        let undo = null;
        if (result.undoId !== undefined) {
            undo = buttonEl(row, "Undo", "vvc-ignore-notice-undo");
            undo.title = "Undo this Ignore from Git action";
            undo.setAttribute("aria-label", "Undo last Ignore from Git action");
        }
        // Notice officially accepts a DocumentFragment; do not append a native
        // button to its internal container (which uses the host's button styling).
        const notice = new obsidian_1.Notice(content, 8500);
        if (undo) {
            undo.addEventListener("click", async (event) => {
                event.stopPropagation();
                if (undo.disabled)
                    return;
                undo.disabled = true;
                try {
                    await this.git.undoLastIgnore(result.undoId);
                }
                catch (error) {
                    undo.disabled = false;
                    new obsidian_1.Notice(error instanceof Error ? error.message : "Unable to undo Ignore safely.", 8000);
                    return;
                }
                notice.hide();
                new obsidian_1.Notice("Ignore undone. Local files kept.");
                try {
                    await this.refreshVersionControlNow();
                }
                catch {
                    // A refresh error must not be mistaken for an Undo failure.
                    new obsidian_1.Notice("Ignore was undone, but the Git status view could not refresh.", 8000);
                }
            });
        }
    }
    async ignoreSinglePathFromGit(filePath) {
        try {
            const [file] = await this.git.inspectIgnoreFiles([filePath]);
            if (this.needsIgnoreConfirmation([file])) {
                new ConfirmExcludeFilesModal(this, [file], false).open();
                return;
            }
            const result = await this.git.ignoreFiles([filePath]);
            this.showIgnoreResult(result);
            await this.refreshVersionControlNow();
        }
        catch (error) {
            new obsidian_1.Notice(error instanceof Error ? error.message : "Unable to ignore path.", 7000);
        }
    }
    async onload() {
        await this.loadSettings();
        this.git = new GitService(this);
        this.fileHistoryPopover = new FileHistoryPopover(this);
        this.registerEditorExtension(historyPreviewReadOnlyExtension);
        this.registerView(VIEW_TYPE, (leaf) => new VersionControlView(leaf, this));
        this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));
        this.addSettingTab(new VaultVersionControlSettingTab(this.app, this));
        this.addRibbonIcon("git-branch", "Open Version Control", async () => {
            await this.activateVersionControlView();
        });
        this.addCommand({
            id: "open-version-control",
            name: "Open Version Control",
            callback: async () => {
                await this.activateVersionControlView();
            },
        });
        this.addCommand({
            id: "refresh-git-status",
            name: "Refresh Git Status",
            callback: async () => {
                await this.refreshVersionControlNow(true);
            },
        });
        this.registerDomEvent(document, "contextmenu", (event) => {
            this.lastContextMenuPoint = { x: event.clientX, y: event.clientY };
        }, true);
        // Obsidian's native Markdown view header normally allows the filename to be
        // renamed in place. Historical previews are snapshots, so keep that title
        // selectable only as display metadata and never let the native rename UI
        // activate. These capture-phase guards are scoped by the preview marker and
        // stop applying immediately when the leaf is reused for a normal note.
        const blockHistoryPreviewTitlePointer = (event) => {
            if (!isHistoryPreviewHeaderTitleTarget(event.target))
                return;
            event.preventDefault();
            event.stopPropagation();
        };
        for (const type of ["pointerdown", "mousedown", "click", "dblclick"]) {
            this.registerDomEvent(document, type, blockHistoryPreviewTitlePointer, true);
        }
        const blockHistoryPreviewTitleEdit = (event) => {
            if (!isHistoryPreviewHeaderTitleTarget(event.target))
                return;
            event.preventDefault();
            event.stopPropagation();
        };
        for (const type of ["beforeinput", "paste", "cut", "drop"]) {
            this.registerDomEvent(document, type, blockHistoryPreviewTitleEdit, true);
        }
        this.registerDomEvent(document, "keydown", (event) => {
            if (!isHistoryPreviewHeaderTitleTarget(event.target))
                return;
            if (!["Enter", "F2", "Backspace", "Delete"].includes(event.key))
                return;
            event.preventDefault();
            event.stopPropagation();
        }, true);
        this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
            const isFolder = file instanceof obsidian_1.TFolder;
            if (!(file instanceof obsidian_1.TFile) && !isFolder)
                return;
            if (isFolder) {
                if (file.path && file.path !== "/" && this.git.hasLocalRepository()) {
                    menu.addItem((item) => {
                        item.setTitle("Ignore from Git").setIcon("folder-minus").onClick(() => {
                            void this.ignoreSinglePathFromGit(file.path);
                        });
                    });
                }
                return;
            }
            if (this.historyPreviewPaths.has(file.path)) {
                const info = this.historyPreviewInfo.get(file.path);
                if (info) {
                    menu.addItem((item) => {
                        item
                            .setTitle("Save a copy as...")
                            .setIcon("copy")
                            .onClick(() => {
                            void this.saveHistoricalCopyAs(file.path, info.filePath, info.entry);
                        });
                    });
                }
                return;
            }
            menu.addItem((item) => {
                item
                    .setTitle("View File History")
                    .setIcon("history")
                    .onClick(() => {
                    void this.fileHistoryPopover.showPinned(file.path, this.lastContextMenuPoint);
                });
            });
            if (isTextFile(file)) {
                menu.addItem((item) => {
                    item
                        .setTitle("Compare with…")
                        .setIcon("diff")
                        .onClick(() => {
                        void this.compareFileWith(file);
                    });
                });
            }
            if (this.git.hasLocalRepository() && file.path !== ".gitignore") {
                menu.addItem((item) => {
                    item.setTitle("Ignore from Git").setIcon("file-minus").onClick(() => {
                        void this.ignoreSinglePathFromGit(file.path);
                    });
                });
            }
        }));
        this.app.workspace.onLayoutReady(() => {
            const refresh = () => this.requestRefresh();
            void this.removeStaleHistoryPreviewFiles();
            this.registerEvent(this.app.vault.on("create", refresh));
            this.registerEvent(this.app.vault.on("modify", refresh));
            this.registerEvent(this.app.vault.on("delete", refresh));
            this.registerEvent(this.app.vault.on("rename", refresh));
            this.registerEvent(this.app.workspace.on("editor-change", () => this.requestRefresh(EDITOR_STATUS_DEBOUNCE_MS)));
            // Opening another file in the same Markdown leaf does not necessarily fire
            // active-leaf-change or layout-change. Clean preview-only markers
            // immediately so the reused editor returns to Obsidian's normal Live
            // Preview/source behavior instead of retaining the historical read-only
            // CodeMirror facets.
            this.registerEvent(this.app.workspace.on("file-open", () => {
                this.scheduleHistoryPreviewMaintenance(0);
                window.requestAnimationFrame(() => this.scheduleHistoryPreviewMaintenance(0));
            }));
            this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
                this.scheduleDiffTypographyRefresh();
                this.scheduleHistoryPreviewMaintenance();
            }));
            this.registerEvent(this.app.workspace.on("layout-change", () => {
                this.scheduleDiffTypographyRefresh();
                this.scheduleHistoryPreviewMaintenance();
            }));
            this.registerEvent(this.app.workspace.on("css-change", () => {
                this.lastMarkdownTypography = null;
                this.scheduleDiffTypographyRefresh();
            }));
            this.registerDomEvent(window, "focus", () => this.requestRefresh(120));
        });
    }
    onunload() {
        this.git?.cancelNetwork();
        if (this.refreshTimer !== null)
            window.clearTimeout(this.refreshTimer);
        if (this.typographyRefreshRaf !== null)
            window.cancelAnimationFrame(this.typographyRefreshRaf);
        if (this.historyPreviewMaintenanceTimer !== null)
            window.clearTimeout(this.historyPreviewMaintenanceTimer);
        this.closeHistoryPreviewLeaves();
        void this.removeAllHistoryPreviewFiles();
        this.fileHistoryPopover?.destroy();
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(DIFF_VIEW_TYPE);
    }
    captureTypographyFromElement(element) {
        const style = window.getComputedStyle(element);
        const size = (style.fontSize || "").trim();
        const family = (style.fontFamily || "").trim();
        if (!size || !family)
            return null;
        const parsedSize = Number.parseFloat(size);
        if (!Number.isFinite(parsedSize) || parsedSize <= 0)
            return null;
        return {
            fontFamily: family,
            fontSize: size,
            fontWeight: (style.fontWeight || "400").trim() || "400",
            lineHeight: (style.lineHeight || "normal").trim() || "normal",
            letterSpacing: (style.letterSpacing || "normal").trim() || "normal",
        };
    }
    findMarkdownTypographyTarget() {
        const activeLeaf = document.querySelector(".workspace-leaf.mod-active");
        const roots = [];
        if (activeLeaf)
            roots.push(activeLeaf);
        for (const root of Array.from(document.querySelectorAll(".workspace-leaf"))) {
            if (root !== activeLeaf)
                roots.push(root);
        }
        for (const root of roots) {
            if (root.querySelector(".vvc-diff-view"))
                continue;
            const source = root.querySelector(".markdown-source-view");
            if (source) {
                const target = source.querySelector(".cm-content") || source.querySelector(".cm-scroller") || source;
                if (target)
                    return target;
            }
            const preview = root.querySelector(".markdown-preview-view");
            if (preview) {
                const target = preview.querySelector("p, li") || preview;
                if (target)
                    return target;
            }
        }
        return null;
    }
    probeMarkdownTypography(host) {
        // Match editor-scoped Theme selectors without opening a file or workspace leaf.
        const probe = document.createElement("div");
        probe.className = "workspace-leaf-content";
        probe.setAttribute("data-type", "markdown");
        probe.style.cssText = "position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
        const source = document.createElement("div");
        source.className = "view-content markdown-source-view mod-cm6 is-live-preview";
        const editor = document.createElement("div");
        editor.className = "cm-editor cm-s-obsidian";
        const scroller = document.createElement("div");
        scroller.className = "cm-scroller";
        const content = document.createElement("div");
        content.className = "cm-content";
        scroller.appendChild(content);
        editor.appendChild(scroller);
        source.appendChild(editor);
        probe.appendChild(source);
        host.appendChild(probe);
        try {
            return this.captureTypographyFromElement(content);
        }
        finally {
            probe.remove();
        }
    }
    resolveMarkdownTypography(probeHost) {
        const target = this.findMarkdownTypographyTarget();
        if (target) {
            const captured = this.captureTypographyFromElement(target);
            if (captured) {
                this.lastMarkdownTypography = captured;
                return captured;
            }
        }
        if (this.lastMarkdownTypography)
            return this.lastMarkdownTypography;
        // No editor: sample its CSS in the Diff leaf, or defer to live CSS variables.
        return probeHost ? this.probeMarkdownTypography(probeHost) : null;
    }
    scheduleDiffTypographyRefresh() {
        if (this.typographyRefreshRaf !== null)
            return;
        this.typographyRefreshRaf = window.requestAnimationFrame(() => {
            this.typographyRefreshRaf = null;
            for (const leaf of this.app.workspace.getLeavesOfType(DIFF_VIEW_TYPE)) {
                const view = leaf.view;
                if (view instanceof DiffView)
                    view.refreshTypography();
            }
        });
    }
    async loadSettings() {
        const loaded = (await this.loadData()) || {};
        // 0.1.12 briefly stored a Diff-only font size. 0.1.13 intentionally removes
        // independent Diff font scaling so Diff always follows Markdown typography.
        delete loaded.diffFontSize;
        let gitMode = loaded.gitMode === "custom" ? "custom" : "auto";
        let gitExecutable = typeof loaded.gitExecutable === "string" ? loaded.gitExecutable : "";
        // Migrate 0.1.3 and earlier: a non-default path meant the user had explicitly chosen Git.
        if (!loaded.gitMode) {
            const legacy = gitExecutable.trim();
            if (legacy && legacy !== "git")
                gitMode = "custom";
            else {
                gitMode = "auto";
                gitExecutable = "";
            }
        }
        const identityMode = loaded.identityMode === "vault" || loaded.identityMode === "git"
            ? loaded.identityMode
            : ((typeof loaded.authorName === "string" && loaded.authorName.trim()) || (typeof loaded.authorEmail === "string" && loaded.authorEmail.trim())
                ? "vault"
                : "git");
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, { gitMode, gitExecutable, identityMode });
    }
    async rememberDetectedGitPath(resolvedPath) {
        if (this.settings.gitMode !== "auto")
            return;
        const value = (resolvedPath || "").trim();
        if (!value || this.settings.lastDetectedGitPath === value)
            return;
        this.settings.lastDetectedGitPath = value;
        await this.saveData(this.settings);
    }
    async saveSettings() {
        await this.saveData(this.settings);
        if (this.git?.hasLocalRepository()) {
            try {
                await this.git.applyConfiguredIdentity();
            }
            catch {
                // The settings page reports Git errors separately; avoid noisy notices while typing.
            }
        }
    }
    async createInitialCommit(onProgress) {
        if (!this.git.hasLocalRepository())
            throw new Error("Initialize the Git repository first.");
        if (await this.git.hasHead())
            return true;
        // Stage the Vault snapshot first so the initial commit is a useful baseline.
        // Re-initializing after .git was removed can mean staging the entire Vault again,
        // so surface progress instead of leaving the disabled button looking inert.
        onProgress?.("Staging initial snapshot…");
        await this.git.stageAll();
        const identity = await this.git.getIdentity();
        if (identity.name && identity.email) {
            onProgress?.("Creating initial commit…");
            await this.git.commit(initialCommitMessage());
            return true;
        }
        new InitialCommitIdentityModal(this, identity.name || (this.settings.identityMode === "vault" ? this.settings.authorName : ""), identity.email || (this.settings.identityMode === "vault" ? this.settings.authorEmail : ""), async () => {
            // Re-stage in case files changed while the identity prompt was open.
            await this.git.stageAll();
            await this.git.commit(initialCommitMessage());
            new obsidian_1.Notice("Initial commit created.");
            await this.refreshVersionControlNow();
        }).open();
        return false;
    }
    async initializeRepository(onProgress) {
        if (this.git.isRemoteImportInProgress())
            throw new Error("Remote initialization is in progress.");
        // Prevent a delayed focus/vault refresh or a second click from racing the
        // repository creation sequence. This matters especially after .git is deleted
        // externally and Obsidian schedules a refresh when focus returns from Finder.
        if (this.repositoryInitializationPromise)
            return await this.repositoryInitializationPromise;
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        const operation = (async () => {
            onProgress?.("Initializing repository…");
            await this.git.initRepository();
            return await this.createInitialCommit(onProgress);
        })();
        this.repositoryInitializationPromise = operation;
        try {
            return await operation;
        }
        finally {
            this.repositoryInitializationPromise = null;
        }
    }
    async openFundingPage(url) {
        // Never use window.open for payments: Obsidian's Web Viewer may intercept it.
        if (!fundingLinkFromManifest(url))
            throw new Error("Invalid funding URL.");
        const electron = require("electron");
        if (typeof electron?.shell?.openExternal !== "function") {
            throw new Error("The system browser is unavailable in this Obsidian desktop build.");
        }
        await electron.shell.openExternal(url);
    }
    openPluginSettings() {
        const setting = this.app.setting;
        if (!setting) {
            new obsidian_1.Notice("Open Settings → Community plugins → Vault Version Control.");
            return;
        }
        setting.open();
        if (typeof setting.openTabById === "function")
            setting.openTabById(this.manifest.id);
    }
    async copyText(text) {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return;
            }
        }
        catch {
            // Fall through to Electron clipboard.
        }
        try {
            const electron = require("electron");
            if (electron?.clipboard?.writeText) {
                electron.clipboard.writeText(text);
                return;
            }
        }
        catch {
            // Ignore and report a useful error below.
        }
        throw new Error("Unable to copy the command automatically. Select and copy it manually.");
    }
    async openTerminal() {
        if (process.platform !== "darwin")
            throw new Error("Open Terminal manually on this platform.");
        await new Promise((resolve, reject) => {
            execFile("/usr/bin/open", ["-a", "Terminal"], { windowsHide: true }, (error) => {
                if (error)
                    reject(new Error(error.message || "Unable to open Terminal."));
                else
                    resolve();
            });
        });
    }
    async startCommandLineToolsInstall() {
        if (process.platform !== "darwin")
            throw new Error("Command Line Tools installation is only available on macOS.");
        await new Promise((resolve, reject) => {
            execFile("/usr/bin/xcode-select", ["--install"], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
                if (error) {
                    const message = (stderr || stdout || error.message || "Unable to start Command Line Tools installation.").trim();
                    reject(new Error(message));
                    return;
                }
                resolve();
            });
        });
    }
    async activateVersionControlView() {
        const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (existingLeaves.length) {
            await this.app.workspace.revealLeaf(existingLeaves[0]);
            return;
        }
        const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getRightLeaf(true);
        if (!leaf) {
            new obsidian_1.Notice("Unable to open the Version Control sidebar.");
            return;
        }
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
        await this.app.workspace.revealLeaf(leaf);
    }
    requestRefresh(delay = STATUS_DEBOUNCE_MS) {
        if (this.refreshTimer !== null)
            window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            void this.refreshVersionControlNow();
        }, delay);
    }
    async refreshVersionControlNow(manual = false) {
        // Ignore automatic refreshes while repository initialization is in flight.
        // The initializer performs a definitive refresh when it completes.
        if (this.repositoryInitializationPromise && !manual)
            return;
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        for (const leaf of leaves) {
            if (leaf.view instanceof VersionControlView)
                await leaf.view.refresh(manual);
        }
    }
    historyPreviewFileName(filePath, entry) {
        const slash = filePath.lastIndexOf("/");
        const directory = slash >= 0 ? filePath.slice(0, slash + 1) : "";
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return `${directory}~vault-version-control-history-preview-${entry.shortHash}-${nonce}.md`;
    }
    historyPreviewOpenPaths() {
        const openPaths = new Set();
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const file = leaf.view?.file;
            if (file instanceof obsidian_1.TFile)
                openPaths.add(file.path);
        }
        return openPaths;
    }
    decorateHistoryPreviewFile(pathValue) {
        const info = this.historyPreviewInfo.get(pathValue);
        if (!info)
            return;
        for (const node of Array.from(document.querySelectorAll("[data-path]"))) {
            if (node.getAttribute("data-path") === pathValue) {
                node.classList.add("vvc-history-preview-file");
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (!(view?.file instanceof obsidian_1.TFile) || view.file.path !== pathValue)
                continue;
            const container = view.containerEl;
            if (!container)
                continue;
            const markerRoot = container.closest(".workspace-leaf-content") || container;
            markerRoot.classList.add("vvc-history-preview-view");
            markerRoot.setAttribute("data-vvc-history-preview-path", pathValue);
            const label = `${info.filePath} · Historical version (read-only) · ${info.entry.shortHash} · ${formatDate(info.entry.timestamp)}`;
            if (!view.__vvcOriginalGetDisplayText) {
                view.__vvcOriginalGetDisplayText = view.getDisplayText?.bind(view);
            }
            view.getDisplayText = () => label;
            const leafAny = leaf;
            if (typeof leafAny.updateHeader === "function")
                leafAny.updateHeader();
            const title = container.querySelector(".view-header-title");
            if (title) {
                title.textContent = label;
                title.title = label;
                title.setAttribute("aria-readonly", "true");
                title.classList.add("vvc-history-preview-title-readonly");
            }
            const actions = container.querySelector(".view-actions");
            if (actions && !actions.querySelector(".vvc-history-preview-use-button")) {
                const useButton = buttonEl(actions, "Use this version", "vvc-history-preview-use-button");
                useButton.title = `Use ${info.filePath} from ${info.entry.shortHash}`;
                useButton.addEventListener("click", async () => {
                    useButton.disabled = true;
                    try {
                        await this.restoreFileFromHistory(info.filePath, info.entry);
                    }
                    catch (error) {
                        new obsidian_1.Notice(gitFailureNotice(error, "restore"), 7000);
                    }
                    finally {
                        useButton.disabled = false;
                    }
                });
            }
        }
    }
    scheduleHistoryPreviewMaintenance(delay = 80) {
        if (this.historyPreviewMaintenanceTimer !== null) {
            if (delay > 0)
                return;
            window.clearTimeout(this.historyPreviewMaintenanceTimer);
            this.historyPreviewMaintenanceTimer = null;
        }
        this.historyPreviewMaintenanceTimer = window.setTimeout(() => {
            this.historyPreviewMaintenanceTimer = null;
            void this.maintainHistoryPreviews();
        }, delay);
    }
    async maintainHistoryPreviews() {
        // A workspace leaf can be reused for another file. Remove historical-view
        // decoration immediately in that case so a normal note can never inherit
        // the preview-only read-only editor constraint.
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            const file = view?.file;
            const container = view?.containerEl;
            if (!container)
                continue;
            const isHistoryPreview = file instanceof obsidian_1.TFile && this.historyPreviewPaths.has(file.path);
            if (isHistoryPreview)
                continue;
            const markerRoot = container.closest(".workspace-leaf-content") || container;
            markerRoot.classList.remove("vvc-history-preview-view");
            markerRoot.removeAttribute("data-vvc-history-preview-path");
            container.classList.remove("vvc-history-preview-view");
            container.removeAttribute("data-vvc-history-preview-path");
            container.querySelector(".vvc-history-preview-use-button")?.remove();
            const title = container.querySelector(".view-header-title.vvc-history-preview-title-readonly");
            if (title) {
                title.classList.remove("vvc-history-preview-title-readonly");
                title.removeAttribute("aria-readonly");
            }
            if (view.__vvcOriginalGetDisplayText) {
                view.getDisplayText = view.__vvcOriginalGetDisplayText;
                delete view.__vvcOriginalGetDisplayText;
                const leafAny = leaf;
                if (typeof leafAny.updateHeader === "function")
                    leafAny.updateHeader();
            }
        }
        const openPaths = this.historyPreviewOpenPaths();
        for (const pathValue of Array.from(this.historyPreviewPaths)) {
            if (openPaths.has(pathValue)) {
                this.decorateHistoryPreviewFile(pathValue);
                continue;
            }
            const info = this.historyPreviewInfo.get(pathValue);
            if (info && Date.now() - info.createdAt < 1200)
                continue;
            await this.removeOwnedHistoryPreview(pathValue);
        }
    }
    async removeStaleHistoryPreviewFiles() {
        // A name alone cannot establish ownership after a restart.
        const previewName = /(?:^|\/)~vault-version-control-history-preview-[0-9a-f]{7,40}-\d{13}-[a-z0-9]{6}\.md$/;
        const count = this.app.vault.getMarkdownFiles().filter((file) => previewName.test(file.path) && !this.historyPreviewPaths.has(file.path)).length;
        if (count)
            console.info(`Vault Version Control: preserved ${count} possible historical previews from an earlier session; review them manually.`);
    }
    async removeOwnedHistoryPreview(pathValue) {
        const info = this.historyPreviewInfo.get(pathValue);
        this.historyPreviewPaths.delete(pathValue);
        this.historyPreviewInfo.delete(pathValue);
        if (!info)
            return;
        try {
            const file = this.app.vault.getAbstractFileByPath(pathValue);
            if (file !== info.file || !(file instanceof obsidian_1.TFile))
                return;
            assertNoUnsavedMarkdownViews(this.app, this.git.vaultPath, new Set([pathValue]));
            const current = this.git.captureWorkingFileSnapshot(pathValue);
            if (JSON.stringify(current) !== JSON.stringify(info.snapshot))
                return;
            await this.app.vault.delete(file);
        }
        catch (error) {
            console.warn("Vault Version Control: preserved changed or unverifiable preview", pathValue, error);
        }
    }
    closeHistoryPreviewLeaves() {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const file = leaf.view?.file;
            if (!(file instanceof obsidian_1.TFile) || !this.historyPreviewPaths.has(file.path))
                continue;
            const info = this.historyPreviewInfo.get(file.path);
            try {
                assertNoUnsavedMarkdownViews(this.app, this.git.vaultPath, new Set([file.path]));
                if (!info || file !== info.file ||
                    JSON.stringify(this.git.captureWorkingFileSnapshot(file.path)) !== JSON.stringify(info.snapshot))
                    continue;
            }
            catch {
                continue;
            }
            const leafAny = leaf;
            if (typeof leafAny.detach === "function")
                leafAny.detach();
        }
    }
    async removeAllHistoryPreviewFiles() {
        for (const pathValue of Array.from(this.historyPreviewPaths))
            await this.removeOwnedHistoryPreview(pathValue);
    }
    async viewFileFromHistory(filePath, entry) {
        if (!isMarkdownPath(filePath)) {
            throw new Error("Historical View currently supports Markdown files.");
        }
        const blob = await this.git.readFileVersion(entry);
        const content = blob.toString("utf8");
        this.git.ensureHistoryPreviewIgnored();
        const previewPath = this.historyPreviewFileName(filePath, entry);
        const previewFile = await this.app.vault.create(previewPath, content);
        const snapshot = this.git.captureWorkingFileSnapshot(previewPath);
        if (snapshot.sha256 !== require("crypto").createHash("sha256").update(content, "utf8").digest("hex")) {
            throw new Error("Historical preview changed during creation; the file was preserved.");
        }
        this.historyPreviewPaths.add(previewPath);
        this.historyPreviewInfo.set(previewPath, { filePath, entry, createdAt: Date.now(), file: previewFile, snapshot });
        try {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({
                type: "markdown",
                active: true,
                state: { file: previewPath, mode: "preview", source: false },
            });
            await this.app.workspace.revealLeaf(leaf);
            window.requestAnimationFrame(() => this.decorateHistoryPreviewFile(previewPath));
            window.setTimeout(() => this.decorateHistoryPreviewFile(previewPath), 250);
        }
        catch (error) {
            await this.removeOwnedHistoryPreview(previewPath);
            throw error;
        }
    }
    historyCopyDefaultFileName(sourcePath, entry) {
        const fileName = sourcePath.split("/").pop() || "historical-version.md";
        const dot = fileName.lastIndexOf(".");
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const extension = dot > 0 ? fileName.slice(dot) : ".md";
        return `${stem} - ${entry.shortHash}${extension}`;
    }
    vaultBasePath() {
        const adapter = this.app.vault.adapter;
        if (typeof adapter?.getBasePath !== "function") {
            throw new Error("The current Vault does not expose a local filesystem path.");
        }
        return path.resolve(adapter.getBasePath());
    }
    vaultRelativePathForAbsolutePath(absolutePath) {
        const basePath = fs.realpathSync(this.vaultBasePath());
        const resolved = path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
        const relative = path.relative(basePath, resolved);
        if (!relative || relative === ".")
            return null;
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            return null;
        return relative.split(path.sep).join("/");
    }
    sameFilesystemPath(left, right) {
        const resolve = (value) => {
            try {
                return fs.realpathSync(value);
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    throw error;
                return path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
            }
        };
        const a = resolve(left), b = resolve(right);
        if (a === b || (process.platform === "win32" && a.toLowerCase() === b.toLowerCase()))
            return true;
        try {
            const sa = fs.statSync(left), sb = fs.statSync(right);
            return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
        }
        catch (error) {
            if (error?.code !== "ENOENT")
                throw error;
            return false;
        }
    }
    async writeHistoricalCopyAtomic(absolute, bytes, expected) {
        const temp = path.join(path.dirname(absolute), `.vvc-copy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
        const handle = await fs.promises.open(temp, "wx", expected.mode ?? 0o644);
        try {
            await fs.promises.writeFile(handle, bytes);
            await handle.sync();
            if (JSON.stringify(snapshotRegularFile(absolute)) !== JSON.stringify(expected)) {
                throw new Error("Save target changed. Choose the file again.");
            }
            if (expected.exists)
                fs.renameSync(temp, absolute);
            else {
                fs.linkSync(temp, absolute);
                fs.unlinkSync(temp);
            }
        }
        finally {
            await handle.close();
            try {
                fs.unlinkSync(temp);
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    console.warn("Retained historical copy temp", temp, error);
            }
        }
    }
    nativeSaveDialog() {
        try {
            const remote = require("@electron/remote");
            if (remote?.dialog?.showSaveDialog)
                return remote;
        }
        catch {
            // Newer Obsidian desktop builds normally expose @electron/remote.
        }
        try {
            const electron = require("electron");
            if (electron?.remote?.dialog?.showSaveDialog)
                return electron.remote;
        }
        catch {
            // Older Obsidian desktop builds may expose electron.remote instead.
        }
        const windowRemote = window?.electron?.remote;
        if (windowRemote?.dialog?.showSaveDialog)
            return windowRemote;
        throw new Error("The system Save dialog is not available in this Obsidian desktop build.");
    }
    async saveHistoricalCopyAs(previewPath, sourcePath, entry) {
        const basePath = this.vaultBasePath();
        const sourceAbsolutePath = path.resolve(basePath, ...sourcePath.split("/"));
        const previewAbsolutePath = path.resolve(basePath, ...previewPath.split("/"));
        const sourceDirectory = path.dirname(sourceAbsolutePath);
        const defaultPath = path.join(sourceDirectory, this.historyCopyDefaultFileName(sourcePath, entry));
        const remote = this.nativeSaveDialog();
        const options = {
            title: "Save a copy as...",
            defaultPath,
            buttonLabel: "Save",
            filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
            properties: process.platform === "darwin"
                ? ["createDirectory"]
                : process.platform === "linux"
                    ? ["showOverwriteConfirmation"]
                    : [],
        };
        try {
            const currentWindow = typeof remote.getCurrentWindow === "function" ? remote.getCurrentWindow() : null;
            const result = currentWindow
                ? await remote.dialog.showSaveDialog(currentWindow, options)
                : await remote.dialog.showSaveDialog(options);
            if (!result || result.canceled || !result.filePath)
                return;
            let targetAbsolutePath = path.resolve(String(result.filePath));
            const extension = path.extname(targetAbsolutePath);
            if (!extension) {
                const sourceExtension = /\.(markdown|md)$/i.exec(sourcePath)?.[0] || ".md";
                targetAbsolutePath += sourceExtension;
            }
            else if (!/\.(markdown|md)$/i.test(targetAbsolutePath)) {
                new obsidian_1.Notice("Historical Markdown copies must use a .md or .markdown extension.");
                return;
            }
            if (this.sameFilesystemPath(targetAbsolutePath, sourceAbsolutePath)) {
                new obsidian_1.Notice('Choose a different file from the current working file. Use "Use this version" to replace it.');
                return;
            }
            if (this.sameFilesystemPath(targetAbsolutePath, previewAbsolutePath)) {
                new obsidian_1.Notice("Choose a different file from the temporary historical preview.");
                return;
            }
            const expected = snapshotRegularFile(targetAbsolutePath);
            if (!extension && expected.exists)
                throw new Error("Choose the existing target with its complete extension to confirm replacement.");
            const blob = await this.git.readFileVersion(entry);
            if (this.sameFilesystemPath(targetAbsolutePath, sourceAbsolutePath) ||
                this.sameFilesystemPath(targetAbsolutePath, previewAbsolutePath) ||
                JSON.stringify(snapshotRegularFile(targetAbsolutePath)) !== JSON.stringify(expected)) {
                throw new Error("Save target changed or points to a protected source. Choose the file again.");
            }
            const content = blob.toString("utf8");
            const vaultRelativePath = this.vaultRelativePathForAbsolutePath(targetAbsolutePath);
            let targetFile = null;
            if (vaultRelativePath) {
                assertNoUnsavedMarkdownViews(this.app, basePath, new Set([vaultRelativePath]));
            }
            if (vaultRelativePath) {
                const existing = this.app.vault.getAbstractFileByPath(vaultRelativePath);
                if (existing instanceof obsidian_1.TFile) {
                    assertNoUnsavedMarkdownViews(this.app, basePath, new Set([vaultRelativePath]));
                    await this.app.vault.modify(existing, content);
                    targetFile = existing;
                }
                else if (existing) {
                    throw new Error(`A folder already exists at: ${vaultRelativePath}`);
                }
                else {
                    const slash = vaultRelativePath.lastIndexOf("/");
                    const parentPath = slash >= 0 ? vaultRelativePath.slice(0, slash) : "";
                    const parent = parentPath ? this.app.vault.getAbstractFileByPath(parentPath) : this.app.vault.getRoot();
                    if (parent instanceof obsidian_1.TFolder) {
                        targetFile = await this.app.vault.create(vaultRelativePath, content);
                    }
                    else {
                        // A folder created from the native dialog may not yet be indexed by
                        // Obsidian. Write it directly and let the Vault watcher discover it.
                        await this.writeHistoricalCopyAtomic(targetAbsolutePath, blob, expected);
                    }
                }
            }
            else {
                await this.writeHistoricalCopyAtomic(targetAbsolutePath, blob, expected);
            }
            if (targetFile) {
                const leaf = this.app.workspace.getLeaf("tab");
                await leaf.openFile(targetFile);
                await this.app.workspace.revealLeaf(leaf);
            }
            new obsidian_1.Notice(`Saved historical copy: ${targetAbsolutePath}`);
        }
        catch (error) {
            new obsidian_1.Notice(error instanceof Error ? error.message : String(error));
        }
    }
    async restoreFileFromHistory(filePath, entry) {
        if (entry.contentAvailable === false) {
            throw new Error("This commit removed the file from Git; it is not a file version. Local files were not changed.");
        }
        assertNoUnsavedMarkdownViews(this.app, this.git.vaultPath, new Set([filePath]));
        const expected = this.git.captureWorkingFileSnapshot(filePath);
        const dirty = await this.git.fileHasChanges(filePath);
        const tracked = (await this.git.run(["ls-files", "--stage", "-z", "--", `:(literal)${filePath}`])).stdout;
        const execute = async () => {
            await this.git.restoreFile(filePath, entry, expected);
            new obsidian_1.Notice(`Using ${filePath} from ${entry.shortHash}.`);
            await this.refreshVersionControlNow();
        };
        if (dirty || (expected.exists && !tracked)) {
            new ConfirmRestoreModal(this.app, filePath, entry, execute).open();
            return;
        }
        await execute();
    }
    async makeDefaultBranchName(shortHash) {
        const base = `from-${shortHash.replace(/[^A-Za-z0-9._-]/g, "-") || "version"}`;
        const existing = new Set((await this.git.branches()).map((branch) => branch.name));
        if (!existing.has(base))
            return base;
        for (let i = 2; i < 1000; i += 1) {
            const candidate = `${base}-${i}`;
            if (!existing.has(candidate))
                return candidate;
        }
        return `${base}-${Date.now()}`;
    }
    async chooseTextFile(excludedPath) {
        return await new Promise((resolve) => {
            const modal = new TextFileSuggestModal(this, excludedPath, resolve);
            modal.open();
        });
    }
    async openDiffView(left, right, diffText) {
        // Capture the real Markdown editor typography before the Diff tab becomes active.
        // If no Markdown view is open, resolveMarkdownTypography() falls back safely.
        this.resolveMarkdownTypography();
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({
            type: DIFF_VIEW_TYPE,
            active: true,
            state: { left, right, diffText: typeof diffText === "string" ? diffText : "", wrapLines: true },
        });
        // Run only for a newly requested comparison. Restoring an Obsidian layout
        // calls setState but never reaches this entry point.
        const diffView = leaf.view;
        if (diffView?.getViewType?.() !== DIFF_VIEW_TYPE || typeof diffView.startComparison !== "function") {
            throw new Error("Unable to initialize the comparison view.");
        }
        diffView.startComparison();
        await this.app.workspace.revealLeaf(leaf);
    }
    async compareHistorySources(left, right) {
        try {
            await this.openDiffView(left, right);
        }
        catch (error) {
            new obsidian_1.Notice(gitFailureNotice(error, "diff"), 7000);
        }
    }
    async compareFileWith(first) {
        if (!isTextFile(first)) {
            new obsidian_1.Notice("Only text files can be compared.");
            return;
        }
        const second = await this.chooseTextFile(first.path);
        if (!second)
            return;
        try {
            const left = workingTreeDiffSource(first.path);
            const right = workingTreeDiffSource(second.path);
            await this.openDiffView(left, right);
        }
        catch (error) {
            new obsidian_1.Notice(gitFailureNotice(error, "diff"), 7000);
        }
    }
}
exports.default = VaultVersionControlPlugin;
