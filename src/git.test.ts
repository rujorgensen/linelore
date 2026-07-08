import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitMessage } from './git.js';

test('surfaces git\'s own explanation, without the fatal: prefix', () => {
    const err = { stderr: 'fatal: file f.txt has only 7 lines\n' };
    assert.equal(gitMessage(err, ['log']), 'file f.txt has only 7 lines');
});

test('uses the first non-blank stderr line', () => {
    const err = { stderr: '\n\nfatal: bad revision\nmore noise\n' };
    assert.equal(gitMessage(err, ['log']), 'bad revision');
});

test('falls back to the subcommand when stderr is empty', () => {
    assert.equal(gitMessage({ stderr: '' }, ['diff']), 'git diff failed');
    assert.equal(gitMessage(new Error('boom'), ['log']), 'git log failed');
    assert.equal(gitMessage(null, ['log']), 'git log failed');
});
