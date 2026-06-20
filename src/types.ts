import { TFile } from "obsidian";

export interface NotificationSettings {
    backgroundSync: boolean;
    plainTextWarning: boolean;
    ghostLinkWarning: boolean;
    ghostLinkPrompt: boolean;
}

export interface RelationPair {
    forward: string;
    inverse: string;
    enabled: boolean;
}

export interface RelationGroup {
    name: string;
    enabled: boolean;
    pairs: RelationPair[];
}

export interface CompassSyncSettings {
    relationGroups: RelationGroup[];
    notifications: NotificationSettings;
    // Retained for backward compatibility migration
    relations?: RelationPair[];
}

export interface PendingSync {
    sourceName: string;
    sourceFile: TFile;
    targetFile: TFile;
    inverseKey: string;
}

export const DEFAULT_SETTINGS: CompassSyncSettings = {
    relationGroups: [
        {
            name: "Default Group",
            enabled: true,
            pairs: []
        }
    ],
    notifications: {
        backgroundSync: true,
        plainTextWarning: true,
        ghostLinkWarning: true,
        ghostLinkPrompt: true
    }
};