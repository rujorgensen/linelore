import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, basename } from 'node:path';

const run = promisify(execFile);

/**
 * Surface what git actually said. `execFile` rejects with "Command failed:
 * <the whole argv>", which buries git's own one-line explanation in stderr.
 */
export function gitMessage(err: unknown, args: readonly string[]): string {
    const stderr = String((err as { stderr?: unknown })?.stderr ?? '');
    const first = stderr.split('\n').find((l) => l.trim().length > 0);
    if (!first) return `git ${args[0] ?? ''} failed`.trim();
    return first.trim().replace(/^fatal:\s*/, '');
}

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
        try {
            const { stdout } = await run('git', args, {
                cwd: this.cwd,
                maxBuffer: 64 * 1024 * 1024,
            });
            return stdout;
        } catch (err) {
            throw new Error(gitMessage(err, args));
        }
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
     * Zero-context diff of the working tree (including staged changes) against
     * HEAD, for mapping working-tree line numbers back to HEAD.
     *
     * Returns '' when there is no HEAD to diff against (a repo with no commits),
     * which the caller correctly reads as "no drift".
     */
    async diffFromHead(file: string): Promise<string> {
        const rel = basename(file);
        try {
            return await this.git([
                'diff',
                '--no-color',
                '--no-ext-diff',
                '-U0',
                'HEAD',
                '--',
                rel,
            ]);
        } catch {
            return '';
        }
    }

    /**
     * URL of the `origin` remote, or '' when there is none — the caller turns
     * that into a friendlier error than git's own.
     */
    async remoteUrl(): Promise<string> {
        try {
            return (await this.git(['remote', 'get-url', 'origin'])).trim();
        } catch {
            return '';
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
