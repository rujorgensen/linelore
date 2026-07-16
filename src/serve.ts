import { createServer, type Server } from 'node:http';
import { resolve, sep } from 'node:path';
import { Git } from './git.js';
import { trace } from './trace.js';
import { parseGitHubRemote } from './pr.js';
import { parseTarget } from './permalink.js';
import type { Lineage } from './types.js';

/**
 * The web view: a zero-dependency localhost server. Paste a GitHub permalink
 * (or the CLI's `file:line`), get the reel. Tracing happens against the local
 * clone the server was started in — the permalink's sha pins the ref, and
 * `git log -L` does the rest, offline.
 */

/** 5673 spells LORE on a phone keypad. */
export const DEFAULT_PORT = 5673;

export interface Resolved {
    readonly lineage: Lineage;
    /** The commit-ish the trace ran at; absent for working-tree traces. */
    readonly ref?: string;
}

/**
 * Resolve pasted text against the repo at `root` and trace it. Tries each
 * ref/path split of an ambiguous permalink until git recognizes one.
 */
export async function loreFor(root: string, input: string): Promise<Resolved> {
    const target = parseTarget(input);

    if (target.repo) {
        const remote = parseGitHubRemote(await new Git(root).remoteUrl());
        const same =
            remote &&
            remote.owner.toLowerCase() === target.repo.owner.toLowerCase() &&
            remote.repo.toLowerCase() === target.repo.repo.toLowerCase();
        if (!same) {
            const here = remote ? `${remote.owner}/${remote.repo}` : root;
            throw new Error(
                `that permalink is for ${target.repo.owner}/${target.repo.repo}, ` +
                    `but this server is rooted in ${here}`,
            );
        }
    }

    let firstErr: Error | undefined;
    for (const cand of target.candidates) {
        const abs = resolve(root, cand.path);
        if (abs !== root && !abs.startsWith(root + sep)) {
            throw new Error(`path escapes the repository: ${cand.path}`);
        }
        try {
            const lineage = await trace(abs, target.start, target.end, {
                rev: cand.ref,
            });
            // Show the repo-relative path the permalink named, not our
            // absolute one.
            return {
                lineage: { ...lineage, file: cand.path },
                ref: cand.ref,
            };
        } catch (err) {
            // A wrong ref/path split of a slashed branch name lands here;
            // keep the most-likely split's error in case none work out.
            firstErr ??= err as Error;
        }
    }
    throw firstErr ?? new Error('nothing to trace');
}

/** The request handler, separated from listen() so tests can drive it. */
export function createLoreServer(root: string): Server {
    return createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method !== 'GET') {
            res.writeHead(405).end();
            return;
        }
        if (url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(PAGE);
            return;
        }
        if (url.pathname === '/api/lore') {
            try {
                const result = await loreFor(
                    root,
                    url.searchParams.get('target') ?? '',
                );
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
}

/** Start serving the repo that contains `cwd`, on localhost only. */
export async function serve(cwd: string, port = DEFAULT_PORT): Promise<void> {
    const root = await new Git(cwd).repoRoot();
    const server = createLoreServer(root);
    await new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', ok);
    });
    process.stdout.write(
        `linelore serving ${root}\n  http://localhost:${port}\n` +
            `paste a GitHub permalink or a file:line — ctrl-c to stop\n`,
    );
}

/**
 * The page. Inline everything — the server has exactly two routes, and the
 * reel's look is the CLI's: dark, monospaced, same glyphs and colors. All
 * user- and repo-derived text enters the DOM via textContent, never markup.
 */
const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>linelore</title>
<style>
  :root {
    --bg: #101216; --fg: #d6d8de; --dim: #7d818c; --cyan: #6cc7d9;
    --yellow: #d9b96c; --green: #79c07a; --red: #d97a7a; --rule: #23262e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.55 ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  main { max-width: 78ch; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
  h1 { font-size: 1rem; font-weight: 600; margin: 0 0 .25rem; }
  h1 em { color: var(--cyan); font-style: normal; }
  p.tag { color: var(--dim); margin: 0 0 1.75rem; }
  form { display: flex; gap: .5rem; margin-bottom: 2.25rem; }
  input {
    flex: 1; background: #171a20; color: var(--fg); font: inherit;
    border: 1px solid var(--rule); border-radius: 6px; padding: .55rem .75rem;
  }
  input:focus { outline: none; border-color: var(--cyan); }
  button {
    background: var(--cyan); color: #0c2227; font: inherit; font-weight: 600;
    border: 0; border-radius: 6px; padding: .55rem 1rem; cursor: pointer;
  }
  #out { white-space: pre-wrap; overflow-wrap: anywhere; }
  .dim { color: var(--dim); }
  .cyan { color: var(--cyan); }
  .sha { color: var(--yellow); }
  .born { color: var(--green); }
  .edited { color: var(--yellow); }
  .deleted { color: var(--red); }
  .add { color: var(--green); }
  .del { color: var(--red); }
  .head { font-weight: 600; }
  .err { color: var(--red); }
  .event { margin: 0 0 1rem; }
</style>
<main>
  <h1><em>linelore</em> — the lore of a line of code</h1>
  <p class="tag">paste a GitHub permalink (#L42) or a file:line of this repo</p>
  <form id="f">
    <input id="q" placeholder="https://github.com/you/repo/blob/1a2b3c…/src/auth.ts#L42"
           autofocus spellcheck="false">
    <button>trace</button>
  </form>
  <div id="out"></div>
</main>
<script>
  const out = document.getElementById('out');
  const q = document.getElementById('q');

  const el = (cls, text) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  };
  const line = (...spans) => {
    const d = document.createElement('div');
    for (const s of spans) d.append(s);
    return d;
  };

  const rel = iso => {
    const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + 'd ago';
    if (days < 365) return Math.floor(days / 30) + 'mo ago';
    return Math.floor(days / 365) + 'y ago';
  };
  const GLYPH = { born: '\\u2731', edited: '\\u25cf', deleted: '\\u2715' };

  function render({ lineage, ref }) {
    out.replaceChildren();
    const range = lineage.startLine === lineage.endLine
      ? lineage.startLine : lineage.startLine + '-' + lineage.endLine;
    out.append(line(
      el('head', 'the lore of '),
      el('cyan head', lineage.file + ':' + range),
    ));
    if (ref) out.append(line(el('dim', '  at ' + ref)));
    if (lineage.drift) {
      out.append(line(el('dim', lineage.drift.rewritten
        ? '  uncommitted here \\u00b7 tracing what it replaced'
        : '  uncommitted changes above \\u00b7 that\\u2019s HEAD '
          + lineage.startLine)));
    }

    const ev = lineage.events;
    if (!ev.length) {
      out.append(line(el('dim', '  no history found for this line range')));
      return;
    }
    out.append(line(el('dim',
      '  ' + ev.length + ' change' + (ev.length === 1 ? '' : 's') +
      ' \\u00b7 ' + rel(ev[ev.length - 1].date) + ' \\u2192 ' + rel(ev[0].date))));
    out.append(document.createElement('br'));

    for (const e of ev) {
      const d = document.createElement('div');
      d.className = 'event';
      d.append(line(
        el(e.kind, GLYPH[e.kind]),
        el('sha', ' ' + e.shortSha), el('dim', '  ' + rel(e.date)),
        el(null, '  ' + e.author),
      ));
      d.append(line(el(null, '  ' + e.subject),
        ...(e.pr ? [el('dim', ' \\u00b7 PR #' + e.pr)] : [])));
      for (const t of e.removed) d.append(line(el('del', '      - ' + t.trim())));
      for (const t of e.added) d.append(line(el('add', '      + ' + t.trim())));
      out.append(d);
    }
  }

  async function go(target) {
    out.replaceChildren(line(el('dim', 'tracing\\u2026')));
    history.replaceState(null, '', '?t=' + encodeURIComponent(target));
    try {
      const res = await fetch('/api/lore?target=' + encodeURIComponent(target));
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      render(json);
    } catch (err) {
      out.replaceChildren(line(el('err', 'error: ' + err.message)));
    }
  }

  document.getElementById('f').addEventListener('submit', e => {
    e.preventDefault();
    if (q.value.trim()) go(q.value.trim());
  });
  const t = new URLSearchParams(location.search).get('t');
  if (t) { q.value = t; go(t); }
</script>
`;
