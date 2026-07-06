#!/usr/bin/env node
import { trace } from './trace.js';
import { narrate } from './narrate.js';

const USAGE = `linelore — the lore of a line of code

Usage:
  linelore <file>:<line>            trace a single line
  linelore <file> <line>            trace a single line
  linelore <file> <start> <end>     trace a line range

Options:
  --json     emit structured JSON instead of the narrative
  -h, --help show this help

Examples:
  linelore src/auth.ts:42
  linelore src/auth.ts 40 55 --json
`;

interface ParsedArgs {
    file: string;
    start: number;
    end: number;
    json: boolean;
}

/** Parse argv into a target file + line range. Throws on malformed input. */
function parseArgs(argv: readonly string[]): ParsedArgs {
    const positional: string[] = [];
    let json = false;

    for (const arg of argv) {
        if (arg === '--json') json = true;
        else if (arg === '-h' || arg === '--help') throw new HelpRequested();
        else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        else positional.push(arg);
    }

    // `file:line` shorthand.
    if (positional.length === 1) {
        const m = positional[0]!.match(/^(.*):(\d+)$/);
        if (!m) throw new Error('expected <file>:<line> or <file> <line>');
        const line = Number(m[2]);
        return { file: m[1]!, start: line, end: line, json };
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
    return { file, start, end, json };
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
        const lineage = await trace(parsed.file, parsed.start, parsed.end);
        if (parsed.json) {
            process.stdout.write(JSON.stringify(lineage, null, 2) + '\n');
        } else {
            process.stdout.write(narrate(lineage) + '\n');
        }
    } catch (err) {
        process.stderr.write(`error: ${(err as Error).message}\n`);
        process.exitCode = 1;
    }
}

main();
