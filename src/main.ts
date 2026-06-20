import { Plugin, TFile, CachedMetadata, Notice } from "obsidian";
import { CompassSyncSettings, DEFAULT_SETTINGS, PendingSync } from "./types";
import { CompassSettingTab } from "./settings";

export default class CompassSyncPlugin extends Plugin {
	settings!: CompassSyncSettings;

	private writingFiles: Set<string> = new Set();
	private writingTimers: Map<string, number> = new Map();
	private timeoutId: number | null = null;
	private prevFm: Map<string, Record<string, any>> = new Map();

	// Queue system for mitigating notification spam
	private newFilesQueue: Set<TFile> = new Set();
	private newFilesTimeoutId: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CompassSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) {
					this.prevFm.set(file.path, JSON.parse(JSON.stringify(cache.frontmatter)));
				}
			}
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				if (this.timeoutId !== null) window.clearTimeout(this.timeoutId);
				this.timeoutId = window.setTimeout(() => {
					void this.handleFileChange(file, cache);
				}, 300);
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.newFilesQueue.add(file);

					if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);
					// Debounce for 2 seconds to catch bulk cloud/git syncs
					this.newFilesTimeoutId = window.setTimeout(() => {
						void this.processNewFilesQueue();
					}, 2000);
				}
			})
		);
	}

	async handleFileChange(file: TFile, cache: CachedMetadata) {
		if (this.writingFiles.has(file.path)) {
			this.clearWritingGuard(file.path);
			this.prevFm.set(file.path, JSON.parse(JSON.stringify(cache.frontmatter || {})));
			return;
		}

		const currentFm = cache.frontmatter || {};
		const previousFm = this.prevFm.get(file.path) || {};

		for (const group of this.settings.relationGroups) {
			if (!group.enabled) continue;
			for (const pair of group.pairs) {
				if (!pair.enabled || !pair.forward || !pair.inverse) continue;

				await this.processRelation(file, pair.forward, pair.inverse, currentFm, previousFm);

				if (pair.forward !== pair.inverse) {
					await this.processRelation(file, pair.inverse, pair.forward, currentFm, previousFm);
				}
			}
		}

		this.prevFm.set(file.path, JSON.parse(JSON.stringify(currentFm)));
	}

	// --- BULK SYNC ENGINE ---

	async previewBulkSync(): Promise<PendingSync[]> {
		const pending: PendingSync[] = [];

		for (const [sourcePath, previousFm] of this.prevFm.entries()) {
			const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile)) continue;

			for (const group of this.settings.relationGroups) {
				if (!group.enabled) continue;

				for (const pair of group.pairs) {
					if (!pair.enabled || !pair.forward || !pair.inverse) continue;

					// 1. Scan Forward -> Inverse
					const targetsForward = this.extractLinks(previousFm[pair.forward]);
					for (const targetName of targetsForward.valid) {
						const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, sourceFile.path);
						if (targetFile instanceof TFile) {
							const targetFm = this.prevFm.get(targetFile.path) || {};
							const inverseLinks = this.extractLinks(targetFm[pair.inverse]);

							if (!inverseLinks.valid.includes(sourceFile.basename)) {
								pending.push({
									sourceName: sourceFile.basename,
									sourceFile: sourceFile,
									targetFile: targetFile,
									inverseKey: pair.inverse
								});
							}
						}
					}

					// 2. Scan Inverse -> Forward
					if (pair.forward !== pair.inverse) {
						const targetsInverse = this.extractLinks(previousFm[pair.inverse]);
						for (const targetName of targetsInverse.valid) {
							const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, sourceFile.path);
							if (targetFile instanceof TFile) {
								const targetFm = this.prevFm.get(targetFile.path) || {};
								const forwardLinks = this.extractLinks(targetFm[pair.forward]);

								if (!forwardLinks.valid.includes(sourceFile.basename)) {
									pending.push({
										sourceName: sourceFile.basename,
										sourceFile: sourceFile,
										targetFile: targetFile,
										inverseKey: pair.forward
									});
								}
							}
						}
					}
				}
			}
		}
		return pending;
	}

	async executeBulkSync(pending: PendingSync[]) {
		for (const sync of pending) {
			await this.modifyTargetNote(
				sync.targetFile.basename,
				sync.sourceFile,
				sync.sourceName,
				sync.inverseKey,
				"add"
			);
		}
		new Notice(`Bulk Sync Complete: Successfully added ${pending.length} missing bidirectional link(s)!`);
	}

	// --- STRICT LINK PARSING ---

	private parseFrontmatterEntry(value: string): { isValid: boolean, target: string } {
		const trimmed = value.trim();
		if (!trimmed) return { isValid: false, target: "" };

		const wikiMatch = trimmed.match(/^\[\[(.*?)\]\]$/);
		if (wikiMatch) {
			const cleanName = wikiMatch[1].split("|")[0].split("#")[0].trim();
			return { isValid: true, target: cleanName };
		}

		const mdMatch = trimmed.match(/^\[(.*?)\]\((.*?)\)$/);
		if (mdMatch) {
			let linkPath = mdMatch[2];
			linkPath = decodeURIComponent(linkPath).replace(/\.md$/i, "").split("#")[0].trim();
			return { isValid: true, target: linkPath };
		}

		return { isValid: false, target: trimmed };
	}

	private extractLinks(value: any): { valid: string[], invalid: string[] } {
		if (!value) return { valid: [], invalid: [] };
		const arr = Array.isArray(value) ? value : [value];

		const valid: string[] = [];
		const invalid: string[] = [];

		for (const item of arr) {
			if (typeof item === "string") {
				const parsed = this.parseFrontmatterEntry(item);
				if (parsed.isValid && parsed.target) {
					valid.push(parsed.target);
				} else if (!parsed.isValid && parsed.target) {
					invalid.push(parsed.target);
				}
			}
		}
		return { valid, invalid };
	}

	// --- CORE LOGIC & NOTIFICATIONS ---

	private async processRelation(file: TFile, key: string, inverseKey: string, currentFm: any, previousFm: any) {
		const current = this.extractLinks(currentFm[key]);
		const previous = this.extractLinks(previousFm[key]);

		const addedInvalid = current.invalid.filter(text => !previous.invalid.includes(text));

		if (this.settings.notifications.plainTextWarning) {
			for (const text of addedInvalid) {
				new Notice(`Relation Sync: "${text}" is plain text. Please use [[${text}]] in property '${key}' to sync.`);
			}
		}

		const added = current.valid.filter(target => !previous.valid.includes(target));
		const removed = previous.valid.filter(target => !current.valid.includes(target));

		for (const target of added) {
			await this.modifyTargetNote(target, file, file.basename, inverseKey, "add");
		}

		for (const target of removed) {
			await this.modifyTargetNote(target, file, file.basename, inverseKey, "remove");
		}
	}

	// --- FILE WRITING & PRESERVING YAML TYPES ---

	private async modifyTargetNote(targetName: string, sourceFile: TFile, sourceNoteName: string, inverseKey: string, action: "add" | "remove") {
		const targetFile = this.app.metadataCache.getFirstLinkpathDest(targetName, sourceFile.path);

		if (!(targetFile instanceof TFile)) {
			if (action === "add" && this.settings.notifications.ghostLinkWarning) {
				new Notice(`Relation Sync: Note "${targetName}" does not exist yet.`);
			}
			return;
		}

		this.setWritingGuard(targetFile.path);

		try {
			let didChange = false;

			await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
				const sourceLink = `[[${sourceNoteName}]]`;

				if (action === "add") {
					if (fm[inverseKey] === undefined || fm[inverseKey] === null) {
						fm[inverseKey] = [sourceLink];
						didChange = true;
					}
					else if (Array.isArray(fm[inverseKey])) {
						if (!fm[inverseKey].includes(sourceLink)) {
							fm[inverseKey].push(sourceLink);
							didChange = true;
						}
					}
					else if (typeof fm[inverseKey] === "string") {
						if (fm[inverseKey].trim() === "") {
							fm[inverseKey] = sourceLink;
							didChange = true;
						} else if (!fm[inverseKey].includes(sourceLink)) {
							fm[inverseKey] = `${fm[inverseKey]}, ${sourceLink}`;
							didChange = true;
						}
					}
				}
				else if (action === "remove") {
					if (Array.isArray(fm[inverseKey])) {
						const originalLength = fm[inverseKey].length;
						fm[inverseKey] = fm[inverseKey].filter((link: string) => link !== sourceLink);
						if (fm[inverseKey].length !== originalLength) didChange = true;
					}
					else if (typeof fm[inverseKey] === "string" && fm[inverseKey].includes(sourceLink)) {
						let cleanedStr = fm[inverseKey].replace(sourceLink, "");
						cleanedStr = cleanedStr.replace(/,\s*,/g, ",").replace(/^,\s*|\s*,$/g, "").trim();
						fm[inverseKey] = cleanedStr;
						didChange = true;
					}
				}
			});

			if (didChange && this.settings.notifications.backgroundSync) {
				new Notice(`Relation Sync: Updated background note "${targetFile.basename}"`);
			}
		} catch (error) {
			this.clearWritingGuard(targetFile.path);
			new Notice(`Error syncing to ${targetFile.basename}`);
			console.error(error);
		}
	}

	// --- GHOST LINK QUEUE RESOLUTION ---

	async processNewFilesQueue() {
		if (!this.settings.notifications.ghostLinkPrompt) {
			this.newFilesQueue.clear();
			return;
		}

		const filesToProcess = Array.from(this.newFilesQueue);
		this.newFilesQueue.clear();
		if (filesToProcess.length === 0) return;

		const pendingSyncs: { targetFile: TFile, sourceFile: TFile; inverseKey: string }[] = [];

		for (const [sourcePath, previousFm] of this.prevFm.entries()) {
			const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile)) continue;

			for (const group of this.settings.relationGroups) {
				if (!group.enabled) continue;
				for (const pair of group.pairs) {
					if (!pair.enabled || !pair.forward || !pair.inverse) continue;

					const targetsForward = this.extractLinks(previousFm[pair.forward]);
					const targetsInverse = pair.forward !== pair.inverse ? this.extractLinks(previousFm[pair.inverse]) : { valid: [], invalid: [] };

					for (const newFile of filesToProcess) {
						if (targetsForward.valid.includes(newFile.basename)) {
							pendingSyncs.push({ targetFile: newFile, sourceFile, inverseKey: pair.inverse });
						}
						if (targetsInverse.valid.includes(newFile.basename)) {
							pendingSyncs.push({ targetFile: newFile, sourceFile, inverseKey: pair.forward });
						}
					}
				}
			}
		}

		if (pendingSyncs.length > 0) {
			this.showUnifiedSyncPrompt(pendingSyncs, filesToProcess.length);
		}
	}

	private showUnifiedSyncPrompt(pendingSyncs: any[], fileCount: number) {
		const notice = new Notice("", 0);
		notice.noticeEl.empty();

		const fileText = fileCount === 1 ? "1 new file" : `${fileCount} new/modified files`;

		notice.noticeEl.createDiv({
			text: `Relation Sync: Detected ${fileText} with ${pendingSyncs.length} pending backlink(s).`,
			attr: { style: "margin-bottom: 12px; font-weight: 500;" }
		});

		const btnContainer = notice.noticeEl.createDiv({
			attr: { style: "display: flex; gap: 8px; justify-content: flex-end;" }
		});

		const syncBtn = btnContainer.createEl("button", {
			text: "Sync All",
			cls: "mod-cta"
		});

		const ignoreBtn = btnContainer.createEl("button", {
			text: "Ignore All"
		});

		ignoreBtn.onclick = () => {
			notice.hide();
		};

		syncBtn.onclick = async () => {
			syncBtn.innerText = "Syncing...";
			syncBtn.disabled = true;
			ignoreBtn.disabled = true;

			for (const sync of pendingSyncs) {
				await this.modifyTargetNote(
					sync.targetFile.basename,
					sync.sourceFile,
					sync.sourceFile.basename,
					sync.inverseKey,
					"add"
				);
			}

			notice.hide();

			if (this.settings.notifications.backgroundSync) {
				new Notice(`Successfully synced ${pendingSyncs.length} relation(s)!`);
			}
		};
	}

	// --- SAFETY HELPERS ---

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
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		this.settings.notifications = Object.assign({}, DEFAULT_SETTINGS.notifications, loadedData?.notifications);

		// Migration handling for older flat structures
		if (this.settings.relations && this.settings.relations.length > 0) {
			this.settings.relationGroups = [{
				name: "Imported Pairs",
				enabled: true,
				pairs: this.settings.relations
			}];
			delete this.settings.relations;
			await this.saveSettings();
		}

		// Ensure arrays and objects exist
		if (!this.settings.relationGroups) this.settings.relationGroups = [];
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}