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

		// 1. "Add New" Button
		new Setting(containerEl)
			.setName("Add a new relation pair")
			.setDesc("Create a bidirectional link (e.g., south / north, or parent / child).")
			.addButton((btn) =>
				btn
					.setButtonText("Add +")
					.setCta()
					.onClick(async () => {
						// Push a blank pair into the array
						this.plugin.settings.relations.push({ forward: "", inverse: "" });
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// 2. Draw existing relation pairs
		this.plugin.settings.relations.forEach((pair, index) => {
			new Setting(containerEl)
				.setName(`Relation #${index + 1}`)

				.addText((text) =>
					text
						.setPlaceholder("e.g., south")
						.setValue(pair.forward)
						.onChange(async (value) => {
							pair.forward = value;
							await this.plugin.saveSettings();
						})
				)

				.addText((text) =>
					text
						.setPlaceholder("e.g., north")
						.setValue(pair.inverse)
						.onChange(async (value) => {
							pair.inverse = value;
							await this.plugin.saveSettings();
						})
				)

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
		});
	}
}