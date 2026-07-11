import { Plugin, TFile, TFolder, TAbstractFile, CachedMetadata, Notice } from "obsidian";
import { CompassSyncSettings, DEFAULT_SETTINGS, PendingSync } from "./types";
import { CompassSettingTab } from "./settings";
import { LinkService } from "./LinkService";
import { SyncService } from "./SyncService";
import { TIMERS } from "./constants";

export default class CompassSyncPlugin extends Plugin {
	settings!: CompassSyncSettings;

	private linkService!: LinkService;
	public syncService!: SyncService;

	private changeTimers = new Map<string, number>();
	private prevFm = new Map<string, Record<string, unknown>>();

	private newFilesQueue = new Set<TFile>();
	private newFilesTimeoutId: number | null = null;
	private vaultReady = false;

	async onload() {
		await this.loadSettings();

		this.linkService = new LinkService(this.app);
		this.syncService = new SyncService(this.app, this.settings, this.linkService);

		this.addSettingTab(new CompassSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => this.initializeCache());
		this.registerVaultEvents();
	}

	onunload() {
		this.changeTimers.forEach(timer => window.clearTimeout(timer));
		if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);
		this.syncService.clearAllGuards();
		this.changeTimers.clear();
		this.prevFm.clear();
		this.newFilesQueue.clear();
	}

	private async initializeCache() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				this.prevFm.set(file.path, this.syncService.getTrackedFrontmatter(cache.frontmatter));
			}
		}

		this.vaultReady = true;

		if (this.settings.notifications.checkOnStartup) {
			const pending = await this.syncService.previewBulkSync(this.prevFm);
			if (pending.length > 0) this.showUnifiedSyncPrompt(pending, "startup");
		}
	}

	private registerVaultEvents() {
		this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => this.debounceFileChange(file, cache)));
		this.registerEvent(this.app.vault.on("create", (file) => this.handleCreation(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDeletion(file)));
	}

	private debounceFileChange(file: TFile, cache: CachedMetadata) {
		if (!this.vaultReady) return;

		const existingTimer = this.changeTimers.get(file.path);
		if (existingTimer) window.clearTimeout(existingTimer);

		const timer = window.setTimeout(() => {
			this.changeTimers.delete(file.path);
			void this.handleFileChange(file, cache);
		}, TIMERS.FILE_CHANGE_DEBOUNCE_MS);

		this.changeTimers.set(file.path, timer);
	}

	private async handleFileChange(file: TFile, cache: CachedMetadata) {
		if (this.syncService.isWriting(file.path)) {
			this.syncService.clearWritingGuard(file.path);
			this.prevFm.set(file.path, this.syncService.getTrackedFrontmatter(cache.frontmatter));
			return;
		}

		const currentFm = (cache.frontmatter || {}) as Record<string, unknown>;
		if (await this.syncService.enforceAliasFormatting(file, currentFm)) return;

		const previousFm = this.prevFm.get(file.path) || {};

		for (const group of this.settings.relationGroups) {
			if (!group.enabled) continue;
			for (const pair of group.pairs) {
				for (const dir of this.syncService.getDirections(pair)) {
					await this.syncService.processRelation(file, dir.from, dir.to, currentFm, previousFm);
				}
			}
		}

		this.prevFm.set(file.path, this.syncService.getTrackedFrontmatter(currentFm));
	}

	private handleCreation(file: TAbstractFile) {
		if (!this.vaultReady || !(file instanceof TFile) || file.extension !== "md" || file.basename.startsWith("Untitled")) return;

		this.newFilesQueue.add(file);
		if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);

		this.newFilesTimeoutId = window.setTimeout(() => {
			void this.processNewFilesQueue();
		}, TIMERS.NEW_FILE_QUEUE_DELAY_MS);
	}

	private handleRename(file: TAbstractFile, oldPath: string) {
		if (!this.vaultReady) return;

		if (file instanceof TFile && file.extension === "md") {
			const cachedFm = this.prevFm.get(oldPath);
			if (cachedFm) {
				this.prevFm.set(file.path, cachedFm);
				this.prevFm.delete(oldPath);
			}

			if (this.settings.notifications.renameDetection && !file.basename.startsWith("Untitled")) {
				this.handleCreation(file);
			}
		} else if (file instanceof TFolder) {
			for (const [oldKey, cachedFm] of Array.from(this.prevFm.entries())) {
				if (oldKey.startsWith(oldPath + "/")) {
					this.prevFm.set(oldKey.replace(oldPath, file.path), cachedFm);
					this.prevFm.delete(oldKey);
				}
			}
		}
	}

	private handleDeletion(file: TAbstractFile) {
		if (file instanceof TFile) {
			this.prevFm.delete(file.path);
			this.syncService.clearWritingGuard(file.path);
			this.newFilesQueue.delete(file);
			this.clearChangeTimer(file.path);
		} else if (file instanceof TFolder) {
			for (const key of Array.from(this.prevFm.keys())) {
				if (key.startsWith(file.path + "/")) {
					this.prevFm.delete(key);
					this.syncService.clearWritingGuard(key);
					this.clearChangeTimer(key);
				}
			}
		}
	}

	private clearChangeTimer(path: string) {
		const changeTimer = this.changeTimers.get(path);
		if (changeTimer) {
			window.clearTimeout(changeTimer);
			this.changeTimers.delete(path);
		}
	}

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
					for (const dir of this.syncService.getDirections(pair)) {
						const targets = this.linkService.extractLinks(previousFm[dir.from]);

						for (const newFile of filesToProcess) {
							const isMatch = targets.valid.some(raw => raw === newFile.basename || this.app.metadataCache.getFirstLinkpathDest(raw, sourceFile.path)?.path === newFile.path);
							if (isMatch) pendingSyncs.push({ sourceName: sourceFile.basename, sourceFile, targetFile: newFile, inverseKey: dir.to });
						}
					}
				}
			}
		}

		if (pendingSyncs.length > 0) this.showUnifiedSyncPrompt(pendingSyncs, "new_files", filesToProcess.length);
	}

	private showUnifiedSyncPrompt(pendingSyncs: PendingSync[], context: "startup" | "new_files", fileCount: number = 0) {
		const notice = new Notice("", 0);
		notice.noticeEl.empty();

		const message = context === "startup"
			? `Relation Sync: Startup scan found ${pendingSyncs.length} pending backlink(s).`
			: `Relation Sync: Detected ${fileCount === 1 ? "1 new file" : `${fileCount} new/modified files`} with ${pendingSyncs.length} pending backlink(s).`;

		notice.noticeEl.createDiv({ text: message, attr: { style: "margin-bottom: 12px; font-weight: 500;" } });

		const btnContainer = notice.noticeEl.createDiv({ attr: { style: "display: flex; gap: 8px; justify-content: flex-end;" } });
		const syncBtn = btnContainer.createEl("button", { text: "Sync All", cls: "mod-cta" });
		const ignoreBtn = btnContainer.createEl("button", { text: "Ignore All" });

		ignoreBtn.onclick = () => notice.hide();
		syncBtn.onclick = async () => {
			syncBtn.innerText = "Syncing...";
			syncBtn.disabled = true;
			ignoreBtn.disabled = true;

			for (const sync of pendingSyncs) {
				await this.syncService.modifyTargetNote(sync.targetFile, sync.sourceFile, sync.inverseKey, "add");
			}

			notice.hide();
			if (this.settings.notifications.backgroundSync) new Notice(`Successfully synced ${pendingSyncs.length} relation(s)!`);
		};
	}

	async loadSettings() {
		const loadedData = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		this.settings.notifications = Object.assign({}, DEFAULT_SETTINGS.notifications, loadedData?.notifications);
		this.settings.formatting = Object.assign({}, DEFAULT_SETTINGS.formatting, loadedData?.formatting);
		if (!this.settings.relationGroups) this.settings.relationGroups = [];
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}