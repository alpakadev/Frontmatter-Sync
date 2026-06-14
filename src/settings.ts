import { App, PluginSettingTab, Setting } from "obsidian";
import type CompassSyncPlugin from "./main";

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

		// --- DATALIST FOR PROPERTY SUGGESTIONS ---
		const datalistId = "compass-property-keys";
		const datalist = containerEl.createEl("datalist");
		datalist.id = datalistId;

		const keys = new Set<string>();

		// Use Obsidian's native property keys API if available, otherwise fallback to scanning files
		if (typeof (this.app.metadataCache as any).getAllPropertyKeys === "function") {
			const props = (this.app.metadataCache as any).getAllPropertyKeys();
			props.forEach((p: string) => keys.add(p));
		} else {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) {
					Object.keys(cache.frontmatter).forEach(k => keys.add(k));
				}
			}
		}

		keys.forEach(key => {
			datalist.createEl("option", { value: key });
		});

		// --- RENDER RELATION PAIRS ---
		this.plugin.settings.relations.forEach((pair, index) => {
			let forwardInput: HTMLInputElement | null = null;
			let inverseInput: HTMLInputElement | null = null;

			new Setting(containerEl)
				.setName(`Relation #${index + 1}`)

				.addText((text) => {
					forwardInput = text.inputEl;
					forwardInput.setAttribute("list", datalistId); // Attach auto-complete

					text.setPlaceholder("e.g., south")
						.setValue(pair.forward)
						.onChange(async (value) => {
							pair.forward = value;
							await this.plugin.saveSettings();
						});
				})

				.addText((text) => {
					inverseInput = text.inputEl;
					inverseInput.setAttribute("list", datalistId); // Attach auto-complete

					text.setPlaceholder("e.g., north")
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

			// Add "Enter" key navigation from Forward to Inverse input
			if (forwardInput && inverseInput) {
				forwardInput.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						e.preventDefault();
						inverseInput!.focus();
					}
				});
			}
		});
	}
}