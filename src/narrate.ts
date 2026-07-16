import type { Lineage, LineEvent } from './types.js';

/** Minimal zero-dependency ANSI helpers. Disabled when output isn't a TTY. */
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const c = (code: string) => (s: string) =>
    useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

const dim = c('2');
const bold = c('1');
const cyan = c('36');
const green = c('32');
const red = c('31');
const yellow = c('33');

function relativeDate(iso: string, now: Date): string {
    const then = new Date(iso).getTime();
    const days = Math.floor((now.getTime() - then) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
}

const KIND_GLYPH: Record<LineEvent['kind'], string> = {
    born: '✱',
    edited: '●',
    deleted: '✕',
};

/**
 * Render a {@link Lineage} as a human-readable terminal narrative, newest
 * change first. `now` is injected so output is deterministic in tests.
 */
const fmtRange = (start: number, end: number): string =>
    start === end ? `${start}` : `${start}-${end}`;

export function narrate(lineage: Lineage, now = new Date()): string {
    const { file, startLine, endLine, drift, events } = lineage;
    const out: string[] = [];

    // Name the line the *user* named; the HEAD range is an implementation
    // detail they only need when the two disagree.
    const asked = drift
        ? fmtRange(drift.requestedStart, drift.requestedEnd)
        : fmtRange(startLine, endLine);
    out.push(
        bold(`the lore of ${cyan(file)}:${cyan(asked)}`),
    );

    if (drift) {
        const head = fmtRange(startLine, endLine);
        out.push(
            dim(
                drift.rewritten
                    ? `  uncommitted here · tracing what it replaced, HEAD ${head}`
                    : `  uncommitted changes above · that's HEAD ${head}`,
            ),
        );
    }

    if (events.length === 0) {
        out.push(dim('  no history found for this line range'));
        return out.join('\n');
    }

    const span = `${relativeDate(events.at(-1)!.date, now)} → ${relativeDate(events[0]!.date, now)}`;
    out.push(dim(`  ${events.length} change${events.length === 1 ? '' : 's'} · ${span}`));
    out.push('');

    for (const e of events) {
        const glyph = e.kind === 'born'
            ? green(KIND_GLYPH.born)
            : e.kind === 'deleted'
                ? red(KIND_GLYPH.deleted)
                : yellow(KIND_GLYPH.edited);

        out.push(
            `${glyph} ${yellow(e.shortSha)}  ${dim(relativeDate(e.date, now))}  ${e.author}`,
        );
        out.push(`  ${e.subject}${e.pr ? dim(` · PR #${e.pr}`) : ''}`);

        for (const line of e.removed) out.push(red(`      - ${line.trim()}`));
        for (const line of e.added) out.push(green(`      + ${line.trim()}`));
        out.push('');
    }

    return out.join('\n').trimEnd();
}

/** Wrap `text` at `width` columns, breaking on spaces. */
function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const word of paragraph.split(/\s+/).filter(Boolean)) {
            if (line && line.length + 1 + word.length > width) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        }
        lines.push(line);
    }
    return lines;
}

/** Render the intent synthesis as a section that follows the reel. */
export function narrateWhy(text: string): string {
    const body = wrap(text, 72).map((l) => `  ${l}`);
    return [bold('why'), ...body].join('\n');
}

const MAX_COMMENTS = 5;
const MAX_EXCERPT = 280;

/** One readable line's worth of a comment: whitespace collapsed, capped. */
function excerpt(body: string): string {
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_EXCERPT
        ? flat.slice(0, MAX_EXCERPT - 1).trimEnd() + '…'
        : flat;
}

/**
 * Render the PR discussions as a section that follows the reel. The terminal
 * gets excerpts; the full text is in `--json`.
 */
export function narratePulls(lineage: Lineage): string {
    const pulls = lineage.pulls ?? [];
    const out: string[] = [bold('pull requests')];

    if (pulls.length === 0) {
        out.push(dim('  no merged pull request found for these commits'));
        return out.join('\n');
    }

    for (const p of pulls) {
        out.push(
            `${cyan(`#${p.number}`)} ${p.title}  ${dim(`— ${p.author}`)}`,
        );
        if (p.body) {
            for (const l of wrap(excerpt(p.body), 68)) out.push(dim(`    ${l}`));
        }
        for (const comment of p.comments.slice(0, MAX_COMMENTS)) {
            const lines = wrap(`${comment.author}: ${excerpt(comment.body)}`, 68);
            out.push(...lines.map((l, i) => (i === 0 ? `    ${l}` : `      ${l}`)));
        }
        const hidden = p.comments.length - MAX_COMMENTS;
        if (hidden > 0) {
            out.push(dim(`    … ${hidden} more comment${hidden === 1 ? '' : 's'} · ${p.url}`));
        }
        out.push('');
    }

    return out.join('\n').trimEnd();
}
