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

Tracing works fully offline — it is all built on `git log -L`. The one
opt-in exception is [`--why`](#intent-synthesis---why), which brings its
own model.

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
linelore <file>:<line> --at-head  # line numbers are HEAD's, not the working tree's
linelore <file>:<line> --why      # ask Claude why the line evolved this way
```

### Uncommitted changes

Line numbers mean what your editor shows. If the file has uncommitted changes,
`linelore` maps the line back to `HEAD` before tracing it, so `:42` follows the
line you are actually looking at rather than whatever now sits at line 42 of the
last commit:

```
$ linelore src/auth.ts:42
the lore of src/auth.ts:42
  uncommitted changes above · that's HEAD 39
  ...
```

If the line is one you are editing right now, `linelore` traces the history of
the text it replaced — usually exactly the "why" you were reaching for. A line
you have only just typed has no history, and it says so instead of guessing.
Pass `--at-head` to opt out and number lines as of the last commit.

### Intent synthesis (`--why`)

The reel shows *what* changed; `--why` asks Claude to read the arc and say
*why*. It appends a short synthesis after the reel (or a `why` field to
`--json` output):

```
$ linelore src/auth.ts:42 --why
...the reel...

why
  The check was born strict and loosened deliberately: clock-skew failures
  pushed an exact comparison toward a tolerance window, and the constant
  extraction that followed was housekeeping around that same decision.
```

It is opt-in and bring-your-own-key: set `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`). `--model <id>` overrides the default
(`claude-opus-4-8`), and `ANTHROPIC_BASE_URL` is honored for proxies. The
prompt instructs the model to say when the record is too thin to support a
conclusion rather than invent one. Everything else works offline; this is
the only feature that talks to a network, and only when you ask.

## Roadmap

- [x] Trace a line range through history via `git log -L` (offline, zero-dep)
- [x] Structured `--json` output
- [x] **Intent synthesis** — an optional layer that reads the arc of changes and
      summarizes *why* the line evolved the way it did (opt-in, brings its own
      model): `--why`
- [x] Follow a line whose number has drifted in the working tree
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
