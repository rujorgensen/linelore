import type { Lineage } from './types.js';

/**
 * Intent synthesis: send a line's lineage to Claude and get back a short
 * reading of *why* it evolved the way it did.
 *
 * Opt-in and bring-your-own-key. The API is called with plain `fetch` rather
 * than the Anthropic SDK so the package keeps its zero-runtime-dependency
 * promise; Node ≥ 20 ships `fetch`.
 */

const DEFAULT_MODEL = 'claude-opus-4-8';
const ANTHROPIC_VERSION = '2023-06-01';

const SYSTEM_PROMPT = `You are a code historian. You will be given the complete git history of one line range — every commit that touched it, oldest first, with commit subjects and the exact before/after text.

In two to four sentences, explain why the line evolved the way it did: the motivations and pressures behind the changes, as far as the commit messages and diffs actually support them. Do not restate the diffs. Where the record is too thin to support a conclusion, say so plainly rather than inventing one — a wrong story told well is worse than no story.`;

export interface WhyOptions {
    /** Model ID to use. Defaults to claude-opus-4-8. */
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
    const out: string[] = [
        `History of ${lineage.file}, ${range} (oldest change first):`,
    ];

    for (const e of [...lineage.events].reverse()) {
        out.push('');
        out.push(`## ${e.date} — ${e.subject} (${e.shortSha}, ${e.kind})`);
        for (const line of e.removed) out.push(`- ${line}`);
        for (const line of e.added) out.push(`+ ${line}`);
    }

    return out.join('\n');
}

/** Resolve auth headers from the environment, or explain how to provide them. */
function authHeaders(
    env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
    if (env.ANTHROPIC_API_KEY) {
        return { 'x-api-key': env.ANTHROPIC_API_KEY };
    }
    if (env.ANTHROPIC_AUTH_TOKEN) {
        return {
            authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
            'anthropic-beta': 'oauth-2025-04-20',
        };
    }
    throw new Error(
        '--why needs an Anthropic API key: set ANTHROPIC_API_KEY ' +
            '(or ANTHROPIC_AUTH_TOKEN for OAuth tokens)',
    );
}

/** Shape of the Messages API response, reduced to the fields we read. */
interface MessagesResponse {
    readonly stop_reason?: string;
    readonly content?: readonly { type: string; text?: string }[];
    readonly error?: { message?: string };
}

/**
 * Ask Claude why the line evolved the way it did. Throws with a friendly
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
    const baseUrl = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';

    const res = await fetchFn(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            ...authHeaders(env),
        },
        body: JSON.stringify({
            model: options.model ?? DEFAULT_MODEL,
            max_tokens: 1024,
            thinking: { type: 'adaptive' },
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: buildWhyPrompt(lineage) }],
        }),
    });

    const json = (await res.json()) as MessagesResponse;

    if (!res.ok) {
        const detail = json.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`Anthropic API: ${detail}`);
    }
    if (json.stop_reason === 'refusal') {
        throw new Error('the model declined to summarize this history');
    }

    const text = (json.content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim();
    if (!text) throw new Error('the model returned no text');
    return text;
}
