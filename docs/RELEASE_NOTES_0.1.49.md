# Vault Version Control 0.1.49

This release updates the public installation package from 0.1.42 to 0.1.49, including improved Ignore from Git workflows, safer historical restore behavior, and clearer comparisons.

## Changes

- **Ignore files and folders:** Ignore individual or selected files/folders, including already tracked items, without deleting their local content. Repeated Ignore operations do not require intermediate commits.
- **Precise staging and Undo:** Only new ignore rules and selected tracked-file removals are staged. Existing unrelated .gitignore edits remain untouched. The latest pending Ignore can be safely undone, with a compact non-intrusive Undo notice.
- **Historical restore safety:** Use this version never treats a commit without a file Blob as an instruction to delete a local file.
- **File History:** Distinguish Git removal events from actual committed file versions. A Git removal event has a separate, read-only View Git change action.
- **Compare:** Compare an existing, saved Current local file (including ignored/untracked files) with historical versions containing actual file content. Removal events cannot masquerade as empty file versions. Show the current file and its latest matching removal event as one compact item in Compare mode.
- **File status:** Stopped-tracking files that remain on disk are clearly differentiated from physical deletions.

## Safety and compatibility

- Existing committed content remains in Git history when ignored. Local files are preserved by Ignore from Git.
- Compares use the bytes saved on disk, excluding unsaved editor text.
- Git history is not cloud backup or automatic sync. Maintain independent backups and start with a test vault.
- Requires Obsidian Desktop 1.7.2+ and a locally installed Git 2.29+.
- Public source distribution: this repository contains the installable runtime. The TypeScript source and development history reside in a separate private repository; Obsidian Community Directory can be granted read access for build review.
- Public release assets include main.js, manifest.json, styles.css and an optional installation ZIP.

Validation: 182 automated tests passed, 1 optional test skipped, 0 failed; TypeScript type-check and production build passed. No Community Directory approval is implied.
