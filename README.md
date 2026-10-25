# Vault Version Control

**Manage your Obsidian vault's Git history without leaving Obsidian.**

Vault Version Control is a desktop plugin for tracking changes, inspecting earlier versions of notes, comparing files, and managing Git branches. Optional remote operations help you import history and deliberately fetch or push changes.

> **Safety:** Git version history is not automatic cloud backup or sync. Begin with a test vault and maintain independent backups.

## Features

- **Capture versions:** Review changes, stage and unstage files, and create commit snapshots.
- **Browse file history:** Preview historical notes and restore a copy without resetting the current branch.
- **Compare text files:** Read-only side-by-side diffs, inline highlights, line numbers, wrapping, a difference overview, theme-matched typography, and large-file rendering.
- **Explore vault history:** Branch-aware commit graph, full commit messages, **Start Here** to branch from an older commit, and protected branch switching.
- **Use remote Git:** Preview and initialize from remote history, connect a destination remote, fetch, and push the current branch without forcing.
- **Manage ignored files:** Add selected files to Git ignore rules.
- **Support development:** Optional funding entry in plugin Settings and Obsidian's native Donate menu.

See the **[feature overview and user guide](docs/FEATURES.md)** for workflows, precautions, and limitations.

## Requirements

- Obsidian Desktop 1.7.2 or later.
- Git 2.29 or later installed on your computer.
- Desktop only; mobile is not supported.

## Install

Once listed in the Obsidian Community Plugins directory, install it through **Settings → Community plugins**.

Before directory acceptance, install manually:

1. Open [GitHub Releases](https://github.com/czmatwhu/vault-version-control/releases).
2. Download the individual runtime files **main.js**, **manifest.json**, and **styles.css**, or use the optional convenience installation ZIP.
3. Place all three files inside your vault at **.obsidian/plugins/vault-version-control/**.
4. Reload Obsidian, open **Settings → Community plugins**, and enable **Vault Version Control**.
5. Open the Version Control sidebar using its ribbon icon or command.

## Getting started

For a vault with no Git repository, choose local initialization to create the first snapshot. An existing Git repository at the vault root is detected automatically. The advanced **Initialize from Remote** workflow is not an ordinary clone: read the [import precautions](docs/FEATURES.md#5-initialize-from-a-remote-repository) first.

Configure Git detection and commit identity under **Settings → Vault Version Control**.

## Limits and privacy

This plugin is not an automatic sync service, a full Git client, or a substitute for backups. **Fetch** does not merge files into the vault. Force push and general merge/rebase workflows are not supported. Before pushing a vault, inspect *all reachable Git history* for personal information and secrets, not just the current files.

## Development

Install dependencies with **npm install**, then run **npm run check**, **npm run build**, and **npm test**.

The installable runtime consists only of **main.js**, **manifest.json**, and **styles.css**. The prior long-form README and change history is preserved in [historical development notes](docs/release-history.md).


## Source code and data access

The TypeScript source and development history are maintained in a separate private repository. The compiled plugin JavaScript and release assets are publicly accessible here. Obsidian's Community Directory can be granted access to the private source for build verification.

**Network access:** User-requested remote Git operations (such as Initialize from Remote, Fetch and Push) contact user-configured Git servers. The optional donation action opens PayPal only after clicking. No telemetry is sent.

**Local access:** The plugin invokes an installed Git executable and may create temporary files outside the vault for remote preparation and safe comparison. It accesses vault files and local Git metadata to operate.

## License and support

See [LICENSE](LICENSE). Bugs and feature requests can be filed as GitHub issues; remove private vault content and credentials from diagnostics. Optional financial support is offered through **Donate** and **Support Development** and does not unlock features.
