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

export interface CompassSyncSettings {
    relations: RelationPair[];
    notifications: NotificationSettings;
}

export interface PendingSync {
    sourceName: string;
    sourceFile: TFile;
    targetFile: TFile;
    inverseKey: string;
}

export const DEFAULT_SETTINGS: CompassSyncSettings = {
    relations: [],
    notifications: {
        backgroundSync: true,
        plainTextWarning: true,
        ghostLinkWarning: true,
        ghostLinkPrompt: true
    }
};