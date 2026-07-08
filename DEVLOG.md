# DEVLOG

Working notes. Newest first. Reasoning, verification, and mistakes — the stuff
that doesn't belong in a commit message but is worth not re-deriving.

## 2026-07-08 — working-tree line numbers (`feat/worktree-drift`)

`git log -L42,42:file` numbers lines as of HEAD; an editor numbers them as of the
working tree. With uncommitted changes above the line they disagree, and linelore
narrated — confidently — the history of whatever unrelated line sat at HEAD's 42.
Same failure class as the parse bug below: a wrong story, told well. That's the
one failure this tool must not have.

`src/drift.ts` replays the hunks of `git diff -U0 HEAD -- <file>` to map a
working-tree line back to HEAD. Three outcomes:

- **shifted** → trace its HEAD number, note the move
- **rewritten** → trace the HEAD lines it *replaced*; that history is usually the
  "why" behind the edit in progress
- **newly typed** → no committed history; say so rather than guess

`--at-head` opts out. `Lineage.drift` carries it into `--json`.

Hunk math worth remembering: for a pure deletion git emits `@@ -a,b +c,0 @@` where
`c` is the line *before* the deletion on the new side. So the hunk's last new line
is `c` itself and its first is `c + 1` — an empty range. Getting this backwards
shifts every line after a deletion by one. Real git also emits `+0,0` for a
deletion at the top of a file, which the same formula handles.

Two bugs the unit tests didn't catch, both found by actually running the thing:

1. The rewritten case never printed its note. An in-place edit maps line 5 → 5, so
   the `start === startLine` early-return suppressed the drift record. The
   narration existed and was unreachable. Equal line numbers do **not** mean "no
   drift" — check `rewritten` first.
2. `execFile` rejects with `Command failed: <entire argv>`, burying git's own
   `fatal: file f.txt has only 7 lines`. Added `gitMessage()` to surface stderr's
   first line.

Verified against a real scratch repo: insertion-above, deletion-above, in-place
rewrite, rewrite+shift, brand-new line, clean tree — each checked against actual
`git diff -U0` output rather than my model of it. Then dogfooded on `narrate.ts`
with five uncommitted hunks: line 70 → HEAD 52, hand-checked.

## 2026-07-08 — diff-header collision (`fix/diff-header-collision`)

`extractChanges` skipped any line starting with `---` or `+++` to avoid the
unified-diff file headers. But once git prepends the `-`/`+` marker, a source line
whose own text starts with those characters is indistinguishable from a header: a
markdown rule `---` arrives as `----`, a removed `++x` as `-++x`.

Those lines were dropped, which also corrupted `kind`. Tracing a markdown `---`
reported the line as *born* in its most recent edit — the removed side had
vanished, leaving only the addition.

Fix: gate on hunk position. `---`/`+++` are headers only before the first `@@`.
Reset on `diff --git`, which git emits again after a hunk when a rename is
involved.

Lesson, since it recurred in `drift.ts`: **never identify a diff line by its
content prefix.** Position within the hunk is the only reliable signal. `parseHunks`
anchors `@@` to column 0 for the same reason.

## 2026-07-08 — process note

Building a scratch repro repo, I ran `cd <glob> && rm -rf ll && git init` followed
by newline-separated commands. The glob matched two session dirs, which zsh read as
`cd old new` (its string-replace form), so the `cd` failed. `&&` short-circuited
only its own chain — the lines below ran in the linelore repo, creating a nested
`git init`, a stray `doc.md`, and two junk commits on `main`. Unpushed; recovered
with `git reset --mixed 76cd3bf`.

The `&&` looked like protection and was not. It never guarded the lines beneath it.
Rule: no command's target may be implied by cwd. Absolute paths, `git -C <dir>`.
