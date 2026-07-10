#!/usr/bin/env node
import { trace } from './trace.js';
import { narrate, narrateWhy } from './narrate.js';
import { synthesizeWhy } from './why.js';

const USAGE = `linelore — the lore of a line of code

Usage:
  linelore <file>:<line>            trace a single line
  linelore <file> <line>            trace a single line
  linelore <file> <start> <end>     trace a line range

Options:
  --json         emit structured JSON instead of the narrative
  --at-head      line numbers are HEAD's, not the working tree's
  --why          ask Claude why the line evolved this way
                 (needs ANTHROPIC_API_KEY)
  --model <id>   model for --why (default: claude-opus-4-8)
  -h, --help     show this help

Examples:
  linelore src/auth.ts:42
  linelore src/auth.ts 40 55 --json
  linelore src/auth.ts:42 --why
`;

interface ParsedArgs {
    file: string;
    start: number;
    end: number;
    json: boolean;
    atHead: boolean;
    why: boolean;
    model: string | undefined;
}

/** Parse argv into a target file + line range. Throws on malformed input. */
function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    let json = false;
    let atHead = false;
    let why = false;
    let model: string | undefined;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--json') json = true;
        else if (arg === '--at-head') atHead = true;
        else if (arg === '--why') why = true;
        else if (arg === '--model') {
            model = argv[++i];
            if (!model) throw new Error('--model needs a value');
        } else if (arg.startsWith('--model=')) {
            model = arg.slice('--model='.length);
            if (!model) throw new Error('--model needs a value');
        } else if (arg === '-h' || arg === '--help') throw new HelpRequested();
        else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        else positional.push(arg);
    }

    const base = { json, atHead, why, model };

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
        const lineage = await trace(parsed.file, parsed.start, parsed.end, {
            atHead: parsed.atHead,
        });

        if (!parsed.why) {
            process.stdout.write(
                parsed.json
                    ? JSON.stringify(lineage, null, 2) + '\n'
                    : narrate(lineage) + '\n',
            );
            return;
        }

        // The reel is already in hand — show it before the synthesis round
        // trip, and keep it even if that round trip fails.
        if (!parsed.json) process.stdout.write(narrate(lineage) + '\n\n');
        try {
            const why = await synthesizeWhy(lineage, { model: parsed.model });
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
    } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`);
        process.exitCode = 1;
    }
}

main();
