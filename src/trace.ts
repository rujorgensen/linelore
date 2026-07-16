import { resolve } from 'node:path';
import { Git } from './git.js';
import { parseLog } from './parse.js';
import { parseHunks, mapToHead } from './drift.js';
import type { Drift, Lineage } from './types.js';

export interface TraceOptions {
    /**
     * Treat the given line numbers as HEAD line numbers and skip the
     * working-tree drift correction.
     */
    readonly atHead?: boolean;
    /**
     * Trace as of this commit-ish instead of the working tree. Line numbers
     * are `rev`'s own — a permalink pins both — so drift correction does not
     * apply, and the file only has to exist at `rev`, not on disk.
     */
    readonly rev?: string;
}

/**
 * Trace the full history of a line range in `file`, following it back through
 * edits and file renames via `git log -L`.
 *
 * Line numbers are interpreted as working-tree numbers — what you see in an
 * editor — and mapped back to HEAD first, unless `atHead` is set.
 */
export async function trace(
    file: string,
    startLine: number,
    endLine: number,
    options: TraceOptions = {},
): Promise<Lineage> {
    const abs = resolve(file);
    const git = Git.forFile(abs);

    await git.repoRoot(); // throws a friendly error if we're not in a repo

    if (options.rev) {
        // The rev may be pasted text (the web view); never let it reach git
        // looking like a flag.
        if (options.rev.startsWith('-')) {
            throw new Error(`not a commit: ${options.rev}`);
        }
        if (!(await git.existsAt(options.rev, abs))) {
            throw new Error(`file not found at ${options.rev}: ${file}`);
        }
        const raw = await git.logLineRange(abs, startLine, endLine, options.rev);
        return {
            file,
            startLine,
            endLine,
            drift: undefined,
            events: parseLog(raw),
        };
    }

    if (!(await git.isTracked(abs))) {
        throw new Error(`file is not tracked by git: ${file}`);
    }

    const { start, end, drift } = options.atHead
        ? { start: startLine, end: endLine, drift: undefined }
        : await correctForDrift(git, abs, startLine, endLine);

    const raw = await git.logLineRange(abs, start, end);
    const events = parseLog(raw);

    return { file, startLine: start, endLine: end, drift, events };
}

/** Range of HEAD lines to trace, plus a note if it isn't what was asked for. */
interface Corrected {
    readonly start: number;
    readonly end: number;
    readonly drift: Drift | undefined;
}

/**
 * Translate a working-tree line range into the HEAD range `git log -L` expects.
 *
 * A line the working tree *rewrote* is traced as the HEAD lines it replaced —
 * that history is precisely the "why" behind the line you are editing. A line
 * the working tree *added* has no HEAD counterpart at all, and we say so rather
 * than trace an unrelated line that happens to share its number.
 */
async function correctForDrift(
    git: Git,
    abs: string,
    startLine: number,
    endLine: number,
): Promise<Corrected> {
    const hunks = parseHunks(await git.diffFromHead(abs));
    if (hunks.length === 0) {
        return { start: startLine, end: endLine, drift: undefined };
    }

    const from = mapToHead(startLine, hunks);
    const to = mapToHead(endLine, hunks);

    if (from.kind === 'added' || to.kind === 'added') {
        const which = from.kind === 'added' ? startLine : endLine;
        throw new Error(
            `line ${which} is new in your working tree and has no committed ` +
                `history yet — commit it, or pass --at-head to trace line ` +
                `${which} as it stands at HEAD`,
        );
    }

    const start = from.kind === 'clean' ? from.line : from.start;
    const end = to.kind === 'clean' ? to.line : to.end;
    const rewritten = from.kind === 'modified' || to.kind === 'modified';

    // An in-place edit maps a line onto its own number, so equal numbers alone
    // don't mean "no drift" — the line is still uncommitted and what we trace
    // is the history of the text it replaced. Say so.
    if (!rewritten && start === startLine && end === endLine) {
        return { start, end, drift: undefined };
    }

    return {
        start,
        end,
        drift: { requestedStart: startLine, requestedEnd: endLine, rewritten },
    };
}
