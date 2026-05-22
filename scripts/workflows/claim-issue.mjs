import { progressJsonPath } from './config.mjs';
import { GitHubClient, readEvent } from './github-client.mjs';
import { claimIssue, readProgress, writeProgress } from './progress-store.mjs';
import { writeRenderedProgress } from './write-rendered-progress.mjs';

const event = await readEvent();
const commentBody = event.comment?.body?.trim();

if (commentBody !== '认领' || event.issue?.pull_request) {
  console.log('not an issue claim comment; skipping');
  process.exit(0);
}

const client = new GitHubClient();
const issueNumber = event.issue.number;
const actor = event.comment.user.login;

try {
  const issue = await client.getIssue(issueNumber);
  const activeIssues = await client.listOpenClaimedIssuesByAssignee(actor);
  const otherActive = activeIssues.find((activeIssue) => activeIssue.number !== issueNumber);
  if (otherActive) {
    throw new Error(`${actor} already has active issue #${otherActive.number}`);
  }

  const progress = await readProgress(progressJsonPath);
  const next = claimIssue(
    progress,
    {
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      assignee: issue.assignee?.login,
    },
    actor,
    event.comment.created_at,
  );

  await client.removeLabel(issueNumber, 'status:open');
  await client.addLabels(issueNumber, ['status:claimed']);
  await client.setAssignees(issueNumber, [actor]);
  await writeProgress(next, progressJsonPath);
  await writeRenderedProgress(next);
  await client.comment(
    issueNumber,
    [
      `@${actor} 认领成功，任务已锁定。`,
      '',
      '- 请从自己的 fork 基于 `main` 创建分支开发。',
      `- PR 正文必须包含 \`Closes #${issueNumber}\`。`,
      '- PR 需要至少一名非作者同学 CR。',
      '- PR 24 小时内未合并会被关闭，但任务仍归你负责。',
    ].join('\n'),
  );
  console.log(`claimed issue #${issueNumber} by ${actor}`);
} catch (error) {
  await client.comment(issueNumber, `@${actor} 认领失败：${error.message}`);
  throw error;
}
