export interface NotificationSettings {
    backgroundSync: boolean;
    plainTextWarning: boolean;
    ghostLinkWarning: boolean;
    ghostLinkPrompt: boolean;
}

export interface RelationPair {
    forward: string;
    inverse: string;
}

export interface CompassSyncSettings {
    relations: RelationPair[];
    notifications: NotificationSettings;
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