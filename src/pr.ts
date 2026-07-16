import type { Lineage, PullComment, PullDiscussion } from './types.js';

/**
 * Pull-request enrichment: for each commit in a lineage, find the PR that
 * merged it and fetch that PR's discussion.
 *
 * Opt-in and networked, like `--why`. Speaks the GitHub REST API with plain
 * `fetch` — no SDK, keeping the zero-runtime-dependency promise. Works
 * anonymously on public repos (within GitHub's rate limits); set GITHUB_TOKEN
 * (or GH_TOKEN) for private repos or more headroom.
 */

export interface PrOptions {
    /** Injected in tests. Defaults to the global fetch. */
    readonly fetchFn?: typeof fetch;
    /** Injected in tests. Defaults to process.env. */
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface GitHubRepo {
    readonly owner: string;
    readonly repo: string;
}

/**
 * Extract owner/repo from a github.com remote URL, in any of the shapes git
 * uses: https, ssh://, or scp-like git@ syntax. Returns undefined for remotes
 * that don't live on github.com.
 */
export function parseGitHubRemote(url: string): GitHubRepo | undefined {
    const m = url
        .trim()
        .match(
            /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/(?:git@)?)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
        );
    if (!m) return undefined;
    return { owner: m[1]!, repo: m[2]! };
}

/** The fields we read from GitHub's PR, comment, and user objects. */
interface ApiUser {
    readonly login?: string;
    readonly type?: string;
}
interface ApiPull {
    readonly number: number;
    readonly title?: string;
    readonly body?: string | null;
    readonly html_url?: string;
    readonly user?: ApiUser;
    readonly merged_at?: string | null;
}
interface ApiComment {
    readonly body?: string | null;
    readonly created_at?: string;
    readonly user?: ApiUser;
}

class GitHubApi {
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(
        private readonly fetchFn: typeof fetch,
        env: Readonly<Record<string, string | undefined>>,
    ) {
        this.base = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(
            /\/$/,
            '',
        );
        this.headers = {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            // GitHub rejects requests without a User-Agent, and Node's fetch
            // doesn't always send one.
            'user-agent': 'linelore',
        };
        const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
        if (token) this.headers['authorization'] = `Bearer ${token}`;
    }

    async get<T>(path: string): Promise<T> {
        let res: Response;
        try {
            res = await this.fetchFn(`${this.base}${path}`, {
                headers: this.headers,
            });
        } catch (err) {
            // Node's fetch says only "fetch failed" — name the culprit.
            throw new Error(
                `GitHub API unreachable: ${(err as Error).message}`,
            );
        }
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try {
                const json = (await res.json()) as { message?: string };
                if (json.message) detail = json.message;
            } catch {
                // keep the status-code fallback
            }
            const hint =
                res.status === 403 || res.status === 429
                    ? ' (set GITHUB_TOKEN for a higher rate limit)'
                    : '';
            throw new Error(`GitHub API: ${detail}${hint}`);
        }
        return (await res.json()) as T;
    }
}

const isBot = (user: ApiUser | undefined): boolean =>
    user?.type === 'Bot' || (user?.login ?? '').endsWith('[bot]');

const asComment = (c: ApiComment): PullComment => ({
    author: c.user?.login ?? 'unknown',
    date: c.created_at ?? '',
    body: (c.body ?? '').trim(),
});

/** The merged PR associated with a commit, or undefined for direct pushes. */
async function pullForCommit(
    api: GitHubApi,
    { owner, repo }: GitHubRepo,
    sha: string,
): Promise<ApiPull | undefined> {
    const pulls = await api.get<readonly ApiPull[]>(
        `/repos/${owner}/${repo}/commits/${sha}/pulls`,
    );
    // A commit can also sit in open PRs that merely contain it; the merging
    // one is the merged one.
    return pulls.find((p) => p.merged_at);
}

/** The PR's issue comments and review comments, interleaved oldest-first. */
async function discussionFor(
    api: GitHubApi,
    { owner, repo }: GitHubRepo,
    pull: ApiPull,
): Promise<PullDiscussion> {
    const [issueComments, reviewComments] = await Promise.all([
        api.get<readonly ApiComment[]>(
            `/repos/${owner}/${repo}/issues/${pull.number}/comments?per_page=100`,
        ),
        api.get<readonly ApiComment[]>(
            `/repos/${owner}/${repo}/pulls/${pull.number}/comments?per_page=100`,
        ),
    ]);

    const comments = [...issueComments, ...reviewComments]
        .filter((c) => !isBot(c.user) && (c.body ?? '').trim())
        .map(asComment)
        .sort((a, b) => a.date.localeCompare(b.date));

    return {
        number: pull.number,
        title: pull.title ?? '',
        author: pull.user?.login ?? 'unknown',
        url: pull.html_url ?? '',
        body: (pull.body ?? '').trim(),
        comments,
    };
}

/**
 * Return a copy of `lineage` where every event merged via a GitHub PR carries
 * its PR number, and `pulls` holds each PR's discussion once.
 *
 * Throws a friendly error when the remote isn't on github.com or the API
 * fails; commits without an associated merged PR are simply left untagged.
 */
export async function withPullDiscussions(
    lineage: Lineage,
    remoteUrl: string,
    options: PrOptions = {},
): Promise<Lineage> {
    const target = parseGitHubRemote(remoteUrl);
    if (!target) {
        throw new Error(
            `--prs only knows GitHub, and the remote isn't on github.com: ${remoteUrl || '(no remote found)'}`,
        );
    }

    const api = new GitHubApi(
        options.fetchFn ?? fetch,
        options.env ?? process.env,
    );

    const shas = [...new Set(lineage.events.map((e) => e.sha))];
    const bySha = new Map<string, ApiPull>();
    await Promise.all(
        shas.map(async (sha) => {
            const pull = await pullForCommit(api, target, sha);
            if (pull) bySha.set(sha, pull);
        }),
    );

    // Several commits can share one PR (a merge-commit-style PR contributes
    // every commit on its branch) — fetch each discussion once.
    const byNumber = new Map<number, ApiPull>();
    for (const pull of bySha.values()) byNumber.set(pull.number, pull);
    const pulls = await Promise.all(
        [...byNumber.values()].map((pull) => discussionFor(api, target, pull)),
    );
    pulls.sort((a, b) => a.number - b.number);

    return {
        ...lineage,
        events: lineage.events.map((e) => {
            const pull = bySha.get(e.sha);
            return pull ? { ...e, pr: pull.number } : e;
        }),
        pulls,
    };
}
