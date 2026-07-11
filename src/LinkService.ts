import { App, TFile } from "obsidian";
import { REGEX } from "./constants";

export class LinkService {
    constructor(private app: App) { }

    public parseFrontmatterEntry(value: string): { isValid: boolean, target: string } {
        const trimmed = value.trim();
        if (!trimmed) return { isValid: false, target: "" };

        const wikiMatch = trimmed.match(REGEX.WIKI_LINK);
        if (wikiMatch) {
            const cleanName = wikiMatch[1].split("|")[0].split("#")[0].trim();
            return { isValid: true, target: cleanName };
        }

        const mdMatch = trimmed.match(REGEX.MD_LINK);
        if (mdMatch) {
            const linkPath = decodeURIComponent(mdMatch[2]).replace(/\.md$/i, "").split("#")[0].trim();
            return { isValid: true, target: linkPath };
        }

        return { isValid: false, target: trimmed };
    }

    public extractLinks(value: unknown): { valid: string[], invalid: string[] } {
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

    public getResolvedLinks(value: unknown, sourcePath: string): { resolved: { raw: string, file: TFile | null }[], invalid: string[] } {
        const links = this.extractLinks(value);
        const resolved = links.valid.map(target => ({
            raw: target,
            file: this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
        }));
        return { resolved, invalid: links.invalid };
    }
}