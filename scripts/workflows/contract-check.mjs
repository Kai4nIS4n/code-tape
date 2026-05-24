import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  combineChangedFiles,
  evaluateGitNexusContract,
  sha256File,
  validateOpenVikingManifest,
} from './contract-rules.mjs';

const GITNEXUS_VERSION = '1.6.5';
const OPENVIKING_MANIFEST = 'docs/contracts/openviking.resources.json';

const command = process.argv[2] ?? 'check';

try {
  if (command === 'bootstrap') {
    runBootstrap();
  } else if (command === 'local') {
    runGitNexusContract({ mode: 'local' });
  } else if (command === 'gitnexus') {
    runGitNexusContract({ mode: 'ci' });
  } else if (command === 'openviking-check') {
    runOpenVikingCheck();
  } else if (command === 'check') {
    runOpenVikingCheck();
    runGitNexusContract({ mode: process.env.CI ? 'ci' : 'local' });
  } else {
    throw new Error(`unknown contract command: ${command}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

function runBootstrap() {
  console.log('Agent bootstrap complete.');
  console.log('- Before editing code: run npm run contract:local');
  console.log('- For critical skeleton changes: read GitNexus detect_changes/query/context/impact output');
  console.log('- Do not install hooks from this script; CI is the final contract gate.');
}

function runGitNexusContract({ mode }) {
  console.log(`Running GitNexus ${GITNEXUS_VERSION} analyze --force --index-only (${mode})...`);
  execFileSync('npx', ['--yes', `gitnexus@${GITNEXUS_VERSION}`, 'analyze', '--force', '--index-only'], {
    stdio: 'inherit',
  });

  const changedFiles = getChangedFiles(mode);
  const impactSummary = getImpactSummary();
  const result = evaluateGitNexusContract({ changedFiles, impactSummary });

  printContractResult('GitNexus contract', result);
  if (!result.ok) process.exitCode = 1;
}

function runOpenVikingCheck() {
  const manifest = readManifest();
  const result = validateOpenVikingManifest({
    manifest,
    fileExists: existsSync,
    sha256ForFile: sha256File,
  });

  printContractResult('OpenViking manifest', result);
  if (!result.ok) process.exitCode = 1;
}

function readManifest() {
  return JSON.parse(readFileSync(OPENVIKING_MANIFEST, 'utf8'));
}

function getChangedFiles(mode) {
  if (process.env.CONTRACT_CHANGED_FILES) {
    return process.env.CONTRACT_CHANGED_FILES.split(/\r?\n|,/).map((file) => file.trim()).filter(Boolean);
  }
  if (mode === 'ci' && process.env.GITHUB_BASE_REF) {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', process.env.GITHUB_BASE_REF], {
      stdio: 'inherit',
    });
    return gitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', `origin/${process.env.GITHUB_BASE_REF}...HEAD`]);
  }
  return combineChangedFiles(
    gitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD']),
    gitLines(['ls-files', '--others', '--exclude-standard']),
  );
}

function getImpactSummary() {
  if (process.env.GITNEXUS_IMPACT_SUMMARY) {
    return extractImpactSummary(process.env.GITNEXUS_IMPACT_SUMMARY);
  }
  if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    return extractImpactSummary(event.pull_request?.body ?? '');
  }
  return '';
}

function extractImpactSummary(text) {
  const marker = /GitNexus\s*影响分析摘要/i;
  const match = marker.exec(text);
  if (!match) return text.trim();
  const rest = text.slice(match.index + match[0].length);
  return rest.replace(/^[:：\s#-]*/u, '').split(/\n#{1,6}\s|\n##\s/)[0].trim();
}

function gitLines(args) {
  const output = execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function printContractResult(title, result) {
  console.log(`\n${title}: ${result.ok ? 'passed' : 'failed'}`);
  for (const reason of result.reasons ?? []) console.log(`- ${reason}`);
  for (const warning of result.warnings ?? []) console.log(`- warning: ${warning}`);
  if (result.critical?.length) {
    console.log('Critical contract files:');
    for (const item of result.critical) console.log(`- ${item.category}: ${item.file}`);
  }
  if (result.suggestions?.length) {
    console.log('GitNexus suggestions:');
    for (const suggestion of result.suggestions) console.log(`- ${suggestion}`);
  }
}
