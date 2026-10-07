import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowsDirectory = fileURLToPath(new URL('../workflows/', import.meta.url));

function createCommandFixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'code-tape-quality-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binDirectory = join(directory, 'bin');
  const callsPath = join(directory, 'calls.jsonl');
  mkdirSync(binDirectory);

  const fakeCommand = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS_PATH, JSON.stringify({ command, args }) + '\\n');
if (command === 'git') {
  if (args[0] === 'config') {
    if (args.includes('--get')) {
      if (!process.env.FAKE_HOOKS_PATH) process.exit(1);
      process.stdout.write(process.env.FAKE_HOOKS_PATH + '\\n');
    } else if (process.env.FAKE_GIT_FAIL_WRITE === '1') {
      process.stderr.write('git config is read-only\\n');
      process.exit(23);
    }
  } else if (args.includes('diff')) {
    process.stdout.write(process.env.FAKE_CHANGED_FILES ?? '');
  } else if (args.includes('ls-files')) {
    process.stdout.write(process.env.FAKE_UNTRACKED_FILES ?? '');
  }
}
`;
  for (const command of ['git', 'npx']) {
    const commandPath = join(binDirectory, command);
    writeFileSync(commandPath, fakeCommand);
    chmodSync(commandPath, 0o755);
  }

  const env = {
    ...process.env,
    CI: '',
    CONTRACT_CHANGED_FILES: '',
    GITHUB_BASE_REF: '',
    GITHUB_EVENT_PATH: '',
    CONTRACT_IMPACT_SUMMARY: '',
    GITNEXUS_IMPACT_SUMMARY: '',
    GITNEXUS_ANALYZE_TIMEOUT_MS: '',
    FAKE_HOOKS_PATH: '',
    FAKE_GIT_FAIL_WRITE: '',
    FAKE_CHANGED_FILES: '',
    FAKE_UNTRACKED_FILES: '',
    ...overrides,
    FAKE_CALLS_PATH: callsPath,
    PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
  };

  return {
    run(script, args = []) {
      return spawnSync(process.execPath, [join(workflowsDirectory, script), ...args], {
        cwd: directory,
        env,
        encoding: 'utf8',
      });
    },
    calls() {
      return existsSync(callsPath)
        ? readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : [];
    },
  };
}

test('hook installation succeeds without writing when this checkout already uses .githooks', (t) => {
  const fixture = createCommandFixture(t, {
    FAKE_HOOKS_PATH: '.githooks',
    FAKE_GIT_FAIL_WRITE: '1',
  });

  const result = fixture.run('install-hooks.mjs');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), [
    { command: 'git', args: ['config', '--local', '--get', 'core.hooksPath'] },
  ]);
});

test('hook installation configures the checkout when hooksPath is missing', (t) => {
  const fixture = createCommandFixture(t);

  const result = fixture.run('install-hooks.mjs');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), [
    { command: 'git', args: ['config', '--local', '--get', 'core.hooksPath'] },
    { command: 'git', args: ['config', '--local', 'core.hooksPath', '.githooks'] },
  ]);
});

test('hook installation skips git configuration in CI', (t) => {
  const fixture = createCommandFixture(t, { CI: 'true', FAKE_GIT_FAIL_WRITE: '1' });

  const result = fixture.run('install-hooks.mjs');

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fixture.calls(), []);
});

test('contract check reads the diff without invoking GitNexus', (t) => {
  const fixture = createCommandFixture(t, {
    FAKE_CHANGED_FILES: 'apps/web/src/features/editor/CodeEditor.tsx\n',
  });

  const result = fixture.run('contract-check.mjs', ['check']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contract: passed/u);
  assert.ok(fixture.calls().some((call) => call.command === 'git' && call.args.includes('diff')));
  assert.equal(fixture.calls().some((call) => call.command === 'npx'), false);
});

test('contract check still rejects critical changes without tests and impact summary in CI', (t) => {
  const fixture = createCommandFixture(t, {
    CI: 'true',
    GITHUB_BASE_REF: 'main',
    FAKE_CHANGED_FILES: 'apps/web/src/shared/recording-schema/validators.ts\n',
  });

  const result = fixture.run('contract-check.mjs', ['check']);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /contract: failed/u);
  assert.match(result.stdout, /Missing contract test for critical category: recording-schema/u);
  assert.match(result.stdout, /structured impact summary/u);
  const calls = fixture.calls();
  assert.ok(calls.some((call) => call.command === 'git' && call.args.includes('origin/main...HEAD')));
  assert.equal(calls.some((call) => call.command === 'npx'), false);
});

for (const command of ['local', 'gitnexus']) {
  test(`explicit contract ${command} runs GitNexus before checking the diff`, (t) => {
    const fixture = createCommandFixture(t, {
      FAKE_CHANGED_FILES: 'apps/web/src/features/editor/CodeEditor.tsx\n',
    });

    const result = fixture.run('contract-check.mjs', [command]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /contract: passed/u);
    const calls = fixture.calls();
    assert.equal(calls[0]?.command, 'npx');
    assert.ok(calls[0].args.includes('analyze'));
    assert.ok(calls.slice(1).some((call) => call.command === 'git' && call.args.includes('diff')));
  });
}
