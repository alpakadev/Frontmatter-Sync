import { Plugin, TFile, TFolder, TAbstractFile, CachedMetadata, Notice } from "obsidian";
import { FrontmatterSyncSettings, DEFAULT_SETTINGS, PendingSync } from "./types";
import { FrontmatterSyncSettingTab } from "./settings";
import { LinkService } from "./LinkService";
import { SyncService } from "./SyncService";
import { TIMERS } from "./constants";
import { hasUnreadableFrontmatter } from "./frontmatter";

export default class FrontmatterSyncPlugin extends Plugin {
	settings!: FrontmatterSyncSettings;

	private linkService!: LinkService;
	public syncService!: SyncService;

	private changeTimers = new Map<string, number>();
	private prevFm = new Map<string, Record<string, unknown>>();

	private newFilesQueue = new Set<TFile>();
	private newFilesTimeoutId: number | null = null;
	private indexRetries = new Map<string, number>();
	private vaultReady = false;

	private trackedKeys = new Set<string>();
	private snapshotTimeoutId: number | null = null;

	async onload() {
		await this.loadSettings();

		this.linkService = new LinkService(this.app);
		this.syncService = new SyncService(this.app, this.settings, this.linkService);

		this.addSettingTab(new FrontmatterSyncSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => this.initializeCache());
		this.registerVaultEvents();
	}

	onunload() {
		this.changeTimers.forEach(timer => window.clearTimeout(timer));
		if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);
		if (this.snapshotTimeoutId !== null) window.clearTimeout(this.snapshotTimeoutId);
		this.syncService.clearAllGuards();
		this.changeTimers.clear();
		this.prevFm.clear();
		this.newFilesQueue.clear();
		this.indexRetries.clear();
	}

	private async initializeCache() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				this.prevFm.set(file.path, this.syncService.getTrackedFrontmatter(cache.frontmatter));
			}
		}

		this.trackedKeys = this.syncService.getTrackedKeys();
		this.vaultReady = true;

		if (this.settings.notifications.checkOnStartup) {
			const pending = await this.syncService.previewBulkSync();
			if (pending.length > 0) await this.handlePendingSyncs(pending, "startup");
		}
	}

	private registerVaultEvents() {
		this.registerEvent(this.app.metadataCache.on("changed", (file, data, cache) => this.debounceFileChange(file, data, cache)));
		this.registerEvent(this.app.vault.on("create", (file) => this.handleCreation(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDeletion(file)));
	}

	private debounceFileChange(file: TFile, data: string, cache: CachedMetadata) {
		if (!this.vaultReady) {
			if (cache?.frontmatter) {
				this.prevFm.set(file.path, this.syncService.getTrackedFrontmatter(cache.frontmatter));
			}
			return;
		}

		// Settings saved since the last refresh apply to this change too.
		if (this.snapshotTimeoutId !== null) this.refreshSnapshots();

		const existingTimer = this.changeTimers.get(file.path);
		if (existingTimer) window.clearTimeout(existingTimer);

		const timer = window.setTimeout(() => {
			this.changeTimers.delete(file.path);
			void this.handleFileChange(file, data, cache);
		}, TIMERS.FILE_CHANGE_DEBOUNCE_MS);

		this.changeTimers.set(file.path, timer);
	}

	private async handleFileChange(file: TFile, data: string, cache: CachedMetadata) {
		const currentFm = (cache.frontmatter || {}) as Record<string, unknown>;

		if (this.syncService.isWriting(file.path)) {
			if (this.syncService.matchesExpectedState(file.path, currentFm)) {
				this.syncService.clearWritingGuard(file.path);
			} else {
				return; // Intermediate write state, abort and wait for exact match.
			}
		}

		const previousFm = this.prevFm.get(file.path) || {};

		// Broken YAML would otherwise read as "every link removed" and strip all backlinks.
		// Keep the last good snapshot and wait for the next readable save.
		if (!cache.frontmatter && Object.keys(previousFm).length > 0 && hasUnreadableFrontmatter(data)) return;

		if (await this.syncService.enforceAliasFormatting(file, currentFm)) return;

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

	// Notes are only snapshotted for the properties configured at the time. When a pair is
	// added, enabled or renamed, record the current values of its keys, so the next edit
	// diffs against them and removed links are propagated. Keys tracked before keep their
	// snapshot, so changes still waiting to be processed are not lost.
	public refreshSnapshots() {
		if (this.snapshotTimeoutId !== null) {
			window.clearTimeout(this.snapshotTimeoutId);
			this.snapshotTimeoutId = null;
		}
		if (!this.vaultReady) return;

		const keys = this.syncService.getTrackedKeys();
		const newKeys = Array.from(keys).filter(key => !this.trackedKeys.has(key));
		this.trackedKeys = keys;
		if (newKeys.length === 0) return;

		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;

			const snapshot = this.prevFm.get(file.path) ?? {};
			for (const key of newKeys) {
				if (fm[key] !== undefined) snapshot[key] = structuredClone(fm[key]);
				else delete snapshot[key];
			}
			this.prevFm.set(file.path, snapshot);
		}
	}

	private scheduleSnapshotRefresh() {
		if (this.snapshotTimeoutId !== null) window.clearTimeout(this.snapshotTimeoutId);
		this.snapshotTimeoutId = window.setTimeout(() => this.refreshSnapshots(), TIMERS.SNAPSHOT_REFRESH_DELAY_MS);
	}

	private handleCreation(file: TAbstractFile) {
		if (!this.vaultReady || !(file instanceof TFile) || file.extension !== "md" || file.basename.startsWith("Untitled")) return;

		this.newFilesQueue.add(file);
		this.scheduleNewFilesQueue();
	}

	private scheduleNewFilesQueue() {
		if (this.newFilesTimeoutId !== null) window.clearTimeout(this.newFilesTimeoutId);

		this.newFilesTimeoutId = window.setTimeout(() => {
			this.newFilesTimeoutId = null;
			void this.processNewFilesQueue();
		}, TIMERS.NEW_FILE_QUEUE_DELAY_MS);
	}

	// Files Obsidian has not indexed yet look like they have no backlinks. Hold them back
	// for another round so a burst of pulled notes is judged on their real frontmatter.
	private takeIndexedFiles(): TFile[] {
		const queued = Array.from(this.newFilesQueue);
		this.newFilesQueue.clear();
		if (!this.settings.notifications.verifyBeforePrompt) return queued;

		const ready: TFile[] = [];
		for (const file of queued) {
			const retries = this.indexRetries.get(file.path) ?? 0;
			if (this.app.metadataCache.getFileCache(file) || retries >= TIMERS.NEW_FILE_INDEX_MAX_RETRIES) {
				this.indexRetries.delete(file.path);
				ready.push(file);
			} else {
				this.indexRetries.set(file.path, retries + 1);
				this.newFilesQueue.add(file);
			}
		}
		if (this.newFilesQueue.size > 0) this.scheduleNewFilesQueue();
		return ready;
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
			this.indexRetries.delete(file.path);
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
		const { ghostLinkPrompt, autoSync } = this.settings.notifications;
		if (!ghostLinkPrompt && !autoSync) {
			this.newFilesQueue.clear();
			this.indexRetries.clear();
			return;
		}

		const filesToProcess = this.takeIndexedFiles();
		if (filesToProcess.length === 0) return;

		const pendingSyncs: PendingSync[] = [];

		// Read live metadata rather than the change snapshot, which only holds the
		// properties that were configured when Obsidian started.
		for (const sourceFile of this.app.vault.getMarkdownFiles()) {
			// Fall back to the last good snapshot while a note's YAML can't be parsed.
			const sourceFm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter ?? this.prevFm.get(sourceFile.path);
			if (!sourceFm) continue;

			for (const group of this.settings.relationGroups) {
				if (!group.enabled) continue;
				for (const pair of group.pairs) {
					for (const dir of this.syncService.getDirections(pair)) {
						const targets = this.linkService.extractLinks(sourceFm[dir.from]);

						for (const newFile of filesToProcess) {
							// Match by resolved path only: another note can share the new file's name.
							const isMatch = targets.valid.some(raw => this.app.metadataCache.getFirstLinkpathDest(raw, sourceFile.path)?.path === newFile.path);
							if (isMatch) pendingSyncs.push({ sourceName: sourceFile.basename, sourceFile, targetFile: newFile, inverseKey: dir.to });
						}
					}
				}
			}
		}

		const pending = this.syncService.filterUnsynced(pendingSyncs);
		if (pending.length > 0) await this.handlePendingSyncs(pending, "new_files", filesToProcess.length);
	}

	private async handlePendingSyncs(pending: PendingSync[], context: "startup" | "new_files", fileCount: number = 0) {
		if (this.settings.notifications.autoSync) {
			await this.syncService.applyPendingSyncs(pending);
			return;
		}
		if (context === "startup" || this.settings.notifications.ghostLinkPrompt) {
			this.showUnifiedSyncPrompt(pending, context, fileCount);
		}
	}

	private showUnifiedSyncPrompt(pendingSyncs: PendingSync[], context: "startup" | "new_files", fileCount: number = 0) {
		const message = context === "startup"
			? `Frontmatter Sync: Startup scan found ${pendingSyncs.length} pending backlink(s).`
			: `Frontmatter Sync: Detected ${fileCount === 1 ? "1 new file" : `${fileCount} new/modified files`} with ${pendingSyncs.length} pending backlink(s).`;

		const content = createFragment();
		content.createDiv({ text: message, cls: "frontmatter-sync-notice-message" });

		const btnContainer = content.createDiv({ cls: "frontmatter-sync-notice-buttons" });
		const syncBtn = btnContainer.createEl("button", { text: "Sync all", cls: "mod-cta" });
		const ignoreBtn = btnContainer.createEl("button", { text: "Ignore all" });

		const notice = new Notice(content, 0);

		ignoreBtn.onclick = () => notice.hide();
		syncBtn.onclick = async () => {
			syncBtn.innerText = "Syncing...";
			syncBtn.disabled = true;
			ignoreBtn.disabled = true;

			// Notes may have been synced elsewhere while the prompt was open.
			const stillPending = this.syncService.filterUnsynced(pendingSyncs);
			await this.syncService.applyPendingSyncs(stillPending);

			notice.hide();
			if (this.settings.notifications.backgroundSync) {
				new Notice(stillPending.length > 0 ? `Successfully synced ${stillPending.length} relation(s)!` : "Frontmatter Sync: Everything is already in sync.");
			}
		};
	}

	async loadSettings() {
		const loadedData = (await this.loadData()) as Partial<FrontmatterSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
		this.settings.notifications = Object.assign({}, DEFAULT_SETTINGS.notifications, loadedData?.notifications);
		this.settings.formatting = Object.assign({}, DEFAULT_SETTINGS.formatting, loadedData?.formatting);
		if (!this.settings.relationGroups) this.settings.relationGroups = [];
	}

	async saveSettings() {
		// Debounced, because the pair key fields save on every keystroke. A note change
		// arriving before the timer fires runs the refresh first.
		this.scheduleSnapshotRefresh();
		await this.saveData(this.settings);
	}
}