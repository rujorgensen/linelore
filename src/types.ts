/**
 * A single edit to the tracked line range, as recorded by one commit.
 *
 * `git log -L` only surfaces commits that actually touched the range, so every
 * `LineEvent` represents a real change — never a no-op.
 */
export interface LineEvent {
    /** Full 40-char commit SHA. */
    readonly sha: string;
    /** Abbreviated SHA for display. */
    readonly shortSha: string;
    readonly author: string;
    /** Author date, ISO-8601. */
    readonly date: string;
    /** Commit subject (first line of the message). */
    readonly subject: string;
    /** Lines removed from the range by this commit (the "before"). */
    readonly removed: readonly string[];
    /** Lines added to the range by this commit (the "after"). */
    readonly added: readonly string[];
    /**
     * Classification derived from removed/added: the line was born, edited,
     * or deleted in this commit.
     */
    readonly kind: 'born' | 'edited' | 'deleted';
}

/**
 * How the line numbers actually traced differ from the ones the user asked for,
 * because the working tree has uncommitted changes above (or on) the line.
 */
export interface Drift {
    /** The working-tree line range the user named. */
    readonly requestedStart: number;
    readonly requestedEnd: number;
    /** True when the requested lines were themselves rewritten, not just moved. */
    readonly rewritten: boolean;
}

/** The full biography of a line range: newest change first. */
export interface Lineage {
    readonly file: string;
    /** The HEAD line range that was traced. */
    readonly startLine: number;
    readonly endLine: number;
    /** Present only when the working tree shifted the requested range. */
    readonly drift?: Drift;
    /** Newest → oldest. The last entry is the line's birth. */
    readonly events: readonly LineEvent[];
}
