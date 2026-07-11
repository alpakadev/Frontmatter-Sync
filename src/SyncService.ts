import { App, Notice, TFile } from "obsidian";
import { CompassSyncSettings, PendingSync, RelationPair } from "./types";
import { LinkService } from "./LinkService";
import { TIMERS, REGEX } from "./constants";

export class SyncService {
    private writingFiles = new Set<string>();
    private expectedStates = new Map<string, string>();
    private writingTimers = new Map<string, number>();

    constructor(
        private app: App,
        private settings: CompassSyncSettings,
        private linkService: LinkService
    ) { }

    // --- WRITING GUARDS & STATE TRACKING ---

    public isWriting(path: string): boolean {
        return this.writingFiles.has(path);
    }

    public matchesExpectedState(path: string, currentFm: Record<string, unknown> | null | undefined): boolean {
        if (!this.expectedStates.has(path)) return false;
        const expected = this.expectedStates.get(path);
        const current = JSON.stringify(this.getTrackedFrontmatter(currentFm));
        return expected === current;
    }

    private setWritingGuard(path: string, resultingFm: Record<string, unknown>) {
        this.writingFiles.add(path);
        this.expectedStates.set(path, JSON.stringify(this.getTrackedFrontmatter(resultingFm)));

        const timer = window.setTimeout(() => this.clearWritingGuard(path), TIMERS.WRITING_GUARD_FALLBACK_MS);
        this.writingTimers.set(path, timer);
    }

    public clearWritingGuard(path: string) {
        this.writingFiles.delete(path);
        this.expectedStates.delete(path);
        const timer = this.writingTimers.get(path);
        if (timer) {
            window.clearTimeout(timer);
            this.writingTimers.delete(path);
        }
    }

    public clearAllGuards() {
        this.writingTimers.forEach(timer => window.clearTimeout(timer));
        this.writingTimers.clear();
        this.expectedStates.clear();
        this.writingFiles.clear();
    }

    // --- DATA TRACKING ---

    public getTrackedFrontmatter(fm: Record<string, unknown> | null | undefined): Record<string, unknown> {
        if (!fm) return {};
        const tracked: Record<string, unknown> = {};

        for (const group of this.settings.relationGroups) {
            if (!group.enabled) continue;
            for (const pair of group.pairs) {
                if (!pair.enabled) continue;
                if (fm[pair.forward] !== undefined) tracked[pair.forward] = structuredClone(fm[pair.forward]);
                if (fm[pair.inverse] !== undefined) tracked[pair.inverse] = structuredClone(fm[pair.inverse]);
            }
        }
        return tracked;
    }

    public getDirections(pair: RelationPair): { from: string; to: string }[] {
        if (!pair.enabled || !pair.forward || !pair.inverse) return [];
        if (pair.forward === pair.inverse) return [{ from: pair.forward, to: pair.inverse }];
        return [
            { from: pair.forward, to: pair.inverse },
            { from: pair.inverse, to: pair.forward }
        ];
    }

    // --- FORMATTING & SYNC LOGIC ---

    public async enforceAliasFormatting(file: TFile, fmData: Record<string, unknown>): Promise<boolean> {
        if (!this.settings.formatting?.useAliasForPaths) return false;

        let needsUpdate = false;
        const checkNeedsUpdate = (s: string) => {
            const matches = s.match(REGEX.WIKI_LINK_GLOBAL);
            if (matches && matches.some(m => m.includes("/"))) needsUpdate = true;
        };

        for (const group of this.settings.relationGroups) {
            if (!group.enabled) continue;
            for (const pair of group.pairs) {
                if (!pair.enabled) continue;
                const keys = [pair.forward, pair.inverse].filter(Boolean);
                for (const key of keys) {
                    const val = fmData[key];
                    if (!val) continue;

                    if (Array.isArray(val)) {
                        val.forEach(v => typeof v === "string" && checkNeedsUpdate(v));
                    } else if (typeof val === "string") {
                        checkNeedsUpdate(val);
                    }
                }
            }
        }

        if (!needsUpdate) return false;

        try {
            let resultingFm: Record<string, unknown> = {};
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                for (const group of this.settings.relationGroups) {
                    if (!group.enabled) continue;
                    for (const pair of group.pairs) {
                        if (!pair.enabled) continue;
                        const keys = [pair.forward, pair.inverse].filter(Boolean);
                        for (const key of keys) {
                            if (!fm[key]) continue;

                            const formatStr = (s: string) => {
                                return s.replace(REGEX.WIKI_LINK_GLOBAL, (match, inner) => {
                                    if (inner.includes("/")) {
                                        const basename = inner.split("/").pop()?.split("#")[0];
                                        return `[[${inner}|${basename}]]`;
                                    }
                                    return match;
                                });
                            };

                            if (Array.isArray(fm[key])) {
                                fm[key] = fm[key].map(v => typeof v === "string" ? formatStr(v) : v);
                            } else if (typeof fm[key] === "string") {
                                fm[key] = formatStr(fm[key]);
                            }
                        }
                    }
                }
                resultingFm = structuredClone(fm);
            });
            this.setWritingGuard(file.path, resultingFm);
        } catch (error) {
            console.error("Error auto-formatting aliases:", error);
        }
        return true;
    }

    public async processRelation(file: TFile, key: string, inverseKey: string, currentFm: Record<string, unknown>, previousFm: Record<string, unknown>) {
        const currentLinks = this.linkService.getResolvedLinks(currentFm[key], file.path);
        const previousLinks = this.linkService.getResolvedLinks(previousFm[key], file.path);

        const addedInvalid = currentLinks.invalid.filter(text => !previousLinks.invalid.includes(text));

        if (this.settings.notifications.plainTextWarning) {
            for (const text of addedInvalid) {
                new Notice(`Relation Sync: "${text}" is plain text. Please use [[${text}]] in property '${key}' to sync.`);
            }
        }

        const added = currentLinks.resolved.filter(curr => {
            return curr.file
                ? !previousLinks.resolved.some(prev => prev.file?.path === curr.file!.path)
                : !previousLinks.resolved.some(prev => prev.raw === curr.raw);
        });

        const removed = previousLinks.resolved.filter(prev => {
            return prev.file
                ? !currentLinks.resolved.some(curr => curr.file?.path === prev.file!.path)
                : !currentLinks.resolved.some(curr => curr.raw === prev.raw);
        });

        for (const item of added) {
            await this.modifyTargetNote(item.file || item.raw, file, inverseKey, "add");
        }
        for (const item of removed) {
            await this.modifyTargetNote(item.file || item.raw, file, inverseKey, "remove");
        }
    }

    public async modifyTargetNote(target: string | TFile, sourceFile: TFile, inverseKey: string, action: "add" | "remove") {
        const targetFile: TFile | null = target instanceof TFile ? target : this.app.metadataCache.getFirstLinkpathDest(target, sourceFile.path);

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

        try {
            let didChange = false;
            let resultingFm: Record<string, unknown> = {};

            await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
                const existing = fm[inverseKey];
                const existingArray = Array.isArray(existing)
                    ? existing
                    : (typeof existing === "string" && existing.trim() !== "" ? existing.split(",").map((s: string) => s.trim()) : []);

                if (action === "add") {
                    const alreadyExists = existingArray.some((rawLink: unknown) => {
                        if (typeof rawLink !== "string") return false;
                        const parsed = this.linkService.parseFrontmatterEntry(rawLink);
                        return parsed.isValid && this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path)?.path === sourceFile.path;
                    });

                    if (!alreadyExists) {
                        if (fm[inverseKey] === undefined || fm[inverseKey] === null) {
                            fm[inverseKey] = [sourceLink];
                        } else if (Array.isArray(fm[inverseKey])) {
                            fm[inverseKey].push(sourceLink);
                        } else if (typeof fm[inverseKey] === "string") {
                            // Upgrade raw strings to proper Obsidian arrays to prevent Properties UI corruption
                            if (fm[inverseKey].trim() === "") {
                                fm[inverseKey] = sourceLink;
                            } else {
                                fm[inverseKey] = [fm[inverseKey], sourceLink];
                            }
                        }
                        didChange = true;
                    }
                } else if (action === "remove") {
                    if (Array.isArray(fm[inverseKey])) {
                        const originalLength = fm[inverseKey].length;
                        fm[inverseKey] = fm[inverseKey].filter((rawLink: unknown) => {
                            if (typeof rawLink !== "string") return true;
                            const parsed = this.linkService.parseFrontmatterEntry(rawLink);
                            if (parsed.isValid && this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path)?.path === sourceFile.path) {
                                return false;
                            }
                            return rawLink !== sourceLink;
                        });
                        if (fm[inverseKey].length !== originalLength) didChange = true;
                    } else if (typeof fm[inverseKey] === "string") {
                        const parsed = this.linkService.parseFrontmatterEntry(fm[inverseKey]);
                        if (parsed.isValid && this.app.metadataCache.getFirstLinkpathDest(parsed.target, targetFile.path)?.path === sourceFile.path) {
                            fm[inverseKey] = "";
                            didChange = true;
                        } else {
                            if (fm[inverseKey].includes(sourceLink)) {
                                fm[inverseKey] = fm[inverseKey].replace(sourceLink, "").replace(/,\s*,/g, ",").replace(/^,\s*|\s*,$/g, "").trim();
                                didChange = true;
                            }
                        }
                    }
                }
                resultingFm = structuredClone(fm);
            });

            if (didChange) {
                this.setWritingGuard(targetFile.path, resultingFm);
                if (this.settings.notifications.backgroundSync) {
                    new Notice(`Relation Sync: Updated background note "${targetFile.basename}"`);
                }
            }
        } catch (error) {
            this.clearWritingGuard(targetFile.path);
            new Notice(`Error syncing to ${targetFile?.basename || target}`);
            console.error(error);
        }
    }

    // --- BULK SYNC LOGIC ---

    public async previewBulkSync(prevFm: Map<string, Record<string, unknown>>): Promise<PendingSync[]> {
        const pending: PendingSync[] = [];
        let iterations = 0;

        for (const [sourcePath, previousFm] of prevFm.entries()) {
            const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) continue;

            if (++iterations % 100 === 0) await new Promise(resolve => setTimeout(resolve, 0));

            for (const group of this.settings.relationGroups) {
                if (!group.enabled) continue;
                for (const pair of group.pairs) {
                    for (const dir of this.getDirections(pair)) {
                        this.evaluateMissingLinks(sourceFile, previousFm[dir.from], dir.to, prevFm, pending);
                    }
                }
            }
        }
        return pending;
    }

    private evaluateMissingLinks(sourceFile: TFile, sourceLinks: unknown, inverseKey: string, allPrevFm: Map<string, Record<string, unknown>>, pendingOut: PendingSync[]) {
        const targets = this.linkService.getResolvedLinks(sourceLinks, sourceFile.path);

        for (const target of targets.resolved) {
            if (!target.file) continue;

            const targetFm = allPrevFm.get(target.file.path) || {};
            const backLinks = this.linkService.getResolvedLinks(targetFm[inverseKey], target.file.path);
            const hasBacklink = backLinks.resolved.some(r => r.file?.path === sourceFile.path);

            if (!hasBacklink) {
                pendingOut.push({ sourceName: sourceFile.basename, sourceFile, targetFile: target.file, inverseKey });
            }
        }
    }

    public async executeBulkSync(pending: PendingSync[]) {
        for (const sync of pending) {
            await this.modifyTargetNote(sync.targetFile, sync.sourceFile, sync.inverseKey, "add");
        }
        new Notice(`Bulk Sync Complete: Successfully added ${pending.length} missing bidirectional link(s)!`);
    }
}