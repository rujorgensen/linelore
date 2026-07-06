import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, basename } from 'node:path';

const run = promisify(execFile);

/**
 * Thin wrapper around the git CLI. Everything runs with `cwd` set to the
 * directory of the target file so relative pathspecs resolve, and with a
 * generous buffer since `-L` histories can be large.
 */
export class Git {
    constructor(private readonly cwd: string) {}

    static forFile(file: string): Git {
        return new Git(dirname(file) || '.');
    }

    private async git(args: readonly string[]): Promise<string> {
        const { stdout } = await run('git', args, {
            cwd: this.cwd,
            maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
    }

    /** Repo root, or throws a friendly error if we're not in a repo. */
    async repoRoot(): Promise<string> {
        try {
            return (await this.git(['rev-parse', '--show-toplevel'])).trim();
        } catch {
            throw new Error(`not a git repository: ${this.cwd}`);
        }
    }

    /** True if `path` (relative to cwd) is tracked. */
    async isTracked(path: string): Promise<boolean> {
        try {
            await this.git(['ls-files', '--error-unmatch', '--', path]);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Raw `git log -L` output for a line range, with a NUL/RS-delimited header
     * per commit so the patch stream can be parsed unambiguously.
     */
    async logLineRange(
        file: string,
        start: number,
        end: number,
    ): Promise<string> {
        const rel = basename(file);
        // \x1e (RS) marks a commit boundary; \x1f (US) separates header fields.
        const format = '%x1e%H%x1f%an%x1f%aI%x1f%s';
        return this.git([
            'log',
            '--no-color',
            `--format=${format}`,
            `-L${start},${end}:${rel}`,
        ]);
    }
}
