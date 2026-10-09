import { parseYaml } from "obsidian";

// Obsidian reports "no frontmatter" both for a note without properties and for one whose
// YAML can't be parsed, e.g. while it is half-typed in source mode. Only the first case
// means the note's relations were really removed.
export function hasUnreadableFrontmatter(text: string): boolean {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trimEnd() !== "---") return false;

    const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
    if (end === -1) return true;

    try {
        const parsed: unknown = parseYaml(lines.slice(1, end).join("\n"));
        if (parsed === null || parsed === undefined) return false;
        // A block that parses to properties while Obsidian reports none is not settled yet either.
        return typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0;
    } catch {
        return true;
    }
}
