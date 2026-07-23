/**
 * Resolve a function (or class, method, constant — any named definition) to
 * the line span it occupies in a source file, so it can be traced like any
 * other line range.
 *
 * This is deliberately *not* `git log -L :funcname:` — git's funcname
 * detection needs a diff driver, and it ships none for JavaScript or
 * TypeScript, so indented class methods simply never match there. Instead we
 * find the definition line with a small set of language-agnostic patterns and
 * walk to the end of the body by bracket balance (brace languages) or
 * indentation (Python, Ruby, ...).
 *
 * It is a heuristic: brackets inside strings or comments are counted like any
 * others, and a definition it cannot recognize yields "not found" rather than
 * a guess. The caller should offer plain line numbers as the escape hatch.
 */

/** 1-based, inclusive line span of a definition. */
export interface FuncSpan {
    readonly start: number;
    readonly end: number;
}

/** Names we accept: plain identifiers, so they can be embedded in a regex. */
export function isFuncName(name: string): boolean {
    return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * Words that commonly precede a definition's name. Deliberately broad across
 * languages — a false keyword costs nothing unless it directly precedes the
 * searched-for name at the start of a line.
 */
const KEYWORDS =
    'export|default|declare|abstract|async|function\\*?|public|private|' +
    'protected|internal|static|final|readonly|override|get|set|const|let|' +
    'var|def|fn|pub|unsafe|extern|fun|func|val|class|interface|struct|' +
    'enum|trait|impl|type|namespace|module';

/** Statement keywords that must not be read as a C-style return type. */
const STATEMENTS =
    'return|if|for|while|switch|catch|throw|new|await|typeof|yield|else|' +
    'do|case|import|in|of';

/**
 * Find the line span of `name`'s definition in `source`, or undefined when
 * no line looks like one.
 */
export function findFunction(
    source: string,
    name: string,
): FuncSpan | undefined {
    if (!isFuncName(name)) return undefined;
    const lines = source.split('\n');
    const at = findDefinition(lines, name);
    if (at === -1) return undefined;
    return { start: at + 1, end: findEnd(lines, at) + 1 };
}

/**
 * Index of the definition line, or -1. Three passes over the whole file, in
 * decreasing order of confidence, so a keyworded definition anywhere beats a
 * bare `name(...)` call that happens to start an earlier line:
 *
 * 1. keyword-prefixed:  `export function name(`, `async name(`, `class name {`
 * 2. C-style signature: `static int name(args)` — type words before the name,
 *    no `;` on the line (which would make it a call or a prototype)
 * 3. bare:              `name(args) {`, `name: (x) =>`, `constructor(`
 */
function findDefinition(lines: readonly string[], name: string): number {
    const suffix = `[ \\t]*\\??[ \\t]*(?:[(<:={]|(?:extends|implements)\\b|\r?$)`;
    const passes = [
        new RegExp(
            `^[ \\t]*(?:(?:${KEYWORDS})[ \\t]+|func[ \\t]*\\([^)]*\\)[ \\t]+)+` +
                `${name}\\b${suffix}`,
        ),
        new RegExp(
            `^[ \\t]*(?!(?:${STATEMENTS})\\b)` +
                `(?:[A-Za-z_][\\w$]*[ \\t*&]+)+[*&]*${name}[ \\t]*\\([^;]*$`,
        ),
        new RegExp(`^[ \\t]*${name}\\b[ \\t]*\\??[ \\t]*[(<:=]`),
    ];

    for (const pattern of passes) {
        const at = lines.findIndex((l) => pattern.test(l));
        if (at !== -1) return at;
    }
    return -1;
}

/**
 * Index of the definition's last line. Brackets are balanced from the
 * definition line onward; once a `{` has opened and the balance returns to
 * zero, the body is closed. A signature that closes without ever opening a
 * brace is either Allman style (a lone `{` follows — keep counting) or a
 * braceless body (Python, Ruby, a one-line arrow) delimited by indentation.
 */
function findEnd(lines: readonly string[], defAt: number): number {
    let depth = 0;
    let sawBrace = false;

    for (let i = defAt; i < lines.length; i++) {
        for (const ch of lines[i]!) {
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            if (ch === '{') sawBrace = true;
        }
        if (depth > 0) continue;
        if (sawBrace) return i;

        const next = nextNonBlank(lines, i + 1);
        if (next !== -1 && /^[ \t]*\{/.test(lines[next]!)) continue;
        return walkIndent(lines, defAt, i);
    }

    // Brackets never balanced — a brace inside a string fooled the count, or
    // the file is truncated. Take everything to the last non-blank line.
    return lastNonBlank(lines, defAt);
}

/**
 * Indentation-delimited body: lines more indented than the definition belong
 * to it; the first line back at (or above) the definition's level ends it —
 * inclusively when that line is a closer (`}`, `)`, `]`, Ruby's `end`).
 */
function walkIndent(
    lines: readonly string[],
    defAt: number,
    sigEnd: number,
): number {
    const base = indentOf(lines[defAt]!);
    let end = sigEnd;

    for (let i = sigEnd + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        if (indentOf(line) > base) {
            end = i;
            continue;
        }
        return /^[ \t]*(?:[}\)\]]|end\b)/.test(line) ? i : end;
    }
    return end;
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

function nextNonBlank(lines: readonly string[], from: number): number {
    for (let i = from; i < lines.length; i++) {
        if (lines[i]!.trim()) return i;
    }
    return -1;
}

function lastNonBlank(lines: readonly string[], atLeast: number): number {
    for (let i = lines.length - 1; i > atLeast; i--) {
        if (lines[i]!.trim()) return i;
    }
    return atLeast;
}
