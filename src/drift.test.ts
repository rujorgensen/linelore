import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHunks, mapToHead, type Hunk } from './drift.js';

test('parses hunk headers, defaulting an omitted count to 1', () => {
    const diff = [
        'diff --git a/f.ts b/f.ts',
        'index 111..222 100644',
        '--- a/f.ts',
        '+++ b/f.ts',
        '@@ -1 +1 @@',
        '-a',
        '+A',
        '@@ -10,2 +10,3 @@',
        '-b',
        '-c',
        '+B',
        '+C',
        '+D',
    ].join('\n');

    assert.deepEqual(parseHunks(diff), [
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
        { oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 },
    ]);
});

test('parses an explicit zero count', () => {
    assert.deepEqual(parseHunks('@@ -4,0 +5,3 @@'), [
        { oldStart: 4, oldCount: 0, newStart: 5, newCount: 3 },
    ]);
});

test('no hunks means no drift', () => {
    assert.deepEqual(mapToHead(42, []), { kind: 'clean', line: 42 });
});

test('a hunk below the line does not shift it', () => {
    const hunks: Hunk[] = [{ oldStart: 90, oldCount: 1, newStart: 90, newCount: 5 }];
    assert.deepEqual(mapToHead(10, hunks), { kind: 'clean', line: 10 });
});

test('an insertion above the line shifts it up at HEAD', () => {
    // 3 lines inserted after old line 4 → working-tree 8 was HEAD 5.
    const hunks: Hunk[] = [{ oldStart: 4, oldCount: 0, newStart: 5, newCount: 3 }];
    assert.deepEqual(mapToHead(8, hunks), { kind: 'clean', line: 5 });
    assert.deepEqual(mapToHead(4, hunks), { kind: 'clean', line: 4 });
});

test('inserted lines themselves have no HEAD counterpart', () => {
    const hunks: Hunk[] = [{ oldStart: 4, oldCount: 0, newStart: 5, newCount: 3 }];
    for (const line of [5, 6, 7]) {
        assert.deepEqual(mapToHead(line, hunks), { kind: 'added' }, `line ${line}`);
    }
});

test('a deletion above the line shifts it down at HEAD', () => {
    // HEAD lines 5-7 deleted; git anchors the empty new range at new line 4.
    const hunks: Hunk[] = [{ oldStart: 5, oldCount: 3, newStart: 4, newCount: 0 }];
    assert.deepEqual(mapToHead(4, hunks), { kind: 'clean', line: 4 });
    assert.deepEqual(mapToHead(5, hunks), { kind: 'clean', line: 8 });
});

test('a rewritten line maps to the HEAD lines it replaced', () => {
    // HEAD 10-11 became working-tree line 10 alone.
    const hunks: Hunk[] = [{ oldStart: 10, oldCount: 2, newStart: 10, newCount: 1 }];
    assert.deepEqual(mapToHead(10, hunks), { kind: 'modified', start: 10, end: 11 });
    // The line after the hunk shifts by the net -1 the hunk applied.
    assert.deepEqual(mapToHead(11, hunks), { kind: 'clean', line: 12 });
});

test('shifts accumulate across several hunks above the line', () => {
    const hunks: Hunk[] = [
        { oldStart: 1, oldCount: 0, newStart: 2, newCount: 2 }, // +2
        { oldStart: 10, oldCount: 4, newStart: 12, newCount: 0 }, // -4
    ];
    // working tree 20 → 20 + (0-2) + (4-0) = 22
    assert.deepEqual(mapToHead(20, hunks), { kind: 'clean', line: 22 });
});

test('a line between two hunks only feels the one above it', () => {
    const hunks: Hunk[] = [
        { oldStart: 1, oldCount: 0, newStart: 2, newCount: 2 }, // +2, above
        { oldStart: 50, oldCount: 1, newStart: 52, newCount: 9 }, // below
    ];
    assert.deepEqual(mapToHead(30, hunks), { kind: 'clean', line: 28 });
});

test('a `@@` in added content is not read as a hunk header', () => {
    const diff = ['@@ -1 +1 @@', '-x', '+@@ -9,9 +9,9 @@'].join('\n');
    assert.deepEqual(parseHunks(diff), [
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
    ]);
});
