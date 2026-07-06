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
 * Pull the +/- lines out of a unified-diff body, ignoring the `+++`/`---`
 * file headers. Content is trimmed of the single leading diff marker only.
 */
function extractChanges(body: string): {
    removed: string[];
    added: string[];
} {
    const removed: string[] = [];
    const added: string[] = [];

    for (const line of body.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) added.push(line.slice(1));
        else if (line.startsWith('-')) removed.push(line.slice(1));
    }

    return { removed, added };
}
