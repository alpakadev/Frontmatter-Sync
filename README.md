# Frontmatter Sync

Frontmatter Sync is a plugin for Obsidian that automatically maintains bidirectional relationships within your YAML frontmatter. When you define a relationship in one note, the plugin seamlessly works in the background to update the target note with the inverse relationship.

Whether you are building a spatial "Compass System" (North/South, East/West) or a hierarchical structure (Parents/Children), this plugin ensures your metadata links are never out of sync.

## Key Features

* **Automatic Bidirectional Sync:** Define forward and inverse property pairs. Updating one note automatically updates the other.
* **Relation Groups:** Organize your relation pairs into collapsible, easily manageable folders.
* **Drag-and-Drop UI:** Reorder individual pairs or entire folders effortlessly.
* **Rapid Data Entry:** Press `Enter` on the last input field of a pair to instantly create and focus a new pair, allowing for fast, keyboard-only configuration.
* **Bulk Sync Engine:** Scan your entire vault for missing inverse links. Review the detected gaps in a structured preview modal before applying bulk changes.
* **Smart Sync Queue:** Uses a debounced queue to process file creations. This prevents notification spam during bulk note imports or when using external cloud sync tools.
* **Formatting Guards:** Optionally receive warnings if you type plain text instead of valid wikilinks, or if you link to a note that does not exist yet.

## How it Works

1. Open the plugin settings and add a new Relation Pair.
2. Define the **forward** property (e.g., `south`) and the **inverse** property (e.g., `north`).
3. In `Note A`, add `[[Note B]]` to the `south` property.
4. Frontmatter Sync will automatically update `Note B` to include `[[Note A]]` in its `north` property.

For symmetrical relationships (e.g., `siblings`), simply set both the forward and inverse properties to the same key.

## Settings & Configuration

* **Vault Maintenance:** Use the "Run Scan" button to audit your vault. The plugin will analyze all configured relation pairs and identify notes that are missing their corresponding backlinks.
* **Notifications:** Toggle background sync success messages, plain text warnings, and interactive ghost link prompts.
* **Group Management:** Use the master toggle on a folder header to instantly disable or enable all relation pairs within that group.
* **Inline Editing:** Double-click any folder name, or click the pencil icon, to rename it inline.

## Installation

### Manual Installation

1. Download the latest release from the GitHub repository.
2. Extract the `main.js`, `manifest.json`, and `styles.css` files.
3. Place them in your vault's plugin directory: `YourVault/.obsidian/plugins/compass-sync/`.
4. Reload Obsidian and enable the plugin in the Community Plugins settings tab.