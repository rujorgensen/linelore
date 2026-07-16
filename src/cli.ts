#!/usr/bin/env node
import { resolve } from 'node:path';
import { trace } from './trace.js';
import { Git } from './git.js';
import { narrate, narratePulls, narrateWhy } from './narrate.js';
import { withPullDiscussions } from './pr.js';
import { synthesizeWhy, WHY_PROVIDERS, type WhyProvider } from './why.js';

const USAGE = `linelore — the lore of a line of code

Usage:
  linelore <file>:<line>            trace a single line
  linelore <file> <line>            trace a single line
  linelore <file> <start> <end>     trace a line range

Options:
  --json         emit structured JSON instead of the narrative
  --at-head      line numbers are HEAD's, not the working tree's
  --prs              pull in each commit's merging PR discussion (GitHub
                     remotes; GITHUB_TOKEN optional for private repos)
  --why              ask a model why the line evolved this way
  --provider <name>  API for --why: anthropic (default, needs
                     ANTHROPIC_API_KEY), mistral or vibe (needs
                     MISTRAL_API_KEY), or openai (any OpenAI-compatible
                     endpoint, needs OPENAI_API_KEY + --model)
  --model <id>       model for --why (defaults per provider)
  -h, --help         show this help

Examples:
  linelore src/auth.ts:42
  linelore src/auth.ts 40 55 --json
  linelore src/auth.ts:42 --prs
  linelore src/auth.ts:42 --why
  linelore src/auth.ts:42 --prs --why --provider mistral
`;

interface ParsedArgs {
    file: string;
    start: number;
    end: number;
    json: boolean;
    atHead: boolean;
    prs: boolean;
    why: boolean;
    provider: WhyProvider | undefined;
    model: string | undefined;
}

function parseProvider(value: string | undefined): WhyProvider {
    if (!value) throw new Error('--provider needs a value');
    // Vibe is Mistral's product; its API keys are Mistral API keys.
    if (value === 'vibe') return 'mistral';
    if (!(WHY_PROVIDERS as readonly string[]).includes(value)) {
        throw new Error(
            `unknown provider: ${value} (expected ${WHY_PROVIDERS.join(', ')})`,
        );
    }
    return value as WhyProvider;
}

/** Parse argv into a target file + line range. Throws on malformed input. */
function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    let json = false;
    let atHead = false;
    let prs = false;
    let why = false;
    let provider: WhyProvider | undefined;
    let model: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') json = true;
        else if (arg === '--at-head') atHead = true;
        else if (arg === '--prs') prs = true;
        else if (arg === '--why') why = true;
        else if (arg === '--provider') provider = parseProvider(argv[++i]);
        else if (arg.startsWith('--provider=')) {
            provider = parseProvider(arg.slice('--provider='.length));
        } else if (arg === '--model') {
            model = argv[++i];
            if (!model) throw new Error('--model needs a value');
        } else if (arg.startsWith('--model=')) {
            model = arg.slice('--model='.length);
            if (!model) throw new Error('--model needs a value');
        } else if (arg === '-h' || arg === '--help') throw new HelpRequested();
        else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        else positional.push(arg);
    }

    const base = { json, atHead, prs, why, provider, model };

    // `file:line` shorthand.
    if (positional.length === 1) {
        const m = positional[0]!.match(/^(.*):(\d+)$/);
        if (!m) throw new Error('expected <file>:<line> or <file> <line>');
        const line = Number(m[2]);
        return { file: m[1]!, start: line, end: line, ...base };
    }

    const [file, startRaw, endRaw] = positional;
    if (!file || startRaw === undefined) {
        throw new Error('missing file or line number');
    }
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error('line numbers must be integers');
    }
    return { file, start, end, ...base };
}

class HelpRequested extends Error {}

async function main(): Promise<void> {
    let parsed: ParsedArgs;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (err) {
        if (err instanceof HelpRequested) {
            process.stdout.write(USAGE);
            return;
        }
        process.stderr.write(`error: ${(err as Error).message}\n\n${USAGE}`);
        process.exitCode = 2;
        return;
    }

    try {
        let lineage = await trace(parsed.file, parsed.start, parsed.end, {
            atHead: parsed.atHead,
        });

        // A failed PR lookup must not cost the reel: note the error and
        // carry on with the un-enriched lineage.
        let prError: string | undefined;
        if (parsed.prs) {
            try {
                const remote = await Git.forFile(
                    resolve(parsed.file),
                ).remoteUrl();
                lineage = await withPullDiscussions(lineage, remote);
            } catch (err) {
                prError = (err as Error).message;
            }
        }
        const reportPrError = (): void => {
            if (!prError) return;
            process.stderr.write(`error: ${prError}\n`);
            process.exitCode = 1;
        };

        if (!parsed.why) {
            if (parsed.json) {
                process.stdout.write(JSON.stringify(lineage, null, 2) + '\n');
            } else {
                process.stdout.write(narrate(lineage) + '\n');
                if (lineage.pulls) {
                    process.stdout.write('\n' + narratePulls(lineage) + '\n');
                }
            }
            reportPrError();
            return;
        }

        // The reel is already in hand — show it before the synthesis round
        // trip, and keep it even if that round trip fails.
        if (!parsed.json) {
            process.stdout.write(narrate(lineage) + '\n\n');
            if (lineage.pulls) {
                process.stdout.write(narratePulls(lineage) + '\n\n');
            }
        }
        try {
            const why = await synthesizeWhy(lineage, {
                provider: parsed.provider,
                model: parsed.model,
            });
            process.stdout.write(
                parsed.json
                    ? JSON.stringify({ ...lineage, why }, null, 2) + '\n'
                    : narrateWhy(why) + '\n',
            );
        } catch (err) {
            if (parsed.json) {
                process.stdout.write(JSON.stringify(lineage, null, 2) + '\n');
            }
            process.stderr.write(`error: ${(err as Error).message}\n`);
            process.exitCode = 1;
        }
        reportPrError();
    } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`);
        process.exitCode = 1;
    }
}

main();
