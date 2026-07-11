import { App, PluginSettingTab, Setting, AbstractInputSuggest, Modal, setIcon } from "obsidian";
import type CompassSyncPlugin from "./main";
import { PendingSync, RelationGroup, RelationPair } from "./types";

// --- NATIVE OBSIDIAN SUGGESTION MENU ---
class PropertySuggest extends AbstractInputSuggest<string> {
	private showAll = false;
	private lastInput = "";

	constructor(
		app: App,
		private inputEl: HTMLInputElement,
		private keys: string[],
		private nextInputEl?: HTMLInputElement,
		private onFinalEnter?: () => void
	) {
		super(app, inputEl);
		inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.defaultPrevented) {
				e.preventDefault();
				this.jumpToNext();
			}
		});
	}

	private jumpToNext() {
		if (this.nextInputEl) {
			window.setTimeout(() => this.nextInputEl!.focus(), 10);
		} else if (this.onFinalEnter) {
			this.onFinalEnter();
		}
	}

	getSuggestions(inputStr: string): string[] {
		if (this.lastInput !== inputStr) {
			this.showAll = false;
			this.lastInput = inputStr;
		}

		const query = inputStr.toLowerCase();
		const filtered = this.keys.filter(k => k.toLowerCase().includes(query));

		if (this.showAll) return filtered;
		if (filtered.length > 20) return [...filtered.slice(0, 20), "__MORE__"];
		return filtered;
	}

	renderSuggestion(item: string, el: HTMLElement): void {
		if (item === "__MORE__") {
			el.setText("...");
			Object.assign(el.style, { textAlign: "center", opacity: "0.6", fontStyle: "italic" });
		} else {
			el.setText(item);
		}
	}

	selectSuggestion(item: string): void {
		if (item === "__MORE__") {
			this.showAll = true;
			window.setTimeout(() => {
				this.inputEl.focus();
				this.inputEl.dispatchEvent(new Event('input'));
			}, 10);
			return;
		}

		this.inputEl.value = item;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
		this.jumpToNext();
	}
}

// --- CONFIRM DELETE MODAL ---
class ConfirmDeleteModal extends Modal {
	constructor(app: App, private groupName: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Delete Folder" });
		contentEl.createEl("p", {
			text: `Are you sure you want to delete the folder "${this.groupName}" and all its pairs? This action cannot be undone.`,
			cls: "setting-item-description"
		});

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton(btn => btn.setButtonText("Delete").setWarning().onClick(() => {
				this.onConfirm();
				this.close();
			}));
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- BULK SYNC MODAL ---
class BulkSyncModal extends Modal {
	private selected: Set<PendingSync>;
	private viewMode: "file" | "folder" = "folder";
	private listContainer!: HTMLElement;
	private applyBtn!: HTMLButtonElement;

	constructor(app: App, private plugin: CompassSyncPlugin, private pending: PendingSync[]) {
		super(app);
		this.selected = new Set(this.pending);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Bulk Sync Preview" });

		if (this.pending.length === 0) {
			contentEl.createEl("p", { text: "Your vault is completely synchronized. No missing bidirectional links found." });
			new Setting(contentEl).addButton(btn => btn.setButtonText("Close").onClick(() => this.close()));
			return;
		}

		contentEl.createEl("p", {
			text: `Found ${this.pending.length} missing bidirectional link(s). Select the ones you want to apply.`,
			cls: "setting-item-description"
		});

		const toolbar = contentEl.createDiv({ attr: { style: "display: flex; gap: 8px; margin-bottom: 12px; align-items: center;" } });
		toolbar.createEl("button", { text: "Select All" }).onclick = () => { this.pending.forEach(p => this.selected.add(p)); this.renderList(); };
		toolbar.createEl("button", { text: "Unselect All" }).onclick = () => { this.selected.clear(); this.renderList(); };

		const viewToggleBtn = toolbar.createEl("button", { text: "View: Folders" });
		viewToggleBtn.onclick = () => {
			this.viewMode = this.viewMode === "folder" ? "file" : "folder";
			viewToggleBtn.innerText = this.viewMode === "folder" ? "View: Folders" : "View: Files";
			this.renderList();
		};

		this.listContainer = contentEl.createDiv({
			attr: { style: "max-height: 400px; overflow-y: auto; margin-bottom: 20px; border: 1px solid var(--background-modifier-border); padding: 10px; border-radius: 5px; background: var(--background-secondary);" }
		});

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText("Close").onClick(() => this.close()))
			.addButton(btn => {
				this.applyBtn = btn.buttonEl;
				btn.setButtonText(`Apply ${this.selected.size} Changes`).setCta().onClick(async () => {
					btn.setButtonText("Applying...").setDisabled(true);
					await this.plugin.syncService.executeBulkSync(Array.from(this.selected));
					this.close();
				});
			});

		this.renderList();
	}

	private renderList() {
		// Save scroll position to prevent UI thrashing on checkbox toggle
		const scrollPos = this.listContainer?.scrollTop || 0;
		this.listContainer.empty();

		if (this.viewMode === "folder") {
			const folders = new Map<string, PendingSync[]>();
			this.pending.forEach(p => {
				const f = p.targetFile.parent?.path || "/ (Root)";
				if (!folders.has(f)) folders.set(f, []);
				folders.get(f)!.push(p);
			});

			Array.from(folders.keys()).sort().forEach(folder => {
				const syncs = folders.get(folder)!;
				this.renderGroupHeader(this.listContainer, `📁 ${folder}`, syncs);
				const folderIndent = this.listContainer.createDiv({ attr: { style: "margin-left: 20px; margin-bottom: 12px; border-left: 1px solid var(--background-modifier-border); padding-left: 10px;" } });

				const files = new Map<string, PendingSync[]>();
				syncs.forEach(p => {
					const f = p.targetFile.basename;
					if (!files.has(f)) files.set(f, []);
					files.get(f)!.push(p);
				});

				Array.from(files.keys()).sort().forEach(file => {
					const fileSyncs = files.get(file)!;
					this.renderGroupHeader(folderIndent, `📄 ${file}`, fileSyncs);
					const fileIndent = folderIndent.createDiv({ attr: { style: "margin-left: 20px; margin-bottom: 8px;" } });
					fileSyncs.forEach(p => this.renderSingleItem(fileIndent, p));
				});
			});
		} else {
			const files = new Map<string, PendingSync[]>();
			this.pending.forEach(p => {
				const f = p.targetFile.path;
				if (!files.has(f)) files.set(f, []);
				files.get(f)!.push(p);
			});

			Array.from(files.keys()).sort().forEach(file => {
				const syncs = files.get(file)!;
				this.renderGroupHeader(this.listContainer, `📄 ${file}`, syncs);
				const indent = this.listContainer.createDiv({ attr: { style: "margin-left: 20px; margin-bottom: 12px;" } });
				syncs.forEach(p => this.renderSingleItem(indent, p));
			});
		}

		if (this.applyBtn) {
			this.applyBtn.innerText = `Apply ${this.selected.size} Changes`;
			this.applyBtn.disabled = this.selected.size === 0;
		}

		// Restore scroll position
		this.listContainer.scrollTop = scrollPos;
	}

	private renderGroupHeader(container: HTMLElement, label: string, syncs: PendingSync[]) {
		const header = container.createDiv({ attr: { style: "display: flex; align-items: center; margin-bottom: 4px; padding: 4px 0;" } });
		const cb = header.createEl("input", { type: "checkbox", attr: { style: "margin-right: 8px; cursor: pointer;" } });
		const selectedCount = syncs.filter(s => this.selected.has(s)).length;

		cb.checked = selectedCount === syncs.length && syncs.length > 0;
		cb.indeterminate = selectedCount > 0 && selectedCount < syncs.length;

		cb.onchange = (e) => {
			const checked = (e.target as HTMLInputElement).checked;
			syncs.forEach(s => checked ? this.selected.add(s) : this.selected.delete(s));
			this.renderList();
		};
		header.createSpan({ text: label, attr: { style: "font-weight: 600; cursor: pointer;" } }).onclick = () => cb.click();
	}

	private renderSingleItem(container: HTMLElement, sync: PendingSync) {
		const item = container.createDiv({ attr: { style: "display: flex; align-items: flex-start; margin-bottom: 4px; padding: 2px 0;" } });
		const cb = item.createEl("input", { type: "checkbox", attr: { style: "margin-right: 8px; margin-top: 3px; cursor: pointer;" } });
		cb.checked = this.selected.has(sync);

		cb.onchange = (e) => {
			const checked = (e.target as HTMLInputElement).checked;
			checked ? this.selected.add(sync) : this.selected.delete(sync);
			this.renderList();
		};

		const textSpan = item.createSpan({ attr: { style: "font-size: 0.9em; font-family: var(--font-monospace); color: var(--text-muted); cursor: pointer;" } });
		textSpan.innerHTML = `Add <span style="color: var(--text-normal)">${sync.inverseKey}: [[${sync.sourceName}]]</span>`;
		textSpan.onclick = () => cb.click();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- MAIN SETTINGS TAB ---
export class CompassSettingTab extends PluginSettingTab {
	private draggedGroupIndex: number | null = null;
	private draggedPairData: { groupIndex: number, pairIndex: number } | null = null;
	private focusTarget: { groupIndex: number, pairIndex: number } | null = null;
	private keysArray: string[] = [];

	constructor(app: App, public plugin: CompassSyncPlugin) {
		super(app, plugin);
	}

	private refresh(): void {
		const scrollTop = this.containerEl.scrollTop;
		this.display();
		this.containerEl.scrollTop = scrollTop;
	}

	private loadPropertyKeys() {
		const rawKeys = new Set<string>();
		if (typeof (this.app.metadataCache as any).getAllPropertyKeys === "function") {
			const props = (this.app.metadataCache as any).getAllPropertyKeys();
			props.forEach((p: string) => rawKeys.add(p));
		} else {
			for (const file of this.app.vault.getMarkdownFiles()) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter) Object.keys(cache.frontmatter).forEach(k => rawKeys.add(k));
			}
		}
		this.keysArray = Array.from(rawKeys).sort();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.loadPropertyKeys();

		containerEl.createEl("h2", { text: "Relation Sync Settings" });

		this.renderVaultMaintenance(containerEl);
		this.renderLinkFormatting(containerEl);
		this.renderNotifications(containerEl);
		this.renderRelationGroups(containerEl);
	}

	private renderVaultMaintenance(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Vault Maintenance" });
		new Setting(containerEl)
			.setName("Bulk Sync Missing Relations")
			.setDesc("Scan the entire vault for missing bidirectional links and add them automatically. A preview will be shown before changes are applied.")
			.addButton((btn) => btn
				.setButtonText("Run Scan")
				.setWarning()
				.onClick(async () => {
					btn.setButtonText("Scanning...").setDisabled(true);
					const pending = await this.plugin.syncService.previewBulkSync(this.plugin.getFrontmatterCache());
					btn.setButtonText("Run Scan").setDisabled(false);
					new BulkSyncModal(this.app, this.plugin, pending).open();
				})
			);
	}

	private renderLinkFormatting(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Link Formatting" });
		new Setting(containerEl)
			.setName("Use aliases for path links")
			.setDesc("When Obsidian requires a folder path to disambiguate duplicate file names, append the file name as an alias to keep the visual link clean (e.g., [[Path/To/File|File]]).")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.formatting.useAliasForPaths)
				.onChange(async (value) => {
					this.plugin.settings.formatting.useAliasForPaths = value;
					await this.plugin.saveSettings();
				})
			);
	}

	private renderNotifications(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Notifications" });

		const createNotificationToggle = (name: string, desc: string, key: keyof typeof this.plugin.settings.notifications) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((toggle) => toggle
					.setValue(this.plugin.settings.notifications[key])
					.onChange(async (value) => {
						this.plugin.settings.notifications[key] = value;
						await this.plugin.saveSettings();
					})
				);
		};

		createNotificationToggle("Check files on startup", "Scan the vault for missing bidirectional links automatically when Obsidian starts.", "checkOnStartup");
		createNotificationToggle("Background sync success", "Show a popup when a target note is updated in the background.", "backgroundSync");
		createNotificationToggle("Plain text warning", "Warn when you type plain text instead of a valid [[WikiLink]].", "plainTextWarning");
		createNotificationToggle("Missing file warning", "Warn when you link to a file that does not exist in the vault yet.", "ghostLinkWarning");
		createNotificationToggle("Interactive ghost link prompt", "Show an interactive prompt to resolve pending links when creating or importing notes.", "ghostLinkPrompt");
		createNotificationToggle("Rename detection", "Detect when you rename a file to match an existing missing link and prompt to sync.", "renameDetection");
	}

	private renderRelationGroups(containerEl: HTMLElement) {
		containerEl.createEl("h3", { text: "Relation Groups" });

		const topActions = containerEl.createDiv({ attr: { style: "display: flex; gap: 8px; margin-bottom: 20px; align-items: center;" } });

		const addGroupBtn = topActions.createEl("button", { text: "Add Folder Group", cls: "mod-cta" });
		addGroupBtn.onclick = async () => {
			this.plugin.settings.relationGroups.push({ name: "New Group", enabled: true, isCollapsed: false, pairs: [] });
			await this.plugin.saveSettings();
			this.refresh();
		};

		const hasEnabledItems = this.plugin.settings.relationGroups.some(g => g.enabled || g.pairs.some(p => p.enabled));
		const toggleAllBtn = topActions.createEl("button", { text: hasEnabledItems ? "Deactivate All" : "Activate All" });
		toggleAllBtn.onclick = async () => {
			const newState = !hasEnabledItems;
			this.plugin.settings.relationGroups.forEach(g => {
				g.enabled = newState;
				g.pairs.forEach(p => p.enabled = newState);
			});
			await this.plugin.saveSettings();
			this.refresh();
		};

		const listContainer = containerEl.createDiv();
		this.plugin.settings.relationGroups.forEach((group, groupIndex) => this.renderSingleGroup(listContainer, group, groupIndex));
	}

	private renderSingleGroup(listContainer: HTMLElement, group: RelationGroup, groupIndex: number) {
		const groupContainer = listContainer.createDiv({
			attr: { style: "border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 12px; margin-bottom: 16px; background: var(--background-secondary); transition: border 0.2s ease;" }
		});

		this.setupGroupDragAndDrop(groupContainer, groupIndex);

		const headerSetting = new Setting(groupContainer);
		Object.assign(headerSetting.settingEl.style, { borderBottom: "1px solid var(--background-modifier-border)", paddingBottom: "8px", marginBottom: "12px", flexWrap: "wrap" });
		Object.assign(headerSetting.infoEl.style, { display: "flex", alignItems: "center", gap: "8px", flex: "1", minWidth: "200px" });

		const pairsContainer = groupContainer.createDiv({ cls: "compass-pairs-container" });
		pairsContainer.style.paddingLeft = "38px";

		this.renderGroupHeaderControls(headerSetting, group, groupIndex, groupContainer, pairsContainer);

		if (group.isCollapsed) pairsContainer.style.display = "none";
		if (!group.enabled) {
			pairsContainer.style.opacity = "0.5";
			pairsContainer.style.pointerEvents = "none";
		}

		group.pairs.forEach((pair, pairIndex) => this.renderPair(pairsContainer, group, groupIndex, pair, pairIndex));
	}

	private setupGroupDragAndDrop(groupContainer: HTMLElement, groupIndex: number) {
		groupContainer.addEventListener("dragover", (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			if (this.draggedGroupIndex !== null && this.draggedGroupIndex !== groupIndex) {
				groupContainer.style.borderTop = "3px solid var(--interactive-accent)";
			} else if (this.draggedPairData !== null && this.draggedPairData.groupIndex !== groupIndex) {
				groupContainer.style.border = "1px dashed var(--interactive-accent)";
			}
		});

		groupContainer.addEventListener("dragleave", () => {
			groupContainer.style.border = "1px solid var(--background-modifier-border)";
		});

		groupContainer.addEventListener("drop", async (e) => {
			e.preventDefault();
			e.stopPropagation();
			groupContainer.style.border = "1px solid var(--background-modifier-border)";

			if (this.draggedGroupIndex !== null && this.draggedGroupIndex !== groupIndex) {
				const movedGroup = this.plugin.settings.relationGroups.splice(this.draggedGroupIndex, 1)[0];
				this.plugin.settings.relationGroups.splice(groupIndex, 0, movedGroup);
				this.draggedGroupIndex = null;
				await this.plugin.saveSettings();
				this.refresh();
			} else if (this.draggedPairData !== null && this.draggedPairData.groupIndex !== groupIndex) {
				const movedPair = this.plugin.settings.relationGroups[this.draggedPairData.groupIndex].pairs.splice(this.draggedPairData.pairIndex, 1)[0];
				this.plugin.settings.relationGroups[groupIndex].pairs.push(movedPair);
				this.draggedPairData = null;
				await this.plugin.saveSettings();
				this.refresh();
			}
		});
	}

	private renderGroupHeaderControls(headerSetting: Setting, group: RelationGroup, groupIndex: number, groupContainer: HTMLElement, pairsContainer: HTMLElement) {
		const dragHandle = headerSetting.infoEl.createDiv({ attr: { style: "cursor: grab; opacity: 0.5; padding: 4px; display: flex; align-items: center;" } });
		setIcon(dragHandle, "grip-vertical");
		dragHandle.draggable = true;

		dragHandle.addEventListener("dragstart", (e) => {
			this.draggedGroupIndex = groupIndex;
			if (e.dataTransfer) { e.dataTransfer.setData("text/plain", "group"); e.dataTransfer.effectAllowed = "move"; }
			groupContainer.style.opacity = "0.5";
		});
		dragHandle.addEventListener("dragend", () => {
			this.draggedGroupIndex = null;
			groupContainer.style.opacity = "1";
		});

		const collapseBtn = headerSetting.infoEl.createDiv({ attr: { style: "cursor: pointer; display: flex; align-items: center; opacity: 0.7; padding: 4px; border-radius: 4px;" } });
		setIcon(collapseBtn, group.isCollapsed ? "chevron-right" : "chevron-down");

		collapseBtn.onclick = async () => {
			group.isCollapsed = !group.isCollapsed;
			await this.plugin.saveSettings();
			setIcon(collapseBtn, group.isCollapsed ? "chevron-right" : "chevron-down");
			pairsContainer.style.display = group.isCollapsed ? "none" : "block";
		};

		this.renderInlineEditTitle(headerSetting.infoEl, group);

		headerSetting
			.addExtraButton(btn => btn.setIcon(group.enabled ? "eye" : "eye-off").onClick(async () => {
				group.enabled = !group.enabled;
				group.pairs.forEach(p => p.enabled = group.enabled);
				await this.plugin.saveSettings();
				this.refresh();
			}))
			.addExtraButton(btn => btn.setIcon("plus").onClick(async () => {
				group.pairs.push({ forward: "", inverse: "", enabled: true });
				group.isCollapsed = false;
				this.focusTarget = { groupIndex, pairIndex: group.pairs.length - 1 };
				await this.plugin.saveSettings();
				this.refresh();
			}))
			.addExtraButton(btn => btn.setIcon("trash").onClick(() => {
				new ConfirmDeleteModal(this.app, group.name, async () => {
					this.plugin.settings.relationGroups.splice(groupIndex, 1);
					await this.plugin.saveSettings();
					this.refresh();
				}).open();
			}));
	}

	private renderInlineEditTitle(container: HTMLElement, group: RelationGroup) {
		const titleContainer = container.createDiv({ attr: { style: "display: flex; flex: 1; align-items: center; min-width: 0;" } });
		const titleSpan = titleContainer.createSpan({ text: group.name, attr: { style: "font-weight: bold; font-size: 1.1em; cursor: text; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" } });
		const titleInput = titleContainer.createEl("input", { type: "text", value: group.name, attr: { style: "display: none; flex: 1; min-width: 50px; font-weight: bold; font-size: 1.1em; padding: 2px 6px;" } });
		const editPencil = titleContainer.createDiv({ attr: { style: "cursor: pointer; opacity: 0.4; margin-left: 8px; display: flex; align-items: center;" } });

		setIcon(editPencil, "pencil");

		const toggleEdit = () => {
			titleSpan.style.display = "none";
			editPencil.style.display = "none";
			titleInput.style.display = "block";
			titleInput.focus();
			titleInput.select();
		};

		const saveEdit = async () => {
			if (titleInput.style.display === "none") return;
			group.name = titleInput.value.trim() || "Unnamed Group";
			titleSpan.innerText = group.name;
			titleInput.style.display = "none";
			titleSpan.style.display = "block";
			editPencil.style.display = "flex";
			await this.plugin.saveSettings();
		};

		titleSpan.addEventListener("dblclick", toggleEdit);
		editPencil.addEventListener("click", toggleEdit);
		titleInput.addEventListener("blur", saveEdit);
		titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") saveEdit(); });
	}

	private renderPair(pairsContainer: HTMLElement, group: RelationGroup, groupIndex: number, pair: RelationPair, pairIndex: number) {
		let forwardInput: HTMLInputElement | null = null;
		let inverseInput: HTMLInputElement | null = null;

		const pairSetting = new Setting(pairsContainer)
			.addExtraButton(btn => btn.setIcon("menu"))
			.addExtraButton(btn => btn.setIcon(pair.enabled ? "eye" : "eye-off").onClick(async () => {
				pair.enabled = !pair.enabled;
				await this.plugin.saveSettings();

				btn.setIcon(pair.enabled ? "eye" : "eye-off");
				pairSetting.settingEl.style.opacity = pair.enabled ? "1" : "0.4";
				pairSetting.settingEl.style.filter = pair.enabled ? "none" : "grayscale(100%)";
			}))
			.addText(text => {
				forwardInput = text.inputEl;
				text.setPlaceholder("e.g., south").setValue(pair.forward).onChange(async (value) => { pair.forward = value; await this.plugin.saveSettings(); });
			})
			.addText(text => {
				inverseInput = text.inputEl;
				text.setPlaceholder("e.g., north").setValue(pair.inverse).onChange(async (value) => { pair.inverse = value; await this.plugin.saveSettings(); });
			})
			.addExtraButton(btn => btn.setIcon("trash").onClick(async () => {
				group.pairs.splice(pairIndex, 1);
				await this.plugin.saveSettings();
				this.refresh();
			}));

		this.stylePairSetting(pairSetting.settingEl, pair, forwardInput, inverseInput, groupIndex, pairIndex);
		this.setupPairDragAndDrop(pairSetting.settingEl, groupIndex, pairIndex, pair.enabled);

		if (forwardInput && inverseInput) {
			new PropertySuggest(this.app, forwardInput, this.keysArray, inverseInput);
			new PropertySuggest(this.app, inverseInput, this.keysArray, undefined, async () => {
				if (!pair.forward && !pair.inverse) return;
				group.pairs.push({ forward: "", inverse: "", enabled: true });
				this.focusTarget = { groupIndex, pairIndex: group.pairs.length - 1 };
				await this.plugin.saveSettings();
				this.refresh();
			});
		}
	}

	private stylePairSetting(el: HTMLElement, pair: RelationPair, forwardInput: HTMLInputElement | null, inverseInput: HTMLInputElement | null, groupIndex: number, pairIndex: number) {
		Object.assign(el.style, { borderTop: "none", padding: "6px 0", flexWrap: "nowrap", gap: "8px" });

		const infoBox = el.querySelector('.setting-item-info') as HTMLElement;
		if (infoBox) infoBox.style.display = "none";

		const controlBox = el.querySelector('.setting-item-control') as HTMLElement;
		if (controlBox) Object.assign(controlBox.style, { justifyContent: "flex-start", width: "100%", flex: "1" });

		[forwardInput, inverseInput].forEach(input => {
			if (input) Object.assign(input.style, { flex: "1 1 50px", minWidth: "0", width: "100%" });
		});

		if (!pair.enabled) {
			el.style.opacity = "0.4";
			el.style.filter = "grayscale(100%)";
		}

		if (this.focusTarget && this.focusTarget.groupIndex === groupIndex && this.focusTarget.pairIndex === pairIndex) {
			window.setTimeout(() => forwardInput?.focus(), 20);
			this.focusTarget = null;
		}
	}

	private setupPairDragAndDrop(el: HTMLElement, groupIndex: number, pairIndex: number, enabled: boolean) {
		el.draggable = true;
		el.style.cursor = "grab";

		el.addEventListener("dragstart", (e) => {
			e.stopPropagation();
			this.draggedPairData = { groupIndex, pairIndex };
			if (e.dataTransfer) { e.dataTransfer.setData("text/plain", "pair"); e.dataTransfer.effectAllowed = "move"; }
			el.style.opacity = "0.3";
		});

		el.addEventListener("dragend", () => {
			this.draggedPairData = null;
			el.style.opacity = enabled ? "1" : "0.4";
			el.style.borderTop = "";
		});

		el.addEventListener("dragover", (e) => {
			if (this.draggedGroupIndex !== null) return;
			e.preventDefault();
			e.stopPropagation();
			el.style.borderTop = "2px solid var(--interactive-accent)";
		});

		el.addEventListener("dragleave", () => el.style.borderTop = "");

		el.addEventListener("drop", async (e) => {
			if (this.draggedGroupIndex !== null) return;
			e.preventDefault();
			e.stopPropagation();
			el.style.borderTop = "";

			if (this.draggedPairData !== null) {
				const fromGroup = this.draggedPairData.groupIndex;
				const fromPair = this.draggedPairData.pairIndex;
				const movedItem = this.plugin.settings.relationGroups[fromGroup].pairs.splice(fromPair, 1)[0];
				this.plugin.settings.relationGroups[groupIndex].pairs.splice(pairIndex, 0, movedItem);
				this.draggedPairData = null;
				await this.plugin.saveSettings();
				this.refresh();
			}
		});
	}
}