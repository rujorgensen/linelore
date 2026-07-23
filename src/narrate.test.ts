import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrate, narratePulls } from './narrate.js';
import type { Lineage, LineEvent, PullDiscussion } from './types.js';

function event(overrides: Partial<LineEvent>): LineEvent {
    return {
        sha: 'a'.repeat(40),
        shortSha: 'aaaaaaaaa',
        author: 'Ada',
        date: '2026-01-01T00:00:00Z',
        subject: 'a change',
        removed: [],
        added: [],
        kind: 'edited',
        ...overrides,
    };
}

function lineage(overrides: Partial<Lineage>): Lineage {
    return {
        file: 'src/auth.ts',
        startLine: 42,
        endLine: 42,
        events: [event({})],
        ...overrides,
    };
}

const PULL: PullDiscussion = {
    number: 7,
    title: 'Harden auth against clock skew',
    author: 'ada',
    url: 'https://github.com/o/r/pull/7',
    body: 'We saw 30s skew in prod.',
    comments: [
        {
            author: 'bob',
            date: '2026-01-30T00:00:00Z',
            body: 'should the tolerance be configurable?',
        },
    ],
};

test('a function trace is titled by name, with its span on the stats line', () => {
    const text = narrate(
        lineage({ func: 'verifyToken', startLine: 40, endLine: 55 }),
    );
    assert.match(text, /the lore of src\/auth\.ts:verifyToken/);
    assert.match(text, /lines 40-55 · 1 change/);
});

test('a drifted function trace reports the working-tree lines it resolved', () => {
    const text = narrate(
        lineage({
            func: 'verifyToken',
            startLine: 38,
            endLine: 53,
            drift: { requestedStart: 40, requestedEnd: 55, rewritten: false },
        }),
    );
    assert.match(text, /the lore of src\/auth\.ts:verifyToken/);
    assert.match(text, /lines 40-55/);
    assert.match(text, /uncommitted changes above · that's HEAD 38-53/);
});

test('the reel tags PR-merged commits on the subject line', () => {
    const text = narrate(lineage({ events: [event({ pr: 7 })] }));
    assert.match(text, /a change · PR #7/);
});

test('the pulls section shows title, body, and comments', () => {
    const text = narratePulls(lineage({ pulls: [PULL] }));
    assert.match(text, /^pull requests$/m);
    assert.match(text, /#7 Harden auth against clock skew\s+— ada/);
    assert.match(text, /We saw 30s skew in prod\./);
    assert.match(text, /bob: should the tolerance be configurable\?/);
});

test('long comments are excerpted and the overflow is counted', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
        author: `user${i}`,
        date: `2026-01-0${i + 1}T00:00:00Z`,
        body: i === 0 ? 'x'.repeat(500) : 'short',
    }));
    const text = narratePulls(lineage({ pulls: [{ ...PULL, comments: many }] }));
    assert.match(text, /…/);
    assert.doesNotMatch(text, /x{300}/);
    assert.match(text, /… 3 more comments · https:\/\/github\.com\/o\/r\/pull\/7/);
});

test('no merged PRs is said, not left blank', () => {
    const text = narratePulls(lineage({ pulls: [] }));
    assert.match(text, /no merged pull request found/);
});
