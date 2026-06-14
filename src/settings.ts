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
		containerEl.empty(); // Clear the settings screen before drawing

		containerEl.createEl("h2", { text: "Relation Sync Settings" });

		// 1. "Add New" Button
		new Setting(containerEl)
			.setName("Add a new relation pair")
			.setDesc("Create a new forward and inverse relationship.")
			.addButton((btn) =>
				btn
					.setButtonText("Add +")
					.setCta() // Makes the button stand out
					.onClick(async () => {
						// Add a blank pair to our settings
						this.plugin.settings.relations.push({ forward: "", inverse: "" });
						await this.plugin.saveSettings();
						this.display(); // Redraw the screen to show the new inputs
					})
			);

		// 2. Draw existing relation pairs
		this.plugin.settings.relations.forEach((pair, index) => {
			const setting = new Setting(containerEl)
				.setName(`Relation #${index + 1}`)

				// Input for the Forward direction
				.addText((text) =>
					text
						.setPlaceholder("e.g., south")
						.setValue(pair.forward)
						.onChange(async (value) => {
							pair.forward = value;
							await this.plugin.saveSettings();
						})
				)

				// Input for the Inverse direction
				.addText((text) =>
					text
						.setPlaceholder("e.g., north")
						.setValue(pair.inverse)
						.onChange(async (value) => {
							pair.inverse = value;
							await this.plugin.saveSettings();
						})
				)

				// Delete button for this pair
				.addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Delete relation")
						.onClick(async () => {
							this.plugin.settings.relations.splice(index, 1); // Remove from array
							await this.plugin.saveSettings();
							this.display(); // Redraw the screen
						})
				);
		});
	}
}