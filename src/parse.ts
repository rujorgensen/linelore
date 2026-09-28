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

/** Where the oldest commit in a `git log -L` stream left the traced range. */
export interface BirthSite {
    /** Repo-relative path of the file in that commit. */
    readonly path: string;
    /** 1-based first line and line count, in that commit's version. */
    readonly start: number;
    readonly count: number;
}

/**
 * The file and post-image range of the *last* record in a `git log -L`
 * stream — the commit where the line was born. Position-gated like
 * {@link extractChanges}: the path is the `+++` header before the first hunk.
 */
export function birthSite(raw: string): BirthSite | undefined {
    const last = raw.split(RS).filter((r) => r.trim()).at(-1);
    if (!last) return undefined;

    let path: string | undefined;
    for (const line of last.split('\n')) {
        if (line.startsWith('+++ b/') && path === undefined) {
            path = line.slice('+++ b/'.length);
        } else if (line.startsWith('@@')) {
            const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (!m || path === undefined) return undefined;
            return { path, start: Number(m[1]), count: Number(m[2] ?? 1) };
        }
    }
    return undefined;
}

/** One line of `git blame --line-porcelain`: where the line came from. */
export interface BlameSource {
    readonly sha: string;
    /** Repo-relative path in `sha`. */
    readonly file: string;
    /** 1-based line number in `sha`'s version of `file`. */
    readonly line: number;
}

/** Parse `git blame --line-porcelain` into one source per final line, in order. */
export function parseBlame(raw: string): BlameSource[] {
    const out: BlameSource[] = [];
    let sha = '';
    let line = 0;
    for (const l of raw.split('\n')) {
        const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(l);
        if (header) {
            sha = header[1]!;
            line = Number(header[2]);
        } else if (l.startsWith('filename ')) {
            // Always the last header field before the tab-prefixed content.
            out.push({ sha, file: l.slice('filename '.length), line });
        }
    }
    return out;
}
