# linelore

**The lore of a line of code.**

`git blame` tells you who last touched a line. It shows you a single frame.
`linelore` shows you the whole reel — every commit that shaped one line, back to
its birth, following it across edits and file renames.

```
$ linelore src/auth.ts:42

the lore of src/auth.ts:42
  4 changes · 1y ago → 3d ago

● 3f9a1c2e0  3d ago  Ada Lovelace
  harden token check against clock skew
      - if (exp < now) return false;
      + if (exp < now - SKEW_TOLERANCE) return false;

● a71d4b8c9  4mo ago  Ada Lovelace
  extract SKEW_TOLERANCE constant
      - if (exp < now - 30) return false;
      + if (exp < now - SKEW_TOLERANCE) return false;

✱ 0be2f1a77  1y ago  Ada Lovelace
  initial auth guard
      + if (exp < now) return false;
```

## Why

Source code records *what* is true now and discards *why* it got that way. The
reasoning — the dead ends, the load-bearing weirdness, the "we tried the obvious
thing and it broke" — lives in commit history, PR threads, and people's heads,
never in the file you're reading. `linelore` is a small step toward recovering
that: point it at a line and it reconstructs the line's story from the one place
the "why" is actually written down.

It works fully offline today. Everything below is built on `git log -L`.

## Install

```sh
npm install -g linelore
```

## Usage

```sh
linelore <file>:<line>            # trace a single line
linelore <file> <line>            # same, space-separated
linelore <file> <start> <end>     # trace a line range
linelore <file>:<line> --json     # structured output for tooling
```

## Roadmap

- [x] Trace a line range through history via `git log -L` (offline, zero-dep)
- [x] Structured `--json` output
- [ ] **Intent synthesis** — an optional layer that reads the arc of changes and
      summarizes *why* the line evolved the way it did (opt-in, brings its own
      model). The engine already exposes a clean `Lineage` object for this.
- [ ] Follow a line by content when its number has drifted in the working tree
- [ ] Pull in the merging PR's discussion for each commit
- [ ] A web view: paste a permalink, get the reel

## Development

```sh
npm install
npm run build          # tsc → dist/
npm run dev -- src/foo.ts:10
npm test
```

Zero runtime dependencies. Requires Node ≥ 20 and `git` on `PATH`.

## License

MIT
