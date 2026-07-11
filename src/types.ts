import { TFile } from "obsidian";

export interface NotificationSettings {
    backgroundSync: boolean;
    plainTextWarning: boolean;
    ghostLinkWarning: boolean;
    ghostLinkPrompt: boolean;
    checkOnStartup: boolean;
    renameDetection: boolean;
}

export interface FormattingSettings {
    useAliasForPaths: boolean;
}

export interface RelationPair {
    forward: string;
    inverse: string;
    enabled: boolean;
}

export interface RelationGroup {
    name: string;
    enabled: boolean;
    isCollapsed?: boolean;
    pairs: RelationPair[];
}

export interface CompassSyncSettings {
    relationGroups: RelationGroup[];
    notifications: NotificationSettings;
    formatting: FormattingSettings;
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
            isCollapsed: false,
            pairs: []
        }
    ],
    notifications: {
        backgroundSync: true,
        plainTextWarning: true,
        ghostLinkWarning: true,
        ghostLinkPrompt: true,
        checkOnStartup: false,
        renameDetection: true
    },
    formatting: {
        useAliasForPaths: true
    }
};