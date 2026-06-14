import { Plugin, TFile, CachedMetadata, Notice } from "obsidian";
import { CompassSyncSettings, DEFAULT_SETTINGS } from "./types";
import { CompassSettingTab } from "./settings"; // Ensure you still have this file!

export default class CompassSyncPlugin extends Plugin {
	settings!: CompassSyncSettings;

	private writingFiles: Set<string> = new Set();
	private writingTimers: Map<string, number> = new Map();
	private timeoutId: number | null = null;

	// Memory cache to detect deletions!
	private prevFm: Map<string, Record<string, any>> = new Map();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CompassSettingTab(this.app, this));

		// When Obsidian starts, take a quick snapshot of all files
		this.app.workspace.onLayoutReady(() => {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) {
					// JSON parse/stringify is a safe way to deep copy the YAML data
					this.prevFm.set(file.path, JSON.parse(JSON.stringify(cache.frontmatter)));
				}
			}
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				if (this.timeoutId !== null) window.clearTimeout(this.timeoutId);
				this.timeoutId = window.setTimeout(() => {
					void this.handleFileChange(file, cache);
				}, 300); // 300ms debounce
			})
		);
	}

	async handleFileChange(file: TFile, cache: CachedMetadata) {
		// If the plugin wrote this change, clear the lock and update our memory snapshot
		if (this.writingFiles.has(file.path)) {
			this.clearWritingGuard(file.path);
			this.prevFm.set(file.path, JSON.parse(JSON.stringify(cache.frontmatter || {})));
			return;
		}

		const currentFm = cache.frontmatter || {};
		const previousFm = this.prevFm.get(file.path) || {};

		for (const pair of this.settings.relations) {
			if (!pair.forward || !pair.inverse) continue;

			// 1. Process Forward -> Inverse (e.g., South updates North)
			await this.processRelation(file, pair.forward, pair.inverse, currentFm, previousFm);

			// 2. Process Inverse -> Forward (e.g., North updates South)
			await this.processRelation(file, pair.inverse, pair.forward, currentFm, previousFm);
		}

		// Update memory for the next time the user types
		this.prevFm.set(file.path, JSON.parse(JSON.stringify(currentFm)));
	}

	// --- CORE LOGIC: DIFFING ADDITIONS AND DELETIONS ---

	private async processRelation(file: TFile, key: string, inverseKey: string, currentFm: any, previousFm: any) {
		const currentTargets = this.extractCleanLinks(currentFm[key]);
		const previousTargets = this.extractCleanLinks(previousFm[key]);

		// Diffing: Find what was added and what was removed
		const added = currentTargets.filter(target => !previousTargets.includes(target));
		const removed = previousTargets.filter(target => !currentTargets.includes(target));

		for (const target of added) {
			await this.modifyTargetNote(target, file, file.basename, inverseKey, "add");
		}

		for (const target of removed) {
			await this.modifyTargetNote(target, file, file.basename, inverseKey, "remove");
		}
	}

	// Parses frontmatter values into a clean array of file names
	private extractCleanLinks(value: any): string[] {
		if (!value) return [];
		const arr = Array.isArray(value) ? value : [value];
		const links: string[] = [];

		for (const item of arr) {
			if (typeof item === "string") {
				// Remove Wiki brackets [[ ]], aliases |, and headers #
				let cleanName = item.replace(/^\[\[(.*?)\]\]$/, "$1").split("|")[0].split("#")[0].trim();
				if (cleanName) links.push(cleanName);
			}
		}
		return links;
	}

	// --- FILE WRITING & PRESERVING YAML TYPES ---

	private async modifyTargetNote(targetName: string, sourceFile: TFile, sourceNoteName: string, inverseKey: string, action: "add" | "remove") {
		const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, sourceFile.path);
		if (!(targetFile instanceof TFile)) return;

		this.setWritingGuard(targetFile.path);

		try {
			let didChange = false;

			await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
				const sourceLink = `[[${sourceNoteName}]]`;

				if (action === "add") {
					// If property doesn't exist, create it AS A LIST natively
					if (fm[inverseKey] === undefined || fm[inverseKey] === null) {
						fm[inverseKey] = [sourceLink];
						didChange = true;
					}
					// If it's already a list, append to it
					else if (Array.isArray(fm[inverseKey])) {
						if (!fm[inverseKey].includes(sourceLink)) {
							fm[inverseKey].push(sourceLink);
							didChange = true;
						}
					}
					// If it's a string, convert to list so it scales
					else if (typeof fm[inverseKey] === "string" && !fm[inverseKey].includes(sourceLink)) {
						fm[inverseKey] = fm[inverseKey].trim() === "" ? [sourceLink] : [fm[inverseKey], sourceLink];
						didChange = true;
					}
				}

				else if (action === "remove") {
					if (Array.isArray(fm[inverseKey])) {
						const originalLength = fm[inverseKey].length;
						// Filter out the link
						fm[inverseKey] = fm[inverseKey].filter((link: string) => link !== sourceLink);
						if (fm[inverseKey].length !== originalLength) didChange = true;
						// Notice we DO NOT delete the key if the array is empty. It stays `[]`.
					}
					else if (typeof fm[inverseKey] === "string" && fm[inverseKey].includes(sourceLink)) {
						fm[inverseKey] = ""; // Keep the property, but empty the string
						didChange = true;
					}
				}
			});

			// NOTIFICATION: Tell the user a background sync occurred
			if (didChange) {
				new Notice(`Relation Sync: Updated background note "${targetFile.basename}"`);
			}
		} catch (error) {
			this.clearWritingGuard(targetFile.path);
			new Notice(`Error syncing to ${targetFile.basename}`);
			console.error(error);
		}
	}

	// --- SAFETY HELPERS & SAVING ---

	private setWritingGuard(path: string) {
		this.writingFiles.add(path);
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}