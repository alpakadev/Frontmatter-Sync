export interface CompassRelation {
    forward: string;
    inverse: string;
}

export interface CompassSyncSettings {
    relations: CompassRelation[];
}

export const DEFAULT_SETTINGS: CompassSyncSettings = {
    relations: [
        { forward: "south", inverse: "north" } // A default example so they know how it works
    ]
};