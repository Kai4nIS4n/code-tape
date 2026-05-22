import { loadPrGuardContextForPull } from './action-context.mjs';
import { GitHubClient } from './github-client.mjs';
import { hasStatus } from './issue-parser.mjs';
import { isTimedOut, parseClosingIssues } from './pr-parser.mjs';

const client = new GitHubClient();
const pulls = await client.listOpenPulls();
const now = new Date().toISOString();

for (const pull of pulls) {
  if (!isTimedOut(pull.created_at, now)) {
    continue;
  }

  const context = await loadPrGuardContextForPull(client, pull.number);
  const closingIssues = parseClosingIssues(context.rawPull.body ?? '');
  if (closingIssues.length !== 1 || !context.rawIssue) {
    console.log(`skip PR #${pull.number}: no single closing issue`);
    continue;
  }
  if (!hasStatus(context.rawIssue.labels, 'claimed')) {
    console.log(`skip PR #${pull.number}: issue #${context.rawIssue.number} is not claimed`);
    continue;
  }
  if (context.rawIssue.assignee?.login !== context.rawPull.user.login) {
    console.log(`skip PR #${pull.number}: author is not issue assignee`);
    continue;
  }

  await client.comment(
    pull.number,
    [
      '该 PR 创建后 24 小时内未达到自动合并条件，已由工作流关闭。',
      '',
      `关联 Issue #${context.rawIssue.number} 仍保持认领状态，任务不会释放。`,
      '请认领者修正后重新提交 PR，新 PR 会重新开始 24 小时计时。',
    ].join('\n'),
  );
  await client.closePull(pull.number);

  if (context.pr.headRepoFullName === context.pr.baseRepoFullName && context.pr.headRef !== 'main') {
    await client.deleteBranch(context.pr.headRef);
  }

  console.log(`closed timed-out PR #${pull.number}; kept issue #${context.rawIssue.number} claimed`);
}
