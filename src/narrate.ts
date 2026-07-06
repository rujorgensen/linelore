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
export function narrate(lineage: Lineage, now = new Date()): string {
    const { file, startLine, endLine, events } = lineage;
    const out: string[] = [];

    const range = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    out.push(
        bold(`the lore of ${cyan(file)}:${cyan(range)}`),
    );

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
        out.push(`  ${e.subject}`);

        for (const line of e.removed) out.push(red(`      - ${line.trim()}`));
        for (const line of e.added) out.push(green(`      + ${line.trim()}`));
        out.push('');
    }

    return out.join('\n').trimEnd();
}
