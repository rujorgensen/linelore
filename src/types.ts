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

/** The full biography of a line range: newest change first. */
export interface Lineage {
    readonly file: string;
    readonly startLine: number;
    readonly endLine: number;
    /** Newest → oldest. The last entry is the line's birth. */
    readonly events: readonly LineEvent[];
}
