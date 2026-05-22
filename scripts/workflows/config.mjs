export const defaultLabels = [
  { name: 'score:1', color: 'C2E0C6', description: '任务分数：1' },
  { name: 'score:2', color: 'C2E0C6', description: '任务分数：2' },
  { name: 'score:3', color: 'C2E0C6', description: '任务分数：3' },
  { name: 'score:5', color: 'C2E0C6', description: '任务分数：5' },
  { name: 'score:8', color: 'C2E0C6', description: '任务分数：8' },
  { name: 'stack:react', color: 'D4C5F9', description: '技术栈：React' },
  { name: 'stack:typescript', color: 'D4C5F9', description: '技术栈：TypeScript' },
  { name: 'stack:node', color: 'D4C5F9', description: '技术栈：Node.js' },
  { name: 'stack:github-actions', color: 'D4C5F9', description: '技术栈：GitHub Actions' },
  { name: 'stack:research', color: 'D4C5F9', description: '任务类型：调研' },
  { name: 'status:open', color: '0E8A16', description: '任务可认领' },
  { name: 'status:claimed', color: 'FBCA04', description: '任务已认领' },
];

export const progressJsonPath = 'docs/progress.json';
export const progressMarkdownPath = 'docs/progress.md';

export function nowIso() {
  return new Date().toISOString();
}

export function repoFromEnv(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) {
    throw new Error('GITHUB_REPOSITORY must be set as owner/repo');
  }
  const [owner, repo] = repository.split('/');
  return { owner, repo };
}
