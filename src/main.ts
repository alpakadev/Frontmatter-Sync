import { Plugin, TFile, CachedMetadata, Notice } from "obsidian";
import { CompassSyncSettings, DEFAULT_SETTINGS, PendingSync } from "./types";
import { CompassSettingTab } from "./settings";

export default class CompassSyncPlugin extends Plugin {
	settings!: CompassSyncSettings;

	private writingFiles: Set<string> = new Set();
	private writingTimers: Map<string, number> = new Map();

	// FIX: Replaced single timeout ID with a dedicated Map to process simultaneous file events safely
	private changeTimers: Map<string, number> = new Map();

	private prevFm: Map<string, Record<string, any>> = new Map();

	private newFilesQueue: Set<TFile> = new Set();
	private newFilesTimeoutId: number | null = null;

	private vaultReady: boolean = false;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CompassSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) {
					this.prevFm.set(file.path, JSON.parse(JSON.stringify(cache.frontmatter)));
				}
			}

			this.vaultReady = true;

			if (this.settings.notifications.checkOnStartup) {
				const pending = await this.previewBulkSync();
				if (pending.length > 0) {
					this.showUnifiedSyncPrompt(pending, "startup");
				}
			}
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				if (!this.vaultReady) return;

				// FIX: Isolate the debounce timer for each individual file
				const existingTimer = this.changeTimers.get(file.path);
				if (existingTimer) window.clearTimeout(existingTimer);

				const timer = window.setTimeout(() => {
					this.changeTimers.delete(file.path);
					void this.handleFileChange(file, cache);
				}, 300);

				this.changeTimers.set(file.path, timer);
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.vaultReady) return;

				if (file instanceof TFile && file.extension === "md") {
					if (file.basename.startsWith("Untitled")) return;

					this.newFilesQueue.add(file);

					if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);
					this.newFilesTimeoutId = window.setTimeout(() => {
						void this.processNewFilesQueue();
					}, 2000);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!this.vaultReady) return;

				if (file instanceof TFile && file.extension === "md") {
					const cachedFm = this.prevFm.get(oldPath);
					if (cachedFm) {
						this.prevFm.set(file.path, cachedFm);
						this.prevFm.delete(oldPath);
					}

					if (!this.settings.notifications.renameDetection) return;
					if (file.basename.startsWith("Untitled")) return;

					this.newFilesQueue.add(file);

					if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);
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

		// Intercept and fix Obsidian's native, unaliased file updates
		if (await this.enforceAliasFormatting(file, currentFm)) {
			// Deliberately returning without setting the writing guard. 
			// This allows the resulting file save to organically trigger the *next* cycle and process relations safely.
			return;
		}

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

	// --- STRICT LINK PARSING & RESOLUTION ENGINE ---

	private async enforceAliasFormatting(file: TFile, fmData: any): Promise<boolean> {
		if (!this.settings.formatting?.useAliasForPaths) return false;

		let needsUpdate = false;

		for (const group of this.settings.relationGroups) {
			if (!group.enabled) continue;
			for (const pair of group.pairs) {
				if (!pair.enabled) continue;

				const keys = [pair.forward, pair.inverse].filter(Boolean);
				for (const key of keys) {
					const val = fmData[key];
					if (!val) continue;

					const checkStr = (s: string) => {
						const m = s.trim().match(/^\[\[(.*?)\]\]$/);
						// Match any path containing a slash but lacking the alias pipe
						if (m && m[1].includes("/") && !m[1].includes("|")) {
							needsUpdate = true;
						}
					};

					if (Array.isArray(val)) {
						val.forEach(checkStr);
					} else if (typeof val === "string") {
						val.split(",").forEach(checkStr);
					}
				}
			}
		}

		if (!needsUpdate) return false;

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				for (const group of this.settings.relationGroups) {
					if (!group.enabled) continue;
					for (const pair of group.pairs) {
						if (!pair.enabled) continue;
						const keys = [pair.forward, pair.inverse].filter(Boolean);
						for (const key of keys) {
							if (!fm[key]) continue;

							const formatStr = (s: string) => {
								const trimmed = s.trim();
								const m = trimmed.match(/^\[\[(.*?)\]\]$/);
								if (m && m[1].includes("/") && !m[1].includes("|")) {
									const inner = m[1];
									const basename = inner.split("/").pop()?.split("#")[0];
									return `[[${inner}|${basename}]]`;
								}
								return trimmed;
							};

							if (Array.isArray(fm[key])) {
								fm[key] = fm[key].map(formatStr);
							} else if (typeof fm[key] === "string") {
								fm[key] = fm[key].split(",").map(formatStr).join(", ");
							}
						}
					}
				}
			});
		} catch (error) {
			console.error("Error auto-formatting aliases:", error);
		}

		return true;
	}

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

	private getResolvedLinks(value: any, sourcePath: string): { resolved: { raw: string, file: TFile | null }[], invalid: string[] } {
		const links = this.extractLinks(value);
		const resolved = links.valid.map(target => {
			const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
			return { raw: target, file };
		});
		return { resolved, invalid: links.invalid };
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

					const targetsForward = this.getResolvedLinks(previousFm[pair.forward], sourceFile.path);
					for (const target of targetsForward.resolved) {
						if (target.file) {
							const targetFm = this.prevFm.get(target.file.path) || {};
							const inverseLinks = this.getResolvedLinks(targetFm[pair.inverse], target.file.path);

							const hasBacklink = inverseLinks.resolved.some(r => r.file?.path === sourceFile.path);
							if (!hasBacklink) {
								pending.push({
									sourceName: sourceFile.basename,
									sourceFile: sourceFile,
									targetFile: target.file,
									inverseKey: pair.inverse
								});
							}
						}
					}

					if (pair.forward !== pair.inverse) {
						const targetsInverse = this.getResolvedLinks(previousFm[pair.inverse], sourceFile.path);
						for (const target of targetsInverse.resolved) {
							if (target.file) {
								const targetFm = this.prevFm.get(target.file.path) || {};
								const forwardLinks = this.getResolvedLinks(targetFm[pair.forward], target.file.path);

								const hasBacklink = forwardLinks.resolved.some(r => r.file?.path === sourceFile.path);
								if (!hasBacklink) {
									pending.push({
										sourceName: sourceFile.basename,
										sourceFile: sourceFile,
										targetFile: target.file,
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
				sync.targetFile,
				sync.sourceFile,
				sync.inverseKey,
				"add"
			);
		}
		new Notice(`Bulk Sync Complete: Successfully added ${pending.length} missing bidirectional link(s)!`);
	}

	// --- CORE LOGIC & NOTIFICATIONS ---

	private async processRelation(file: TFile, key: string, inverseKey: string, currentFm: any, previousFm: any) {
		const currentLinks = this.getResolvedLinks(currentFm[key], file.path);
		const previousLinks = this.getResolvedLinks(previousFm[key], file.path);

		const addedInvalid = currentLinks.invalid.filter(text => !previousLinks.invalid.includes(text));

		if (this.settings.notifications.plainTextWarning) {
			for (const text of addedInvalid) {
				new Notice(`Relation Sync: "${text}" is plain text. Please use [[${text}]] in property '${key}' to sync.`);
			}
		}

		const added = currentLinks.resolved.filter(curr => {
			if (curr.file) {
				return !previousLinks.resolved.some(prev => prev.file?.path === curr.file!.path);
			} else {
				return !previousLinks.resolved.some(prev => prev.raw === curr.raw);
			}
		});

		const removed = previousLinks.resolved.filter(prev => {
			if (prev.file) {
				return !currentLinks.resolved.some(curr => curr.file?.path === prev.file!.path);
			} else {
				return !currentLinks.resolved.some(curr => curr.raw === prev.raw);
			}
		});

		for (const item of added) {
			await this.modifyTargetNote(item.file || item.raw, file, inverseKey, "add");
		}

		for (const item of removed) {
			await this.modifyTargetNote(item.file || item.raw, file, inverseKey, "remove");
		}
	}

	// --- FILE WRITING & PRESERVING YAML TYPES ---

	private async modifyTargetNote(target: string | TFile, sourceFile: TFile, inverseKey: string, action: "add" | "remove") {
		let targetFile: TFile | null = null;

		if (target instanceof TFile) {
			targetFile = target;
		} else {
			targetFile = this.app.metadataCache.getFirstLinkpathDest(target, sourceFile.path);
		}

		if (!(targetFile instanceof TFile)) {
			if (typeof target === "string" && action === "add" && this.settings.notifications.ghostLinkWarning) {
				new Notice(`Relation Sync: Note "${target}" does not exist yet.`);
			}
			return;
		}

		const linkText = this.app.metadataCache.fileToLinktext(sourceFile, targetFile.path, true);
		let sourceLink = `[[${linkText}]]`;

		if (this.settings.formatting?.useAliasForPaths && linkText !== sourceFile.basename) {
			sourceLink = `[[${linkText}|${sourceFile.basename}]]`;
		}

		this.setWritingGuard(targetFile.path);

		try {
			let didChange = false;

			await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
				const existing = fm[inverseKey];
				const existingArray = Array.isArray(existing) ? existing : (typeof existing === "string" && existing.trim() !== "" ? [existing] : []);

				if (action === "add") {
					let alreadyExists = false;
					for (const rawLink of existingArray) {
						if (typeof rawLink === "string") {
							const parsed = this.parseFrontmatterEntry(rawLink);
							if (parsed.isValid) {
								const dest = this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path);
								if (dest && dest.path === sourceFile.path) {
									alreadyExists = true;
									break;
								}
							}
						}
					}

					if (!alreadyExists) {
						if (fm[inverseKey] === undefined || fm[inverseKey] === null) {
							fm[inverseKey] = [sourceLink];
							didChange = true;
						} else if (Array.isArray(fm[inverseKey])) {
							fm[inverseKey].push(sourceLink);
							didChange = true;
						} else if (typeof fm[inverseKey] === "string") {
							if (fm[inverseKey].trim() === "") {
								fm[inverseKey] = sourceLink;
							} else {
								fm[inverseKey] = `${fm[inverseKey]}, ${sourceLink}`;
							}
							didChange = true;
						}
					}
				}
				else if (action === "remove") {
					if (Array.isArray(fm[inverseKey])) {
						const originalLength = fm[inverseKey].length;
						fm[inverseKey] = fm[inverseKey].filter((rawLink: string) => {
							const parsed = this.parseFrontmatterEntry(rawLink);
							if (parsed.isValid) {
								const dest = this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path);
								if (dest && dest.path === sourceFile.path) return false;
							}
							return rawLink !== sourceLink;
						});
						if (fm[inverseKey].length !== originalLength) didChange = true;
					}
					else if (typeof fm[inverseKey] === "string") {
						const parsed = this.parseFrontmatterEntry(fm[inverseKey]);
						let shouldRemove = false;
						if (parsed.isValid) {
							const dest = this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path);
							if (dest && dest.path === sourceFile.path) shouldRemove = true;
						}

						if (shouldRemove) {
							fm[inverseKey] = "";
							didChange = true;
						} else {
							let cleanedStr = fm[inverseKey].replace(sourceLink, "");
							cleanedStr = cleanedStr.replace(/,\s*,/g, ",").replace(/^,\s*|\s*,$/g, "").trim();
							if (cleanedStr !== fm[inverseKey]) {
								fm[inverseKey] = cleanedStr;
								didChange = true;
							}
						}
					}
				}
			});

			if (didChange && this.settings.notifications.backgroundSync) {
				new Notice(`Relation Sync: Updated background note "${targetFile.basename}"`);
			}
		} catch (error) {
			this.clearWritingGuard(targetFile.path);
			new Notice(`Error syncing to ${targetFile?.basename || target}`);
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

		const pendingSyncs: PendingSync[] = [];

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
						const isForwardMatch = targetsForward.valid.some(raw => raw === newFile.basename || this.app.metadataCache.getFirstLinkpathDest(raw, sourceFile.path)?.path === newFile.path);
						const isInverseMatch = targetsInverse.valid.some(raw => raw === newFile.basename || this.app.metadataCache.getFirstLinkpathDest(raw, sourceFile.path)?.path === newFile.path);

						if (isForwardMatch) {
							pendingSyncs.push({
								sourceName: sourceFile.basename,
								sourceFile,
								targetFile: newFile,
								inverseKey: pair.inverse
							});
						}
						if (isInverseMatch) {
							pendingSyncs.push({
								sourceName: sourceFile.basename,
								sourceFile,
								targetFile: newFile,
								inverseKey: pair.forward
							});
						}
					}
				}
			}
		}

		if (pendingSyncs.length > 0) {
			this.showUnifiedSyncPrompt(pendingSyncs, "new_files", filesToProcess.length);
		}
	}

	private showUnifiedSyncPrompt(pendingSyncs: PendingSync[], context: "startup" | "new_files", fileCount: number = 0) {
		const notice = new Notice("", 0);
		notice.noticeEl.empty();

		let message = "";
		if (context === "startup") {
			message = `Relation Sync: Startup scan found ${pendingSyncs.length} pending backlink(s).`;
		} else {
			const fileText = fileCount === 1 ? "1 new file" : `${fileCount} new/modified files`;
			message = `Relation Sync: Detected ${fileText} with ${pendingSyncs.length} pending backlink(s).`;
		}

		notice.noticeEl.createDiv({
			text: message,
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
					sync.targetFile,
					sync.sourceFile,
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
		this.settings.formatting = Object.assign({}, DEFAULT_SETTINGS.formatting, loadedData?.formatting);

		if (this.settings.relations && this.settings.relations.length > 0) {
			this.settings.relationGroups = [{
				name: "Imported Pairs",
				enabled: true,
				isCollapsed: false,
				pairs: this.settings.relations
			}];
			delete this.settings.relations;
			await this.saveSettings();
		}

		if (!this.settings.relationGroups) this.settings.relationGroups = [];
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}