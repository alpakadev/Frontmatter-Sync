export interface RelationPair {
    forward: string;
    inverse: string;
}

export interface CompassSyncSettings {
    relations: RelationPair[];
}

export const DEFAULT_SETTINGS: CompassSyncSettings = {
    relations: [] // Completely empty predefined links!
};