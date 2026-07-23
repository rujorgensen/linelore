import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFunction, isFuncName } from './func.js';

const ts = [
    'import { x } from "./x.js";',        // 1
    '',                                   // 2
    'export function top(a: number) {',   // 3
    '    return a + 1;',                  // 4
    '}',                                  // 5
    '',                                   // 6
    'export class Box {',                 // 7
    '    constructor(private n: number) {}', // 8
    '',                                   // 9
    '    async method(',                  // 10
    '        arg: string,',               // 11
    '    ): Promise<string> {',           // 12
    '        return arg + this.n;',       // 13
    '    }',                              // 14
    '}',                                  // 15
    '',                                   // 16
    'const arrow = (x: number) => x * 2;', // 17
    '',                                   // 18
    'const body = async (x: number) => {', // 19
    '    return x;',                      // 20
    '};',                                 // 21
].join('\n');

test('top-level function spans its braces', () => {
    assert.deepEqual(findFunction(ts, 'top'), { start: 3, end: 5 });
});

test('an indented class method is found (git -L :func never matches these)', () => {
    assert.deepEqual(findFunction(ts, 'method'), { start: 10, end: 14 });
});

test('a multi-line signature closing at base indent does not end the span', () => {
    // The `): Promise<string> {` line sits at the body's base indent; naive
    // indentation walking would stop there and lose the whole body.
    const span = findFunction(ts, 'method')!;
    assert.equal(span.end, 14);
});

test('a whole class can be traced by name', () => {
    assert.deepEqual(findFunction(ts, 'Box'), { start: 7, end: 15 });
});

test('constructor is found bare, without a keyword prefix', () => {
    assert.deepEqual(findFunction(ts, 'constructor'), { start: 8, end: 8 });
});

test('a one-line arrow constant is a one-line span', () => {
    assert.deepEqual(findFunction(ts, 'arrow'), { start: 17, end: 17 });
});

test('an arrow with a block body spans to its closing brace', () => {
    assert.deepEqual(findFunction(ts, 'body'), { start: 19, end: 21 });
});

test('a keyworded definition beats an earlier bare call', () => {
    const src = ['setup();', '', 'function setup() {', '    x();', '}'].join('\n');
    assert.deepEqual(findFunction(src, 'setup'), { start: 3, end: 5 });
});

test('an object-literal method spans its block', () => {
    const src = [
        'const handlers = {',
        '    onClick: async (e) => {',
        '        e.stop();',
        '    },',
        '    other: 1,',
        '};',
    ].join('\n');
    assert.deepEqual(findFunction(src, 'onClick'), { start: 2, end: 4 });
});

test('python: indentation delimits the body, blank lines included', () => {
    const src = [
        'import os',            // 1
        '',                     // 2
        'def compute(a, b):',   // 3
        '    x = a + b',        // 4
        '',                     // 5
        '    return x',         // 6
        '',                     // 7
        'def other():',         // 8
        '    pass',             // 9
    ].join('\n');
    assert.deepEqual(findFunction(src, 'compute'), { start: 3, end: 6 });
});

test('python: a multi-line signature keeps its indented body', () => {
    const src = [
        'def compute(',
        '    a,',
        '):',
        '    return a',
        '',
        'x = 1',
    ].join('\n');
    assert.deepEqual(findFunction(src, 'compute'), { start: 1, end: 4 });
});

test("ruby: the closing `end` belongs to the definition", () => {
    const src = ['def greet', '  puts "hi"', 'end', '', 'greet'].join('\n');
    assert.deepEqual(findFunction(src, 'greet'), { start: 1, end: 3 });
});

test('C: a typed signature is a definition, a call or prototype is not', () => {
    const src = [
        'int parse(char *s);',       // prototype — trailing ;
        '',
        'static int parse(char *s)', // definition, Allman brace below
        '{',
        '    return s[0];',
        '}',
    ].join('\n');
    assert.deepEqual(findFunction(src, 'parse'), { start: 3, end: 6 });
});

test('C: statement keywords are not read as return types', () => {
    const src = ['int use(void)', '{', '    return parse(s)', '}'].join('\n');
    // `return parse(s)` (no semicolon) must not be taken for a definition.
    assert.equal(findFunction(src, 'parse'), undefined);
});

test('go: a method with a receiver is found', () => {
    const src = [
        'func (g *Git) Root() string {',
        '    return g.root',
        '}',
    ].join('\n');
    assert.deepEqual(findFunction(src, 'Root'), { start: 1, end: 3 });
});

test('unbalanced brackets fall back to the last non-blank line', () => {
    const src = ['function broken() {', '    x();', ''].join('\n');
    assert.deepEqual(findFunction(src, 'broken'), { start: 1, end: 2 });
});

test('an unknown name is undefined, never a guess', () => {
    assert.equal(findFunction(ts, 'missing'), undefined);
});

test('only identifier-shaped names are searched for', () => {
    assert.equal(findFunction(ts, 'a b'), undefined);
    assert.equal(findFunction(ts, '42'), undefined);
    assert.ok(isFuncName('logLineRange'));
    assert.ok(isFuncName('$el'));
    assert.ok(!isFuncName('a.b'));
    assert.ok(!isFuncName('-flag'));
});

test('generics between name and parens are fine', () => {
    const src = ['export function pick<T>(xs: T[]): T {', '    return xs[0]!;', '}'].join('\n');
    assert.deepEqual(findFunction(src, 'pick'), { start: 1, end: 3 });
});
