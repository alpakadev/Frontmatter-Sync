import { TFile } from "obsidian";

export interface NotificationSettings {
    backgroundSync: boolean;
    plainTextWarning: boolean;
    ghostLinkWarning: boolean;
    ghostLinkPrompt: boolean;
    checkOnStartup: boolean;
    renameDetection: boolean;
    verifyBeforePrompt: boolean;
    autoSync: boolean;
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

export interface FrontmatterSyncSettings {
    relationGroups: RelationGroup[];
    notifications: NotificationSettings;
    formatting: FormattingSettings;
}

export interface PendingSync {
    sourceName: string;
    sourceFile: TFile;
    targetFile: TFile;
    inverseKey: string;
}

export const DEFAULT_SETTINGS: FrontmatterSyncSettings = {
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
        renameDetection: true,
        verifyBeforePrompt: true,
        autoSync: false
    },
    formatting: {
        useAliasForPaths: true
    }
};