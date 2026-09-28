import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace } from './trace.js';

const FN = [
    'export function parseWidgetConfiguration(input: string) {',
    '    return JSON.parse(input).widgetConfiguration ?? defaultWidgets;',
    '}',
];

/** A throwaway repo; every path is absolute, nothing depends on cwd. */
function repo(): { dir: string; commit: (files: Record<string, string[]>, msg: string) => void } {
    const dir = mkdtempSync(join(tmpdir(), 'linelore-'));
    const git = (...args: string[]) =>
        execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    git('init', '-q');
    return {
        dir,
        commit(files, msg) {
            for (const [path, lines] of Object.entries(files)) {
                mkdirSync(join(dir, path, '..'), { recursive: true });
                writeFileSync(join(dir, path), lines.join('\n') + '\n');
            }
            git('add', '-A');
            git('commit', '-qm', msg);
        },
    };
}

test('follows a block across files, through two moves, to its birth', async (t) => {
    const { dir, commit } = repo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    commit({ 'a.ts': ['const header = 1;', ...FN] }, 'born in a');
    commit({ 'a.ts': ['const header = 1;'], 'lib/w.ts': ['// widgets', ...FN] }, 'extract');
    commit({ 'lib/w.ts': ['// widgets'], 'b.ts': [...FN] }, 'move again');

    const { events } = await trace(join(dir, 'b.ts'), 1, 3, { atHead: true });

    assert.deepEqual(
        events.map((e) => [e.subject, e.kind, e.movedFrom?.file, e.movedFrom?.startLine]),
        [
            ['move again', 'moved', 'lib/w.ts', 2],
            ['extract', 'moved', 'a.ts', 2],
            ['born in a', 'born', undefined, undefined],
        ],
    );
});

test('a block edited on its way over stays a birth — no half-matched guess', async (t) => {
    const { dir, commit } = repo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    commit({ 'a.ts': ['const header = 1;', ...FN] }, 'born in a');
    const edited = [FN[0]!, FN[1]!.replace('widgetConfiguration', 'widgets'), FN[2]!];
    commit({ 'a.ts': ['const header = 1;'], 'b.ts': edited }, 'move and rename field');

    const { events } = await trace(join(dir, 'b.ts'), 1, 3, { atHead: true });

    assert.deepEqual(events.map((e) => [e.subject, e.kind]), [['move and rename field', 'born']]);
});
