import type { Lineage } from './types.js';

/**
 * Intent synthesis: send a line's lineage to a language model and get back a
 * short reading of *why* it evolved the way it did.
 *
 * Opt-in and bring-your-own-key. Two wire protocols are spoken: Anthropic's
 * Messages API and the OpenAI-compatible chat-completions API (Mistral/Vibe,
 * OpenRouter, Ollama, ...). Both are called with plain `fetch` rather than a
 * vendor SDK so the package keeps its zero-runtime-dependency promise;
 * Node ≥ 20 ships `fetch`.
 */

const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT = `You are a code historian. You will be given the complete git history of one line range — every commit that touched it, oldest first, with commit subjects and the exact before/after text, and sometimes the pull-request discussions that merged them.

In two to four sentences, explain why the line evolved the way it did: the motivations and pressures behind the changes, as far as the commit messages, diffs, and discussions actually support them. Do not restate the diffs. Where the record is too thin to support a conclusion, say so plainly rather than inventing one — a wrong story told well is worse than no story.`;

export type WhyProvider = 'anthropic' | 'mistral' | 'openai';

export const WHY_PROVIDERS: readonly WhyProvider[] = [
    'anthropic',
    'mistral',
    'openai',
];

export interface WhyOptions {
    /** Which API to call. Defaults to 'anthropic'. */
    readonly provider?: WhyProvider;
    /**
     * Model ID. Defaults per provider (anthropic: claude-opus-4-8,
     * mistral: mistral-large-latest); required for the generic 'openai'
     * provider, whose endpoints share no common default.
     */
    readonly model?: string;
    /** Injected in tests. Defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;
    /** Injected in tests. Defaults to process.env. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Render a {@link Lineage} as the model-facing document: chronological
 * (oldest → newest, the reverse of display order), one block per commit.
 */
export function buildWhyPrompt(lineage: Lineage): string {
    const range =
        lineage.startLine === lineage.endLine
            ? `line ${lineage.startLine}`
            : `lines ${lineage.startLine}-${lineage.endLine}`;
    const target = lineage.func ? `${lineage.func} (${range})` : range;
    const out: string[] = [
        `History of ${lineage.file}, ${target} (oldest change first):`,
    ];

    for (const e of [...lineage.events].reverse()) {
        out.push('');
        const via = e.pr === undefined ? '' : `, merged by PR #${e.pr}`;
        out.push(`## ${e.date} — ${e.subject} (${e.shortSha}, ${e.kind}${via})`);
        for (const line of e.removed) out.push(`- ${line}`);
        for (const line of e.added) out.push(`+ ${line}`);
    }

    for (const p of lineage.pulls ?? []) {
        out.push('');
        out.push(`## Discussion of PR #${p.number}: ${p.title} (by ${p.author})`);
        if (p.body) out.push(p.body);
        for (const c of p.comments) out.push(`${c.author}: ${c.body}`);
    }

    return out.join('\n');
}

type Env = Readonly<Record<string, string | undefined>>;

/** A fully-formed HTTP request plus how to read its provider's answer. */
interface WireRequest {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
    /** Pull the synthesis text (and any refusal) out of a 2xx body. */
    readonly extract: (json: WireResponse) => string;
}

/** Union of the response fields either protocol may hand back. */
interface WireResponse {
    readonly stop_reason?: string;
    readonly content?: readonly { type: string; text?: string }[];
    readonly choices?: readonly { message?: { content?: string } }[];
    readonly error?: { message?: string };
    /** Mistral puts error messages at the top level. */
    readonly message?: string;
}

function anthropicRequest(prompt: string, model: string, env: Env): WireRequest {
    const headers: Record<string, string> = {
        'anthropic-version': ANTHROPIC_VERSION,
    };
    if (env.ANTHROPIC_API_KEY) {
        headers['x-api-key'] = env.ANTHROPIC_API_KEY;
    } else if (env.ANTHROPIC_AUTH_TOKEN) {
        headers['authorization'] = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
        headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
        throw new Error(
            '--why needs an Anthropic API key: set ANTHROPIC_API_KEY ' +
                '(or ANTHROPIC_AUTH_TOKEN for OAuth tokens)',
        );
    }

    return {
        url: `${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`,
        headers,
        body: {
            model,
            max_tokens: 1024,
            thinking: { type: 'adaptive' },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
        },
        extract: (json) => {
            if (json.stop_reason === 'refusal') {
                throw new Error(
                    'the model declined to summarize this history',
                );
            }
            return (json.content ?? [])
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text)
                .join('\n');
        },
    };
}

function openAiRequest(
    prompt: string,
    model: string,
    env: Env,
    baseUrl: string,
    keyVar: string,
): WireRequest {
    const key = env[keyVar];
    if (!key) {
        throw new Error(`--why needs an API key: set ${keyVar}`);
    }

    return {
        url: `${baseUrl}/v1/chat/completions`,
        headers: { authorization: `Bearer ${key}` },
        body: {
            model,
            max_tokens: 1024,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
        },
        extract: (json) =>
            (json.choices ?? [])
                .map((c) => c.message?.content ?? '')
                .join('\n'),
    };
}

function buildRequest(
    provider: WhyProvider,
    prompt: string,
    model: string | undefined,
    env: Env,
): WireRequest {
    switch (provider) {
        case 'anthropic':
            return anthropicRequest(prompt, model ?? 'claude-opus-4-8', env);
        case 'mistral':
            return openAiRequest(
                prompt,
                model ?? 'mistral-large-latest',
                env,
                env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai',
                'MISTRAL_API_KEY',
            );
        case 'openai': {
            if (!model) {
                throw new Error(
                    '--provider openai needs an explicit --model — ' +
                        'OpenAI-compatible endpoints share no default',
                );
            }
            return openAiRequest(
                prompt,
                model,
                env,
                env.OPENAI_BASE_URL ?? 'https://api.openai.com',
                'OPENAI_API_KEY',
            );
        }
    }
}

/**
 * Ask a model why the line evolved the way it did. Throws with a friendly
 * message on missing credentials, API errors, or a refusal.
 */
export async function synthesizeWhy(
    lineage: Lineage,
    options: WhyOptions = {},
): Promise<string> {
    if (lineage.events.length === 0) {
        throw new Error('no history to synthesize');
    }

    const env = options.env ?? process.env;
    const fetchFn = options.fetchFn ?? fetch;
    const req = buildRequest(
        options.provider ?? 'anthropic',
        buildWhyPrompt(lineage),
        options.model,
        env,
    );

    const res = await fetchFn(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
    });

    const json = (await res.json()) as WireResponse;

    if (!res.ok) {
        const detail =
            json.error?.message ?? json.message ?? `HTTP ${res.status}`;
        throw new Error(`${options.provider ?? 'anthropic'} API: ${detail}`);
    }

    const text = req.extract(json).trim();
    if (!text) throw new Error('the model returned no text');
    return text;
}
