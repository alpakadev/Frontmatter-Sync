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

		// Handle regular Enter presses when menu is closed or no selection made
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
		// Reset the "show all" flag if the user continues typing
		if (this.lastInput !== inputStr) {
			this.showAll = false;
			this.lastInput = inputStr;
		}

		const query = inputStr.toLowerCase();
		const filtered = this.keys.filter(k => k.toLowerCase().includes(query));

		if (this.showAll) {
			return filtered;
		}

		// Cap at 20 and append the "..." expansion button
		if (filtered.length > 20) {
			return [...filtered.slice(0, 20), "__MORE__"];
		}

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
			// Wait for internal close logic to finish, then reopen with all items
			window.setTimeout(() => {
				this.inputEl.focus();
				this.inputEl.dispatchEvent(new Event('input'));
			}, 10);
			return;
		}

		// Apply the selected suggestion
		this.inputEl.value = item;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();

		// Automatically focus the inverse property box!
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
			.setDesc("Create a bidirectional link (e.g., south / north, or parent / child).")
			.addButton((btn) =>
				btn
					.setButtonText("Add +")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.relations.push({ forward: "", inverse: "" });
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// Extract all existing property keys from the vault for suggestions
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

		// Draw existing relation pairs
		this.plugin.settings.relations.forEach((pair, index) => {
			let forwardInput: HTMLInputElement | null = null;
			let inverseInput: HTMLInputElement | null = null;

			new Setting(containerEl)
				.setName(`Relation #${index + 1}`)

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

			// Attach the native Obsidian Suggestion Menus to the rendered inputs
			if (forwardInput && inverseInput) {
				new PropertySuggest(this.app, forwardInput, keysArray, inverseInput);
				new PropertySuggest(this.app, inverseInput, keysArray); // No next input to jump to
			}
		});
	}
}