import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWhyPrompt, synthesizeWhy } from './why.js';
import type { Lineage, LineEvent } from './types.js';

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

/** Newest-first lineage: an edit on top of a birth, like the real tracer emits. */
const LINEAGE: Lineage = {
    file: 'src/auth.ts',
    startLine: 42,
    endLine: 42,
    events: [
        event({
            subject: 'harden token check',
            removed: ['if (exp < now) return false;'],
            added: ['if (exp < now - SKEW) return false;'],
            date: '2026-02-01T00:00:00Z',
        }),
        event({
            subject: 'initial auth guard',
            added: ['if (exp < now) return false;'],
            kind: 'born',
            date: '2026-01-01T00:00:00Z',
        }),
    ],
};

/** A fetch stub that records its call and returns a canned response. */
function fakeFetch(
    body: unknown,
    { ok = true, status = 200 } = {},
): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        return {
            ok,
            status,
            json: async () => body,
        } as Response;
    }) as typeof fetch;
    return { fetchFn, calls };
}

const OK_RESPONSE = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'It hardened over time.' }],
};

test('prompt presents events oldest first with their diffs', () => {
    const prompt = buildWhyPrompt(LINEAGE);
    const birth = prompt.indexOf('initial auth guard');
    const edit = prompt.indexOf('harden token check');
    assert.ok(birth !== -1 && edit !== -1);
    assert.ok(birth < edit, 'birth should come before the later edit');
    assert.match(prompt, /^- if \(exp < now\) return false;$/m);
    assert.match(prompt, /^\+ if \(exp < now - SKEW\) return false;$/m);
    assert.match(prompt, /src\/auth\.ts, line 42/);
});

test('sends the request with API-key auth and the default model', async () => {
    const { fetchFn, calls } = fakeFetch(OK_RESPONSE);
    const text = await synthesizeWhy(LINEAGE, {
        fetchFn,
        env: { ANTHROPIC_API_KEY: 'sk-test' },
    });

    assert.equal(text, 'It hardened over time.');
    const [call] = calls;
    assert.equal(call?.url, 'https://api.anthropic.com/v1/messages');
    const headers = call!.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(String(call!.init.body));
    assert.equal(body.model, 'claude-opus-4-8');
    assert.match(body.messages[0].content, /initial auth guard/);
});

test('bearer-token auth adds the oauth beta header', async () => {
    const { fetchFn, calls } = fakeFetch(OK_RESPONSE);
    await synthesizeWhy(LINEAGE, {
        fetchFn,
        env: { ANTHROPIC_AUTH_TOKEN: 'oat-test' },
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer oat-test');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('a --model override and ANTHROPIC_BASE_URL are respected', async () => {
    const { fetchFn, calls } = fakeFetch(OK_RESPONSE);
    await synthesizeWhy(LINEAGE, {
        fetchFn,
        model: 'claude-haiku-4-5',
        env: {
            ANTHROPIC_API_KEY: 'sk-test',
            ANTHROPIC_BASE_URL: 'https://proxy.example',
        },
    });

    assert.equal(calls[0]?.url, 'https://proxy.example/v1/messages');
    assert.equal(
        JSON.parse(String(calls[0]!.init.body)).model,
        'claude-haiku-4-5',
    );
});

test('missing credentials fail before any network call', async () => {
    const { fetchFn, calls } = fakeFetch(OK_RESPONSE);
    await assert.rejects(
        synthesizeWhy(LINEAGE, { fetchFn, env: {} }),
        /ANTHROPIC_API_KEY/,
    );
    assert.equal(calls.length, 0);
});

test("surfaces the API's own error message", async () => {
    const { fetchFn } = fakeFetch(
        { error: { message: 'invalid x-api-key' } },
        { ok: false, status: 401 },
    );
    await assert.rejects(
        synthesizeWhy(LINEAGE, { fetchFn, env: { ANTHROPIC_API_KEY: 'bad' } }),
        /invalid x-api-key/,
    );
});

test('a refusal is reported, not rendered as a summary', async () => {
    const { fetchFn } = fakeFetch({ stop_reason: 'refusal', content: [] });
    await assert.rejects(
        synthesizeWhy(LINEAGE, { fetchFn, env: { ANTHROPIC_API_KEY: 'k' } }),
        /declined/,
    );
});

const OPENAI_STYLE_RESPONSE = {
    choices: [{ message: { content: 'It hardened over time.' } }],
};

test('mistral provider speaks chat-completions with its own key and default model', async () => {
    const { fetchFn, calls } = fakeFetch(OPENAI_STYLE_RESPONSE);
    const text = await synthesizeWhy(LINEAGE, {
        fetchFn,
        provider: 'mistral',
        env: { MISTRAL_API_KEY: 'mk-test' },
    });

    assert.equal(text, 'It hardened over time.');
    const [call] = calls;
    assert.equal(call?.url, 'https://api.mistral.ai/v1/chat/completions');
    const headers = call!.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer mk-test');
    const body = JSON.parse(String(call!.init.body));
    assert.equal(body.model, 'mistral-large-latest');
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[1].content, /initial auth guard/);
});

test('mistral without a key names MISTRAL_API_KEY', async () => {
    const { fetchFn, calls } = fakeFetch(OPENAI_STYLE_RESPONSE);
    await assert.rejects(
        synthesizeWhy(LINEAGE, { fetchFn, provider: 'mistral', env: {} }),
        /MISTRAL_API_KEY/,
    );
    assert.equal(calls.length, 0);
});

test('openai provider requires an explicit model', async () => {
    const { fetchFn, calls } = fakeFetch(OPENAI_STYLE_RESPONSE);
    await assert.rejects(
        synthesizeWhy(LINEAGE, {
            fetchFn,
            provider: 'openai',
            env: { OPENAI_API_KEY: 'ok-test' },
        }),
        /--model/,
    );
    assert.equal(calls.length, 0);
});

test('openai provider honors OPENAI_BASE_URL for compatible endpoints', async () => {
    const { fetchFn, calls } = fakeFetch(OPENAI_STYLE_RESPONSE);
    await synthesizeWhy(LINEAGE, {
        fetchFn,
        provider: 'openai',
        model: 'llama3',
        env: {
            OPENAI_API_KEY: 'ok-test',
            OPENAI_BASE_URL: 'http://localhost:11434',
        },
    });

    assert.equal(calls[0]?.url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(JSON.parse(String(calls[0]!.init.body)).model, 'llama3');
});

test("a mistral-style top-level error message is surfaced", async () => {
    const { fetchFn } = fakeFetch(
        { message: 'Unauthorized' },
        { ok: false, status: 401 },
    );
    await assert.rejects(
        synthesizeWhy(LINEAGE, {
            fetchFn,
            provider: 'mistral',
            env: { MISTRAL_API_KEY: 'bad' },
        }),
        /mistral API: Unauthorized/,
    );
});

test('an empty lineage is rejected without a request', async () => {
    const { fetchFn, calls } = fakeFetch(OK_RESPONSE);
    await assert.rejects(
        synthesizeWhy(
            { file: 'f.ts', startLine: 1, endLine: 1, events: [] },
            { fetchFn, env: { ANTHROPIC_API_KEY: 'k' } },
        ),
        /no history/,
    );
    assert.equal(calls.length, 0);
});
