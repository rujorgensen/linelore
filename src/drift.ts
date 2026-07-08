/**
 * Line numbers you read in an editor are working-tree numbers. `git log -L`
 * interprets them as HEAD numbers. When the file has uncommitted changes the
 * two disagree, and `linelore` silently traces the wrong line.
 *
 * This module maps a working-tree line back to HEAD by replaying the hunks of
 * `git diff -U0 HEAD -- <file>`.
 */

/** One hunk of a unified diff: old (HEAD) side and new (working tree) side. */
export interface Hunk {
    readonly oldStart: number;
    readonly oldCount: number;
    readonly newStart: number;
    readonly newCount: number;
}

/** Where a working-tree line lands at HEAD. */
export type Mapped =
    /** Untouched by the working-tree diff; `line` is its HEAD number. */
    | { readonly kind: 'clean'; readonly line: number }
    /** Rewritten in the working tree; it replaced HEAD lines `start..end`. */
    | { readonly kind: 'modified'; readonly start: number; readonly end: number }
    /** Purely new in the working tree; nothing at HEAD corresponds to it. */
    | { readonly kind: 'added' };

// -U0 emits no context lines, so a `@@` at column 0 is always a hunk header.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Extract the hunk headers from a `git diff -U0` patch. */
export function parseHunks(diff: string): Hunk[] {
    const hunks: Hunk[] = [];

    for (const line of diff.split('\n')) {
        const m = HUNK.exec(line);
        if (!m) continue;
        hunks.push({
            oldStart: Number(m[1]),
            // A missing count means 1; an explicit 0 means the side is empty.
            oldCount: m[2] === undefined ? 1 : Number(m[2]),
            newStart: Number(m[3]),
            newCount: m[4] === undefined ? 1 : Number(m[4]),
        });
    }

    return hunks;
}

/**
 * Map a working-tree line number to HEAD, given the hunks of the working-tree
 * diff (in ascending order, as git emits them).
 *
 * Walks the hunks that sit entirely above `line`, accumulating the net shift
 * each one applies, until it reaches or passes `line`.
 */
export function mapToHead(line: number, hunks: readonly Hunk[]): Mapped {
    let shift = 0;

    for (const h of hunks) {
        // A pure deletion (newCount 0) has an empty new-side range: git points
        // newStart at the line *before* the deletion, so the hunk's last new
        // line is newStart itself and its first is newStart + 1 (empty range).
        const lastNew = h.newCount === 0 ? h.newStart : h.newStart + h.newCount - 1;
        const firstNew = h.newCount === 0 ? h.newStart + 1 : h.newStart;

        if (line > lastNew) {
            shift += h.oldCount - h.newCount;
            continue;
        }
        if (line < firstNew) break; // every remaining hunk is below `line`

        // `line` sits inside this hunk's new-side range.
        return h.oldCount === 0
            ? { kind: 'added' }
            : { kind: 'modified', start: h.oldStart, end: h.oldStart + h.oldCount - 1 };
    }

    return { kind: 'clean', line: line + shift };
}
