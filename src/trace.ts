import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Git } from './git.js';
import { birthSite, parseBlame, parseLog } from './parse.js';
import { parseHunks, mapToHead } from './drift.js';
import { findFunction } from './func.js';
import type { Drift, Lineage, LineEvent } from './types.js';

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

    const root = await git.repoRoot(); // throws a friendly error if not a repo

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
            events: await followMoves(root, raw),
        };
    }

    if (!(await git.isTracked(abs))) {
        throw new Error(`file is not tracked by git: ${file}`);
    }

    const { start, end, drift } = options.atHead
        ? { start: startLine, end: endLine, drift: undefined }
        : await correctForDrift(git, abs, startLine, endLine);

    const raw = await git.logLineRange(abs, start, end);
    const events = await followMoves(root, raw);

    return { file, startLine: start, endLine: end, drift, events };
}

/**
 * Trace the full history of a named definition — a function, method, class,
 * or constant — by resolving its line span and tracing that.
 *
 * The name is resolved where the line numbers would be read from: the working
 * tree by default (what your editor shows), HEAD under `atHead`, the pinned
 * commit under `rev`. Resolution is heuristic (see {@link findFunction}); a
 * name that cannot be found is an error, never a guess.
 */
export async function traceFunc(
    file: string,
    name: string,
    options: TraceOptions = {},
): Promise<Lineage> {
    const abs = resolve(file);
    const git = Git.forFile(abs);

    await git.repoRoot();

    let source: string;
    let where = '';
    if (options.rev) {
        if (options.rev.startsWith('-')) {
            throw new Error(`not a commit: ${options.rev}`);
        }
        if (!(await git.existsAt(options.rev, abs))) {
            throw new Error(`file not found at ${options.rev}: ${file}`);
        }
        source = await git.contentAt(options.rev, abs);
        where = ` at ${options.rev}`;
    } else {
        if (!(await git.isTracked(abs))) {
            throw new Error(`file is not tracked by git: ${file}`);
        }
        if (options.atHead) {
            source = await git.contentAt('HEAD', abs);
            where = ' at HEAD';
        } else {
            source = await readFile(abs, 'utf8');
        }
    }

    const span = findFunction(source, name);
    if (!span) {
        throw new Error(
            `no definition of '${name}' found in ${file}${where} — the ` +
                `search is heuristic; a line range like ${file}:40 always works`,
        );
    }

    const lineage = await trace(file, span.start, span.end, options);
    return { ...lineage, func: name };
}

/** A chain of moves longer than this is almost certainly a cycle. */
const MAX_MOVES = 20;

/**
 * Parse a `git log -L` stream, then keep going where it stops short.
 *
 * `git log -L` follows edits and whole-file renames, but a block moved to
 * another file — or elsewhere in the same one — looks to it like brand-new
 * code: the reel ends at "extract helpers". So when the oldest event is a
 * birth, ask blame (bounded to that one commit, with move/copy detection)
 * where its lines were in the parent. If every line came from one place, as
 * one contiguous block, that birth was a move: relabel it and trace the block
 * from there. Anything partial or scattered stays a birth — never a guess.
 */
async function followMoves(root: string, raw: string): Promise<LineEvent[]> {
    const git = new Git(root);
    let events = parseLog(raw);

    for (let hop = 0; hop < MAX_MOVES; hop++) {
        const birth = events.at(-1);
        const site = birthSite(raw);
        if (birth?.kind !== 'born' || !site) break;

        let sources;
        try {
            sources = parseBlame(await git.blameCommit(birth.sha, join(root, site.path)));
        } catch {
            break; // a root commit has no parent to have moved from
        }
        const mine = sources.slice(site.start - 1, site.start - 1 + site.count);
        const [first] = mine;
        const contiguous = mine.every(
            (s, i) =>
                s.sha !== birth.sha &&
                s.sha === first!.sha &&
                s.file === first!.file &&
                s.line === first!.line + i,
        );
        if (!first || mine.length !== site.count || !contiguous) break;

        const movedFrom = {
            file: first.file,
            startLine: first.line,
            endLine: first.line + site.count - 1,
        };
        raw = await git.logLineRange(
            join(root, movedFrom.file),
            movedFrom.startLine,
            movedFrom.endLine,
            first.sha,
        );
        const older = parseLog(raw);
        if (older.length === 0) break;
        events = [...events.slice(0, -1), { ...birth, kind: 'moved', movedFrom }, ...older];
    }

    return events;
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
