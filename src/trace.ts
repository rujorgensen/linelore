import { resolve } from 'node:path';
import { Git } from './git.js';
import { parseLog } from './parse.js';
import type { Lineage } from './types.js';

/**
 * Trace the full history of a line range in `file`, following it back through
 * edits and file renames via `git log -L`.
 */
export async function trace(
    file: string,
    startLine: number,
    endLine: number,
): Promise<Lineage> {
    const abs = resolve(file);
    const git = Git.forFile(abs);

    await git.repoRoot(); // throws a friendly error if we're not in a repo
    if (!(await git.isTracked(abs))) {
        throw new Error(`file is not tracked by git: ${file}`);
    }

    const raw = await git.logLineRange(abs, startLine, endLine);
    const events = parseLog(raw);

    return { file, startLine, endLine, events };
}
