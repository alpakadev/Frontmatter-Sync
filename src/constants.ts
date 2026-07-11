export const TIMERS = {
    FILE_CHANGE_DEBOUNCE_MS: 300,
    NEW_FILE_QUEUE_DELAY_MS: 2000,
    WRITING_GUARD_MS: 1000,
} as const;

export const REGEX = {
    WIKI_LINK: /^\[\[(.*?)\]\]$/,
    MD_LINK: /^\[(.*?)\]\((.*?)\)$/
} as const;