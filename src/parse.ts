import type { LineEvent } from './types.js';

const RS = '\x1e';
const US = '\x1f';

/**
 * Parse the NUL/RS-delimited `git log -L` stream produced by
 * {@link Git.logLineRange} into structured {@link LineEvent}s (newest first).
 *
 * Each record starts with `\x1e` and looks like:
 *
 *     <sha>\x1f<author>\x1f<iso-date>\x1f<subject>\n
 *     diff --git ...
 *     @@ -a,b +c,d @@
 *      context
 *     -old
 *     +new
 */
export function parseLog(raw: string): LineEvent[] {
    const events: LineEvent[] = [];

    for (const record of raw.split(RS)) {
        if (!record.trim()) continue;

        const newlineAt = record.indexOf('\n');
        const headerLine = newlineAt === -1 ? record : record.slice(0, newlineAt);
        const body = newlineAt === -1 ? '' : record.slice(newlineAt + 1);

        const [sha, author = '', date = '', subject = ''] = headerLine.split(US);
        if (!sha) continue;

        const { removed, added } = extractChanges(body);
        events.push({
            sha,
            shortSha: sha.slice(0, 9),
            author,
            date,
            subject,
            removed,
            added,
            kind: added.length && !removed.length
                ? 'born'
                : removed.length && !added.length
                    ? 'deleted'
                    : 'edited',
        });
    }

    return events;
}

/**
 * Pull the +/- lines out of a unified-diff body. Content is trimmed of the
 * single leading diff marker only.
 *
 * Only lines *inside* a hunk carry content, so we gate on `@@` rather than
 * pattern-matching the `---`/`+++` headers: a source line whose own text
 * begins with `---` or `+++` (markdown rules, YAML separators, C++ operators)
 * is indistinguishable from a header once the diff marker is prepended.
 */
function extractChanges(body: string): {
    removed: string[];
    added: string[];
} {
    const removed: string[] = [];
    const added: string[] = [];
    let inHunk = false;

    for (const line of body.split('\n')) {
        if (line.startsWith('@@')) {
            inHunk = true;
        } else if (line.startsWith('diff --git ')) {
            // A rename can produce a second file header after the first hunk.
            inHunk = false;
        } else if (!inHunk) {
            continue; // preamble: index, mode, similarity, ---/+++ headers
        } else if (line.startsWith('+')) {
            added.push(line.slice(1));
        } else if (line.startsWith('-')) {
            removed.push(line.slice(1));
        }
        // Anything else inside a hunk is context (' ') or `\ No newline…`.
    }

    return { removed, added };
}
