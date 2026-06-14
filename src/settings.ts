import { App, PluginSettingTab, Setting, AbstractInputSuggest } from "obsidian";
import type CompassSyncPlugin from "./main";

// --- NATIVE OBSIDIAN SUGGESTION MENU ---
class PropertySuggest extends AbstractInputSuggest<string> {
	private showAll = false;
	private lastInput = "";

	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private keys: string[],
		private nextInputEl?: HTMLInputElement
	) {
		super(app, inputEl);

		inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.defaultPrevented) {
				e.preventDefault();
				this.jumpToNext();
			}
		});
	}

	private jumpToNext() {
		if (this.nextInputEl) {
			window.setTimeout(() => {
				this.nextInputEl!.focus();
			}, 10);
		}
	}

	getSuggestions(inputStr: string): string[] {
		if (this.lastInput !== inputStr) {
			this.showAll = false;
			this.lastInput = inputStr;
		}

		const query = inputStr.toLowerCase();
		const filtered = this.keys.filter(k => k.toLowerCase().includes(query));

		if (this.showAll) return filtered;
		if (filtered.length > 20) return [...filtered.slice(0, 20), "__MORE__"];

		return filtered;
	}

	renderSuggestion(item: string, el: HTMLElement): void {
		if (item === "__MORE__") {
			el.setText("...");
			el.style.textAlign = "center";
			el.style.opacity = "0.6";
			el.style.fontStyle = "italic";
		} else {
			el.setText(item);
		}
	}

	selectSuggestion(item: string, evt: MouseEvent | KeyboardEvent): void {
		if (item === "__MORE__") {
			this.showAll = true;
			window.setTimeout(() => {
				this.inputEl.focus();
				this.inputEl.dispatchEvent(new Event('input'));
			}, 10);
			return;
		}

		this.inputEl.value = item;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
		this.jumpToNext();
	}
}

export class CompassSettingTab extends PluginSettingTab {
	plugin: CompassSyncPlugin;

	constructor(app: App, plugin: CompassSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Relation Sync Settings" });

		// --- NOTIFICATIONS SECTION ---
		containerEl.createEl("h3", { text: "Notifications" });

		new Setting(containerEl)
			.setName("Background sync success")
			.setDesc("Show a popup when a target note is updated in the background.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.notifications.backgroundSync)
				.onChange(async (value) => {
					this.plugin.settings.notifications.backgroundSync = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Plain text warning")
			.setDesc("Warn when you type plain text instead of a valid [[WikiLink]].")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.notifications.plainTextWarning)
				.onChange(async (value) => {
					this.plugin.settings.notifications.plainTextWarning = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Missing file warning")
			.setDesc("Warn when you link to a file that does not exist in the vault yet.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.notifications.ghostLinkWarning)
				.onChange(async (value) => {
					this.plugin.settings.notifications.ghostLinkWarning = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Interactive ghost link prompt")
			.setDesc("Show an interactive prompt to resolve pending links when creating a new note.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.notifications.ghostLinkPrompt)
				.onChange(async (value) => {
					this.plugin.settings.notifications.ghostLinkPrompt = value;
					await this.plugin.saveSettings();
				})
			);

		// --- RELATIONS SECTION ---
		containerEl.createEl("h3", { text: "Relation Pairs" });

		new Setting(containerEl)
			.setName("Add a new relation pair")
			.setDesc("Create a bidirectional link. You can drag and drop pairs to reorder them.")
			.addButton((btn) =>
				btn
					.setButtonText("Add +")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.relations.push({ forward: "", inverse: "", enabled: true });
						await this.plugin.saveSettings();
						this.display();
					})
			);

		const rawKeys = new Set<string>();
		if (typeof (this.app.metadataCache as any).getAllPropertyKeys === "function") {
			const props = (this.app.metadataCache as any).getAllPropertyKeys();
			props.forEach((p: string) => rawKeys.add(p));
		} else {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) {
					Object.keys(cache.frontmatter).forEach(k => rawKeys.add(k));
				}
			}
		}
		const keysArray = Array.from(rawKeys).sort();

		// Create a specific container for the draggable list
		const listContainer = containerEl.createDiv();

		// Draw existing relation pairs
		this.plugin.settings.relations.forEach((pair, index) => {
			// Backwards compatibility for data saved before the "enabled" feature
			if (pair.enabled === undefined) pair.enabled = true;

			let forwardInput: HTMLInputElement | null = null;
			let inverseInput: HTMLInputElement | null = null;

			const setting = new Setting(listContainer)
				.setName(`≡ Pair #${index + 1}`) // Visual grip indicator

				// Enable/Disable toggle button (Compact Eye icon)
				.addExtraButton((btn) => btn
					.setIcon(pair.enabled ? "eye" : "eye-off")
					.setTooltip(pair.enabled ? "Pause relation" : "Enable relation")
					.onClick(async () => {
						pair.enabled = !pair.enabled;
						await this.plugin.saveSettings();
						this.display(); // Re-render to dim/un-dim the row
					})
				)

				.addText((text) => {
					forwardInput = text.inputEl;
					text
						.setPlaceholder("e.g., south")
						.setValue(pair.forward)
						.onChange(async (value) => {
							pair.forward = value;
							await this.plugin.saveSettings();
						});
				})

				.addText((text) => {
					inverseInput = text.inputEl;
					text
						.setPlaceholder("e.g., north")
						.setValue(pair.inverse)
						.onChange(async (value) => {
							pair.inverse = value;
							await this.plugin.saveSettings();
						});
				})

				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete relation")
						.onClick(async () => {
							this.plugin.settings.relations.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);

			const el = setting.settingEl;

			// Visual styling for disabled rows
			if (!pair.enabled) {
				el.style.opacity = "0.4";
				el.style.filter = "grayscale(100%)";
			}

			// --- DRAG AND DROP MECHANICS ---
			el.draggable = true;
			el.style.cursor = "grab";

			el.addEventListener("dragstart", (e) => {
				if (e.dataTransfer) {
					e.dataTransfer.setData("text/plain", index.toString());
					e.dataTransfer.effectAllowed = "move";
					el.style.opacity = "0.3"; // Ghosting effect while dragging
				}
			});

			el.addEventListener("dragend", () => {
				el.style.opacity = pair.enabled ? "1" : "0.4";
				el.style.borderTop = "";
			});

			el.addEventListener("dragover", (e) => {
				e.preventDefault(); // Required to allow dropping
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				el.style.borderTop = "2px solid var(--interactive-accent)";
			});

			el.addEventListener("dragleave", () => {
				el.style.borderTop = "";
			});

			el.addEventListener("drop", async (e) => {
				e.preventDefault();
				el.style.borderTop = "";

				if (!e.dataTransfer) return;
				const fromIndex = parseInt(e.dataTransfer.getData("text/plain"), 10);

				if (!isNaN(fromIndex) && fromIndex !== index) {
					// Swap items in the array
					const relations = this.plugin.settings.relations;
					const [movedItem] = relations.splice(fromIndex, 1);
					relations.splice(index, 0, movedItem);

					await this.plugin.saveSettings();
					this.display(); // Re-render the correctly ordered list
				}
			});

			// Attach the native Obsidian Suggestion Menus
			if (forwardInput && inverseInput) {
				new PropertySuggest(this.app, forwardInput, keysArray, inverseInput);
				new PropertySuggest(this.app, inverseInput, keysArray);
			}
		});
	}
}