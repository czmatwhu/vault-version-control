# Vault Version Control 0.1.42

This maintenance release addresses two findings from Obsidian Community Directory review:

- **Error fixed:** Shortened the plugin description in manifest.json to remove the redundant word "Obsidian".
- **Compatibility warning addressed:** Replaced Grid column-gap: 12px and row-gap: 10px declarations with the equivalent gap: 10px 12px shorthand in the Diff progress panel.

**Intentionally unchanged:** All five CSS !important declarations remain as in 0.1.41, at the developer's request. Those styling warnings may still appear in review.

No changes were made to the plugin's Git operations or runtime TypeScript logic. GitHub Release assets contain separately downloadable main.js, manifest.json, and styles.css, plus an optional installation ZIP.

Validation: npm run check, npm run build and npm test passed (149 tests passed, one optional test skipped). The JavaScript runtime hash is byte-for-byte identical to 0.1.41.

Requirements: Obsidian Desktop 1.7.2+, Git 2.29+. This release is not yet a guarantee of Community Directory approval.
