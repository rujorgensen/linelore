import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRemote, withPullDiscussions } from './pr.js';
import type { Lineage, LineEvent } from './types.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function event(overrides: Partial<LineEvent>): LineEvent {
    return {
        sha: SHA_A,
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

const LINEAGE: Lineage = {
    file: 'src/auth.ts',
    startLine: 42,
    endLine: 42,
    events: [
        event({ sha: SHA_A, subject: 'harden token check' }),
        event({ sha: SHA_B, subject: 'initial auth guard', kind: 'born' }),
    ],
};

/**
 * A fetch stub that routes by URL substring. Unmatched URLs 404, so a test
 * only has to describe the endpoints it expects to be hit.
 */
function fakeApi(routes: Record<string, unknown>): {
    fetchFn: typeof fetch;
    calls: { url: string; init?: RequestInit }[];
} {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const key = Object.keys(routes).find((k) => String(url).includes(k));
        return {
            ok: key !== undefined,
            status: key === undefined ? 404 : 200,
            json: async () =>
                key === undefined ? { message: 'Not Found' } : routes[key],
        } as Response;
    }) as typeof fetch;
    return { fetchFn, calls };
}

const MERGED_PR = {
    number: 7,
    title: 'Harden auth against clock skew',
    body: '  We saw 30s skew in prod.  ',
    html_url: 'https://github.com/o/r/pull/7',
    user: { login: 'ada', type: 'User' },
    merged_at: '2026-02-01T00:00:00Z',
};

test('parses the remote-URL shapes git actually uses', () => {
    const expected = { owner: 'o', repo: 'r' };
    assert.deepEqual(parseGitHubRemote('https://github.com/o/r.git'), expected);
    assert.deepEqual(parseGitHubRemote('https://github.com/o/r'), expected);
    assert.deepEqual(parseGitHubRemote('git@github.com:o/r.git'), expected);
    assert.deepEqual(parseGitHubRemote('ssh://git@github.com/o/r'), expected);
    assert.deepEqual(
        parseGitHubRemote('https://user@github.com/o/r.git/'),
        expected,
    );
    assert.equal(parseGitHubRemote('https://gitlab.com/o/r.git'), undefined);
    assert.equal(parseGitHubRemote('/srv/git/r.git'), undefined);
    assert.equal(parseGitHubRemote(''), undefined);
});

test('tags PR-merged commits, leaves direct pushes untagged', async () => {
    const { fetchFn } = fakeApi({
        [`/repos/o/r/commits/${SHA_A}/pulls`]: [MERGED_PR],
        [`/repos/o/r/commits/${SHA_B}/pulls`]: [],
        '/repos/o/r/issues/7/comments': [
            {
                body: 'should the tolerance be configurable?',
                created_at: '2026-01-30T00:00:00Z',
                user: { login: 'bob', type: 'User' },
            },
            {
                body: 'CI passed',
                created_at: '2026-01-31T00:00:00Z',
                user: { login: 'ci[bot]', type: 'Bot' },
            },
        ],
        '/repos/o/r/pulls/7/comments': [
            {
                body: 'nit: extract a constant',
                created_at: '2026-01-29T00:00:00Z',
                user: { login: 'carol', type: 'User' },
            },
        ],
    });

    const enriched = await withPullDiscussions(
        LINEAGE,
        'git@github.com:o/r.git',
        { fetchFn, env: {} },
    );

    assert.equal(enriched.events[0]?.pr, 7);
    assert.equal(enriched.events[1]?.pr, undefined);
    assert.equal(enriched.pulls?.length, 1);

    const pull = enriched.pulls![0]!;
    assert.equal(pull.title, 'Harden auth against clock skew');
    assert.equal(pull.author, 'ada');
    assert.equal(pull.body, 'We saw 30s skew in prod.');
    // Review comment first (it is older), bot comment dropped.
    assert.deepEqual(
        pull.comments.map((c) => c.author),
        ['carol', 'bob'],
    );
});

test('an open PR that merely contains the commit is not its merger', async () => {
    const { fetchFn } = fakeApi({
        [`/repos/o/r/commits/${SHA_A}/pulls`]: [
            { ...MERGED_PR, number: 8, merged_at: null },
        ],
        [`/repos/o/r/commits/${SHA_B}/pulls`]: [],
    });

    const enriched = await withPullDiscussions(
        LINEAGE,
        'https://github.com/o/r',
        { fetchFn, env: {} },
    );

    assert.equal(enriched.events[0]?.pr, undefined);
    assert.deepEqual(enriched.pulls, []);
});

test('commits sharing a PR fetch its discussion once', async () => {
    const { fetchFn, calls } = fakeApi({
        '/pulls': [MERGED_PR], // both commits/*/pulls routes
        '/repos/o/r/issues/7/comments': [],
        '/repos/o/r/pulls/7/comments': [],
    });

    const enriched = await withPullDiscussions(
        LINEAGE,
        'https://github.com/o/r',
        { fetchFn, env: {} },
    );

    assert.equal(enriched.events[0]?.pr, 7);
    assert.equal(enriched.events[1]?.pr, 7);
    assert.equal(enriched.pulls?.length, 1);
    const discussionCalls = calls.filter((c) => c.url.includes('/7/comments'));
    assert.equal(discussionCalls.length, 2); // issue + review, once each
});

test('sends a user-agent always and a bearer token when one is set', async () => {
    const { fetchFn, calls } = fakeApi({
        '/pulls': [],
    });

    await withPullDiscussions(LINEAGE, 'https://github.com/o/r', {
        fetchFn,
        env: { GITHUB_TOKEN: 'ghp-test' },
    });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers['user-agent'], 'linelore');
    assert.equal(headers['authorization'], 'Bearer ghp-test');
    assert.equal(headers['x-github-api-version'], '2022-11-28');
});

test('anonymous requests carry no authorization header', async () => {
    const { fetchFn, calls } = fakeApi({ '/pulls': [] });
    await withPullDiscussions(LINEAGE, 'https://github.com/o/r', {
        fetchFn,
        env: {},
    });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers['authorization'], undefined);
});

test('GITHUB_API_URL redirects every call', async () => {
    const { fetchFn, calls } = fakeApi({ '/pulls': [] });
    await withPullDiscussions(LINEAGE, 'https://github.com/o/r', {
        fetchFn,
        env: { GITHUB_API_URL: 'http://localhost:9999/' },
    });
    assert.ok(calls.every((c) => c.url.startsWith('http://localhost:9999/')));
});

test('a non-GitHub remote fails before any network call', async () => {
    const { fetchFn, calls } = fakeApi({});
    await assert.rejects(
        withPullDiscussions(LINEAGE, 'git@gitlab.com:o/r.git', {
            fetchFn,
            env: {},
        }),
        /isn't on github\.com/,
    );
    await assert.rejects(
        withPullDiscussions(LINEAGE, '', { fetchFn, env: {} }),
        /no remote found/,
    );
    assert.equal(calls.length, 0);
});

test("surfaces GitHub's own error and hints at rate limits on 403", async () => {
    const fetchFn = (async () => ({
        ok: false,
        status: 403,
        json: async () => ({ message: 'API rate limit exceeded' }),
    })) as unknown as typeof fetch;

    await assert.rejects(
        withPullDiscussions(LINEAGE, 'https://github.com/o/r', {
            fetchFn,
            env: {},
        }),
        /API rate limit exceeded.*GITHUB_TOKEN/,
    );
});
