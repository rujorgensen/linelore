import type { GitHubRepo } from './pr.js';

/**
 * Parsing for the things a person pastes into the web view: a GitHub
 * permalink, or the same `file:line` shorthand the CLI takes.
 *
 * A blob URL's `<ref>/<path>` split is ambiguous from the text alone — branch
 * names may contain slashes — so the parser returns every plausible split and
 * the caller asks git which one actually exists. Permalinks minted with
 * GitHub's own "y" shortcut pin a 40-hex sha, so the first candidate is almost
 * always the right one.
 */

/** One way to read a URL's tail: everything up to `ref` names the commit. */
export interface TargetCandidate {
    /** Commit-ish to trace at; undefined means the local working tree. */
    readonly ref?: string;
    /** Repo-relative file path. */
    readonly path: string;
}

/** What the pasted text asked for, before git has resolved the ambiguity. */
export interface Target {
    /** Most-likely-first ways to split the input into ref + path. */
    readonly candidates: readonly TargetCandidate[];
    readonly start: number;
    readonly end: number;
    /** Present when the input named a repo, so the caller can check it. */
    readonly repo?: GitHubRepo;
}

/** `#L42`, `#L40-L55`, and GitHub's older `#L40-55`. */
function parseFragment(fragment: string): { start: number; end: number } | undefined {
    const m = fragment.match(/^L(\d+)(?:-L?(\d+))?$/);
    if (!m) return undefined;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    return start <= end ? { start, end } : { start: end, end: start };
}

function parseGitHubUrl(url: URL): Target {
    // /owner/repo/blob/<ref>/<path...>  (blame permalinks work identically)
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [owner, repo, kind, ...tail] = segments;
    if (!owner || !repo || (kind !== 'blob' && kind !== 'blame')) {
        throw new Error(
            'expected a file permalink: https://github.com/<owner>/<repo>/blob/<ref>/<path>#L<line>',
        );
    }
    if (tail.length < 2) {
        throw new Error('the permalink names no file');
    }

    const range = parseFragment(url.hash.replace(/^#/, ''));
    if (!range) {
        throw new Error(
            'the permalink has no line number — click a line number on GitHub first (#L42)',
        );
    }

    // Every split of the tail into ref + path, shortest ref first: a 40-hex
    // sha or a plain branch is one segment; `release/2.x` style branches eat
    // more. The caller keeps the first split git recognizes.
    const candidates: TargetCandidate[] = [];
    for (let i = 1; i < tail.length; i++) {
        candidates.push({
            ref: tail.slice(0, i).join('/'),
            path: tail.slice(i).join('/'),
        });
    }

    return {
        candidates,
        ...range,
        repo: { owner, repo: repo.replace(/\.git$/, '') },
    };
}

/**
 * Parse whatever was pasted: a GitHub permalink, or `path:42` / `path:40-55`
 * against the local working tree. Throws with a friendly message otherwise.
 */
export function parseTarget(input: string): Target {
    const text = input.trim();
    if (!text) throw new Error('nothing to trace — paste a permalink or file:line');

    if (/^https?:\/\//.test(text)) {
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            throw new Error(`not a valid URL: ${text}`);
        }
        if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') {
            throw new Error(
                `only github.com permalinks are understood, not ${url.hostname}`,
            );
        }
        return parseGitHubUrl(url);
    }

    const m = text.match(/^(.+?)(?::(\d+)(?:-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/);
    if (!m) {
        throw new Error(
            'expected a GitHub permalink or file:line (e.g. src/auth.ts:42)',
        );
    }
    const start = Number(m[2] ?? m[4]);
    const endRaw = m[3] ?? m[5];
    const end = endRaw === undefined ? start : Number(endRaw);
    return {
        candidates: [{ path: m[1]! }],
        start: Math.min(start, end),
        end: Math.max(start, end),
    };
}
