import { Plugin, TFile, CachedMetadata, Notice } from "obsidian";
import { CompassSyncSettings, DEFAULT_SETTINGS } from "./types";
import { CompassSettingTab } from "./settings";

export default class CompassSyncPlugin extends Plugin {
	settings!: CompassSyncSettings;

	// Guard flags and safety timeouts
	private writingFiles: Set<string> = new Set();
	private writingTimers: Map<string, number> = new Map();

	// Debounce timer
	private timeoutId: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CompassSettingTab(this.app, this));

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				// Debounce: Wait 300ms for the user to finish typing before reacting
				if (this.timeoutId !== null) window.clearTimeout(this.timeoutId);

				this.timeoutId = window.setTimeout(() => {
					void this.handleFileChange(file, cache);
				}, 300);
			})
		);
	}

	async handleFileChange(file: TFile, cache: CachedMetadata) {
		// 1. CLEAR THE GUARD SAFELY
		if (this.writingFiles.has(file.path)) {
			this.clearWritingGuard(file.path);
			return;
		}

		const frontmatter = cache.frontmatter;
		if (!frontmatter) return;

		for (const pair of this.settings.relations) {
			if (!pair.forward || !pair.inverse) continue;

			const targets = frontmatter[pair.forward];
			if (!targets) continue;

			const targetList = Array.isArray(targets) ? targets : [targets];

			for (const target of targetList) {
				if (typeof target !== "string") continue; // Type safety check

				// Clean regex: removes brackets, aliases (|), and headers (#)
				const cleanName = target.replace(/^\[\[(.*?)\]\]$/, "$1").split("|")[0].split("#")[0];
				const targetFile = this.app.metadataCache.getFirstLinkpathDest(cleanName, file.path);

				if (targetFile instanceof TFile) {
					await this.updateTargetNote(targetFile, pair.inverse, file.basename);
				}
			}
		}
	}

	async updateTargetNote(targetFile: TFile, inverseKey: string, sourceNoteName: string) {
		this.setWritingGuard(targetFile.path);

		try {
			await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
				const sourceLink = `[[${sourceNoteName}]]`;

				if (!fm[inverseKey]) {
					fm[inverseKey] = sourceLink;
				} else if (!fm[inverseKey].includes(sourceLink)) {
					if (typeof fm[inverseKey] === "string") {
						fm[inverseKey] = [fm[inverseKey], sourceLink];
					} else if (Array.isArray(fm[inverseKey])) {
						fm[inverseKey].push(sourceLink);
					}
				}
			});
		} catch (error) {
			// 2. ERROR HANDLING: If the write fails, unlock the file and warn the user
			this.clearWritingGuard(targetFile.path);
			new Notice(`Plugin Error: Could not update ${targetFile.basename}. Check if YAML is valid.`);
			console.error("Compass Sync Error:", error);
		}
	}

	// --- SAFETY HELPERS ---

	private setWritingGuard(path: string) {
		this.writingFiles.add(path);
		// Safety net: Force clear the lock after 3 seconds if the echo never arrives
		const timer = window.setTimeout(() => {
			this.clearWritingGuard(path);
		}, 3000);
		this.writingTimers.set(path, timer);
	}

	private clearWritingGuard(path: string) {
		this.writingFiles.delete(path);
		const timer = this.writingTimers.get(path);
		if (timer) {
			window.clearTimeout(timer);
			this.writingTimers.delete(path);
		}
	}

	// --- SETTINGS ---

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}