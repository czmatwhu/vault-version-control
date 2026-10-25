# Vault Version Control — Feature Overview and User Guide

Vault Version Control brings Git-based version history into Obsidian Desktop for writers, researchers, and anyone who manages a vault with Git. You can review and commit edits, see older versions of notes, compare text files, create branches and use optional remote operations.

**This is not continuous cloud sync or a replacement for backups.**

## 1. Create and maintain local history

Open **Vault Version Control** from its ribbon icon or the **Open Version Control** command. If your vault does not have a Git repository, select local initialization to create a repository and its first snapshot. The plugin creates default ignore rules when needed and can help configure missing author information. If a repository already exists at the vault root, the plugin works with it.

Use **Changes** and **Staged changes** to see tracked file states. Stage or unstage individual files, use **Stage all** when appropriate, type a commit message, and click **Commit**. Obsidian file changes usually trigger automatic refresh; manually use **Refresh Git Status** if changes from another program are not visible.

## 2. Browse file history and recover earlier content

Right-click a file in Obsidian File Explorer or in the plugin's changed-file list and select **View File History**. Hovering a filename in the plugin may also reveal a compact version history preview.

Historical Markdown snapshots can be previewed. Choose **Use this version** to copy an earlier version into your *current working tree*. It does **not** rewind the branch HEAD. Inspect the result and commit it if desired. Existing work is protected by safety checks, but maintain your own independent backups.

## 3. Compare two text files

Right-click a text file and select **Compare with…**, then choose another file. The comparison view is read-only: both originals remain unchanged.

Features include side-by-side lines, line numbers, inline added/removed highlights, optional wrapping and grid lines, clickable difference overview ruler, synchronized horizontal movement, adaptive stacked layout in narrow windows, incremental rendering for large files, and fonts matching the active Obsidian theme.

## 4. Explore commits and local branches

**Vault History** shows a branch-aware graph. **View full message** displays complete commit text, including multi-line messages, with a copy action. **Start Here** lets you create a new local branch from a historical commit without discarding the existing branch. You can also switch local branches using the branch selector. Working-tree/editor safeguards apply.

**Edit message** is deliberately limited to an eligible *latest commit* in a local-only repository. Editing shared or historical commits would change Git hashes and is restricted.

## 5. Initialize from a remote repository

**Initialize from Remote** previews and imports history into the *current vault*. It is not an ordinary Git clone, and it does not silently overwrite your existing local files. It checks path safety, ignore rules, and potentially conflicting configuration; a successful import can create a baseline commit recording local differences.

The source remote is not automatically configured as the push destination, and remote Obsidian settings/plugins are not blindly installed. Unsupported or ambiguous conditions are rejected rather than guessed around.

**Back up the vault before remote initialization.** Inspect the preview and pay special attention to .obsidian and .gitignore handling.

## 6. Connect remote, fetch, and push

You can configure a destination Git remote, inspect *locally known* ahead/behind data, fetch remote-tracking information, and push the current branch.

- **Fetch** updates local remote tracking references; it does not automatically merge them into working files.
- **Push** performs a normal, non-force push. The first push involves an explicit confirmation.
- **Do not push private history inadvertently:** files deleted from the current state may still exist in older Git commits.
- Git credentials depend on your local Git configuration and remote provider.

Automatic cloud sync, general conflict merging/rebasing and force push are outside this plugin's scope.

## 7. Exclude files from Git tracking

**Ignore files…** adds selected file paths to Git ignore rules. Adding an ignore entry does not retroactively remove already published versions of that file from Git history.

## 8. Settings and optional developer support

Under **Settings → Vault Version Control**, use **Auto detect** to select a Git executable or specify a custom Git path. Configure the commit author identity using either Git configuration or this vault's dedicated identity settings.

At the bottom, **Support Development** displays an optional link when the plugin manifest defines a valid funding URL. It reads the same manifest metadata used by Obsidian's native **Donate** menu. **Open in browser** uses the system default external browser. Supporting the developer is completely optional.

## 9. Troubleshooting

**Git cannot be found:** Install Git, recheck Settings, and (on macOS) ensure Command Line Tools and the Xcode license are configured if needed.

**Branch switching is refused:** Resolve or commit current changes and check for unsaved editor work.

**Push fails:** Inspect the configured remote, credentials and remote history. Fetch first. The plugin will not silently force a push or merge.

**Support entry missing:** Confirm the installed manifest is current and restart Obsidian to reload the plugin metadata.

**Report a bug:** On GitHub Issues, include the plugin version, OS, Obsidian version and reproduction steps. Never paste tokens, private note contents or sensitive filesystem details.

---

*Documentation for Vault Version Control 0.1.41; October 2026.*
