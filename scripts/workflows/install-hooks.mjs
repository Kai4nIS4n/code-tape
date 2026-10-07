import { execFileSync } from 'node:child_process';

if (process.env.CI) {
  console.log('Skipping git hook installation in CI.');
  process.exit(0);
}

try {
  let currentHooksPath = '';
  try {
    currentHooksPath = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    if (err.status !== 1) throw err;
  }
  if (currentHooksPath === '.githooks') {
    console.log('Git hooks already installed; no configuration write needed.');
    process.exit(0);
  }
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  console.log('Git hooks installed via core.hooksPath=.githooks');
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`failed to install git hooks: ${message}`);
}
