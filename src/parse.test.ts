import { test } from 'node:test';
import assert from 'node:assert/strict';
import { birthSite, parseBlame, parseLog } from './parse.js';

const RS = '\x1e';
const US = '\x1f';

/** Build one RS/US-delimited record the way `git log -L --format` emits it. */
function record(
    header: { sha: string; author: string; date: string; subject: string },
    diffBody: string,
): string {
    const { sha, author, date, subject } = header;
    return `${RS}${sha}${US}${author}${US}${date}${US}${subject}\n${diffBody}`;
}

test('parses a single edited line into before/after', () => {
    const raw = record(
        { sha: 'a'.repeat(40), author: 'Ada', date: '2026-01-01T00:00:00Z', subject: 'tweak' },
        [
            'diff --git a/f.ts b/f.ts',
            '--- a/f.ts',
            '+++ b/f.ts',
            '@@ -1,1 +1,1 @@',
            '-const x = 1;',
            '+const x = 2;',
        ].join('\n'),
    );

    const [e, ...rest] = parseLog(raw);
    assert.equal(rest.length, 0);
    assert.equal(e?.kind, 'edited');
    assert.deepEqual(e?.removed, ['const x = 1;']);
    assert.deepEqual(e?.added, ['const x = 2;']);
    assert.equal(e?.shortSha, 'aaaaaaaaa');
});

test('classifies a birth (only additions)', () => {
    const raw = record(
        { sha: 'b'.repeat(40), author: 'Bo', date: '2026-01-02T00:00:00Z', subject: 'add' },
        ['@@ -0,0 +1,1 @@', '+const y = 0;'].join('\n'),
    );
    assert.equal(parseLog(raw)[0]?.kind, 'born');
});

test('ignores +++/--- file headers when collecting changes', () => {
    const raw = record(
        { sha: 'c'.repeat(40), author: 'Cy', date: '2026-01-03T00:00:00Z', subject: 'x' },
        ['--- a/f.ts', '+++ b/f.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
    );
    const e = parseLog(raw)[0];
    assert.deepEqual(e?.removed, ['old']);
    assert.deepEqual(e?.added, ['new']);
});

test('keeps content lines that look like +++/--- file headers', () => {
    // A markdown `---` rule shows up as `----` once the `-` marker is prepended.
    const raw = record(
        { sha: 'd'.repeat(40), author: 'Di', date: '2026-01-04T00:00:00Z', subject: 'rule' },
        [
            'diff --git a/doc.md b/doc.md',
            '--- a/doc.md',
            '+++ b/doc.md',
            '@@ -2,1 +2,1 @@',
            '----',
            '+--- changed',
            '+++added',
        ].join('\n'),
    );
    const e = parseLog(raw)[0];
    assert.deepEqual(e?.removed, ['---']);
    assert.deepEqual(e?.added, ['--- changed', '++added']);
});

test('collects changes across multiple hunks in one commit', () => {
    const raw = record(
        { sha: 'e'.repeat(40), author: 'Eve', date: '2026-01-05T00:00:00Z', subject: 'two' },
        [
            '@@ -1,1 +1,1 @@',
            '-a',
            '+A',
            '@@ -9,1 +9,1 @@',
            ' context',
            '-b',
            '+B',
        ].join('\n'),
    );
    const e = parseLog(raw)[0];
    assert.deepEqual(e?.removed, ['a', 'b']);
    assert.deepEqual(e?.added, ['A', 'B']);
});

test('ignores the rename preamble that follows a hunk', () => {
    const raw = record(
        { sha: 'f'.repeat(40), author: 'Fi', date: '2026-01-06T00:00:00Z', subject: 'mv' },
        [
            '@@ -1,1 +1,1 @@',
            '-old',
            '+new',
            'diff --git a/x.ts b/y.ts',
            'similarity index 98%',
            '--- a/x.ts',
            '+++ b/y.ts',
        ].join('\n'),
    );
    const e = parseLog(raw)[0];
    assert.deepEqual(e?.removed, ['old']);
    assert.deepEqual(e?.added, ['new']);
});

test('returns newest-first for multiple commits', () => {
    const raw =
        record({ sha: '1'.repeat(40), author: 'A', date: '2026-02-01T00:00:00Z', subject: 'newer' },
            ['@@ -1 +1 @@', '-a', '+b'].join('\n')) +
        record({ sha: '2'.repeat(40), author: 'A', date: '2026-01-01T00:00:00Z', subject: 'older' },
            ['@@ -0,0 +1 @@', '+a'].join('\n'));

    const events = parseLog(raw);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.subject, 'newer');
    assert.equal(events[1]?.subject, 'older');
});

test('empty input yields no events', () => {
    assert.deepEqual(parseLog(''), []);
});

test('birthSite reads the oldest record\'s path and post-image range', () => {
    const newer = record(
        { sha: 'b'.repeat(40), author: 'A', date: 'd', subject: 'edit' },
        '\ndiff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -9,1 +9,1 @@\n-a\n+b',
    );
    const oldest = record(
        { sha: 'a'.repeat(40), author: 'A', date: 'd', subject: 'born' },
        // a content line that looks like a header must not be read as the path
        '\ndiff --git a/src/t.ts b/src/t.ts\n--- /dev/null\n+++ b/src/t.ts\n@@ -0,0 +2,3 @@\n++++ b/nope\n+x\n+y',
    );
    assert.deepEqual(birthSite(newer + oldest), { path: 'src/t.ts', start: 2, count: 3 });
    assert.deepEqual(
        birthSite(record({ sha: 'c'.repeat(40), author: '', date: '', subject: '' },
            '+++ b/f\n@@ -0,0 +7 @@\n+x')),
        { path: 'f', start: 7, count: 1 },
    );
    assert.equal(birthSite(''), undefined);
});

test('parseBlame yields one source per line, filename repeated per line', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const raw = [
        `${a} 1 1 1`, 'author t', 'summary s', 'filename token.ts', '\t// helpers',
        `${b} 2 2 2`, 'author t', 'boundary', 'filename src/auth.ts', '\tfilename fake',
        `${b} 3 3`, 'author t', 'boundary', 'filename src/auth.ts', '\t}',
    ].join('\n');
    assert.deepEqual(parseBlame(raw), [
        { sha: a, file: 'token.ts', line: 1 },
        { sha: b, file: 'src/auth.ts', line: 2 },
        { sha: b, file: 'src/auth.ts', line: 3 },
    ]);
});
