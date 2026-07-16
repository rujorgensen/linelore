import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget } from './permalink.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('parses a single-line permalink pinned to a sha', () => {
    const t = parseTarget(
        `https://github.com/o/r/blob/${SHA}/src/auth.ts#L42`,
    );
    assert.deepEqual(t.repo, { owner: 'o', repo: 'r' });
    assert.equal(t.start, 42);
    assert.equal(t.end, 42);
    assert.deepEqual(t.candidates[0], { ref: SHA, path: 'src/auth.ts' });
});

test('parses a range fragment, in both GitHub styles', () => {
    const a = parseTarget(`https://github.com/o/r/blob/main/f.ts#L40-L55`);
    assert.equal(a.start, 40);
    assert.equal(a.end, 55);
    const b = parseTarget(`https://github.com/o/r/blob/main/f.ts#L40-55`);
    assert.equal(b.start, 40);
    assert.equal(b.end, 55);
});

test('a reversed range is normalized', () => {
    const t = parseTarget(`https://github.com/o/r/blob/main/f.ts#L55-L40`);
    assert.equal(t.start, 40);
    assert.equal(t.end, 55);
});

test('slashed branch names yield every split, shortest ref first', () => {
    const t = parseTarget(
        'https://github.com/o/r/blob/release/2.x/src/f.ts#L1',
    );
    assert.deepEqual(t.candidates, [
        { ref: 'release', path: '2.x/src/f.ts' },
        { ref: 'release/2.x', path: 'src/f.ts' },
        { ref: 'release/2.x/src', path: 'f.ts' },
    ]);
});

test('blame permalinks and encoded paths work too', () => {
    const t = parseTarget(
        'https://github.com/o/r/blame/main/docs/a%20file.md#L3',
    );
    assert.deepEqual(t.candidates[0], { ref: 'main', path: 'docs/a file.md' });
});

test('a permalink without a line number is refused, with advice', () => {
    assert.throws(
        () => parseTarget(`https://github.com/o/r/blob/main/f.ts`),
        /no line number/,
    );
});

test('non-file GitHub URLs and other hosts are refused', () => {
    assert.throws(
        () => parseTarget('https://github.com/o/r/pull/7'),
        /expected a file permalink/,
    );
    assert.throws(
        () => parseTarget('https://gitlab.com/o/r/-/blob/main/f.ts#L1'),
        /only github\.com/,
    );
});

test('file:line and file:start-end shorthands trace the working tree', () => {
    const a = parseTarget('src/auth.ts:42');
    assert.deepEqual(a.candidates, [{ path: 'src/auth.ts' }]);
    assert.equal(a.start, 42);
    assert.equal(a.end, 42);
    assert.equal(a.repo, undefined);

    const b = parseTarget('src/auth.ts:40-55');
    assert.equal(b.start, 40);
    assert.equal(b.end, 55);

    const c = parseTarget('src/auth.ts#L7');
    assert.equal(c.start, 7);
});

test('junk is refused with a hint at the accepted forms', () => {
    assert.throws(() => parseTarget(''), /nothing to trace/);
    assert.throws(() => parseTarget('src/auth.ts'), /file:line/);
    assert.throws(() => parseTarget('https://[bad'), /not a valid URL/);
});
