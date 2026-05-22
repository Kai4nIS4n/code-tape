import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasStatus,
  parseBugReferences,
  parseScore,
  parseStack,
} from '../workflows/issue-parser.mjs';
import {
  findValidReviewer,
  parseClosingIssues,
} from '../workflows/pr-parser.mjs';
import { pullNumberFromEvent } from '../workflows/action-context.mjs';
import {
  applyBugFixMerge,
  applyFeatureMerge,
  claimIssue,
  createEmptyProgress,
} from '../workflows/progress-store.mjs';
import { renderProgressMarkdown } from '../workflows/render-progress.mjs';
import { evaluatePrGuard } from '../workflows/guard-pr.mjs';

test('parseScore requires exactly one score label', () => {
  assert.equal(parseScore(['score:5', 'stack:react', 'status:open']), 5);
  assert.throws(() => parseScore(['stack:react']), /exactly one score/);
  assert.throws(() => parseScore(['score:3', 'score:5']), /exactly one score/);
  assert.throws(() => parseScore(['score:abc']), /invalid score/);
});

test('parseStack extracts stack labels without non-stack labels', () => {
  assert.deepEqual(parseStack(['score:5', 'stack:react', 'stack:typescript', 'status:open']), [
    'react',
    'typescript',
  ]);
});

test('claimIssue records active issue and rejects second active task', () => {
  const progress = createEmptyProgress();
  const issue = {
    number: 12,
    title: '实现录制控制栏',
    labels: ['score:5', 'stack:react', 'status:open'],
  };

  const claimed = claimIssue(progress, issue, 'alice', '2026-05-22T10:00:00.000Z');

  assert.equal(claimed.students.alice.activeIssue, 12);
  assert.equal(claimed.issues['12'].status, 'claimed');
  assert.equal(claimed.issues['12'].assignee, 'alice');
  assert.throws(
    () => claimIssue(claimed, { ...issue, number: 13 }, 'alice', '2026-05-22T10:01:00.000Z'),
    /already has active issue #12/,
  );
});

test('claimIssue validates GitHub issue status and supports repair reruns', () => {
  const progress = createEmptyProgress();

  assert.throws(
    () =>
      claimIssue(
        progress,
        { number: 12, title: '总控', labels: [] },
        'alice',
        '2026-05-22T10:00:00.000Z',
      ),
    /not open for claim/,
  );

  assert.throws(
    () =>
      claimIssue(
        progress,
        {
          number: 12,
          title: '实现录制控制栏',
          labels: ['score:5', 'stack:react', 'status:claimed'],
          assignee: 'bob',
        },
        'alice',
        '2026-05-22T10:00:00.000Z',
      ),
    /already claimed/,
  );

  const repaired = claimIssue(
    progress,
    {
      number: 12,
      title: '实现录制控制栏',
      labels: ['score:5', 'stack:react', 'status:claimed'],
      assignee: 'alice',
    },
    'alice',
    '2026-05-22T10:00:00.000Z',
  );

  assert.equal(repaired.students.alice.activeIssue, 12);
  assert.equal(repaired.issues['12'].assignee, 'alice');
  assert.deepEqual(
    claimIssue(
      repaired,
      {
        number: 12,
        title: '实现录制控制栏',
        labels: ['score:5', 'stack:react', 'status:claimed'],
        assignee: 'alice',
      },
      'alice',
      '2026-05-22T10:00:00.000Z',
    ),
    repaired,
  );
});

test('parseClosingIssues accepts one closing keyword and rejects ambiguous PRs in guard', () => {
  assert.deepEqual(parseClosingIssues('Implements feature.\n\nCloses #12'), [12]);
  assert.deepEqual(parseClosingIssues('Fixes #12\nResolves #13'), [12, 13]);
});

test('findValidReviewer accepts approve or CR comment after latest commit', () => {
  const latestCommitAt = '2026-05-22T10:00:00.000Z';
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', submitted_at: '2026-05-22T11:00:00.000Z' },
  ];
  const comments = [
    { user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:30:00.000Z' },
  ];

  assert.equal(findValidReviewer({ reviews, comments, prAuthor: 'carol', latestCommitAt }), 'bob');
  assert.equal(
    findValidReviewer({
      reviews: [{ user: { login: 'carol', type: 'User' }, state: 'APPROVED', submitted_at: '2026-05-22T11:00:00.000Z' }],
      comments: [],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    null,
  );
  assert.equal(
    findValidReviewer({
      reviews: [],
      comments: [{ user: { login: 'dave', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T09:59:00.000Z' }],
      prAuthor: 'carol',
      latestCommitAt,
    }),
    null,
  );
});

test('evaluatePrGuard enforces issue linkage, ownership, protected files, CR and timeout', () => {
  const progress = createEmptyProgress();
  const claimed = claimIssue(
    progress,
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );

  const result = evaluatePrGuard({
    progress: claimed,
    pr: {
      number: 34,
      title: '实现录制控制栏',
      body: 'Closes #12',
      author: 'alice',
      createdAt: '2026-05-22T10:00:00.000Z',
      latestCommitAt: '2026-05-22T10:10:00.000Z',
    },
    issue: { number: 12, labels: ['score:5', 'stack:react', 'status:claimed'], assignee: 'alice' },
    changedFiles: ['src/App.tsx'],
    reviews: [],
    comments: [{ user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:20:00.000Z' }],
    now: '2026-05-22T11:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 12);
  assert.equal(result.reviewer, 'bob');

  const protectedFile = evaluatePrGuard({
    progress: claimed,
    pr: {
      number: 35,
      title: 'bad',
      body: 'Closes #12',
      author: 'alice',
      createdAt: '2026-05-22T10:00:00.000Z',
      latestCommitAt: '2026-05-22T10:10:00.000Z',
    },
    issue: { number: 12, labels: ['score:5', 'status:claimed'], assignee: 'alice' },
    changedFiles: ['docs/progress.json'],
    reviews: [],
    comments: [{ user: { login: 'bob', type: 'User' }, body: 'CR通过', created_at: '2026-05-22T10:20:00.000Z' }],
    now: '2026-05-22T11:00:00.000Z',
  });

  assert.equal(protectedFile.ok, false);
  assert.match(protectedFile.reasons.join('\n'), /protected progress files/);
});

test('feature scoring writes idempotent ledger and clears active issue', () => {
  const progress = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );

  const scored = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });
  const rerun = applyFeatureMerge(scored, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });

  assert.equal(rerun.ledger.length, 1);
  assert.equal(rerun.students.alice.activeIssue, null);
  assert.equal(rerun.students.alice.developmentScore, 3.75);
  assert.equal(rerun.students.bob.reviewScore, 1.25);
  assert.equal(rerun.students.alice.totalScore, 3.75);
});

test('bug fix scoring penalizes original owner and rewards fix owner', () => {
  const progress = claimIssue(
    createEmptyProgress(),
    { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
    'alice',
    '2026-05-22T09:00:00.000Z',
  );
  const merged = applyFeatureMerge(progress, {
    issue: 12,
    pr: 34,
    score: 5,
    developer: 'alice',
    reviewer: 'bob',
    createdAt: '2026-05-22T12:00:00.000Z',
  });
  const claimedBug = claimIssue(
    merged,
    { number: 41, title: '修复录制控制栏 bug', labels: ['score:5', 'stack:react', 'status:open'] },
    'carol',
    '2026-05-22T13:00:00.000Z',
  );

  const scored = applyBugFixMerge(claimedBug, {
    sourceIssue: 12,
    sourcePr: 34,
    bugIssue: 41,
    fixPr: 45,
    score: 5,
    fixDeveloper: 'carol',
    fixReviewer: 'dave',
    createdAt: '2026-05-22T18:00:00.000Z',
  });

  assert.equal(scored.students.alice.penaltyScore, -7.5);
  assert.equal(scored.students.bob.penaltyScore, -2.5);
  assert.equal(scored.students.carol.developmentScore, 3.75);
  assert.equal(scored.students.dave.reviewScore, 1.25);
  assert.equal(scored.students.carol.activeIssue, null);
});

test('parseBugReferences extracts source issue and PR from bug body', () => {
  assert.deepEqual(
    parseBugReferences('关联原 Issue: #12\n关联原 PR: #34\n复现步骤: ...'),
    { sourceIssue: 12, sourcePr: 34 },
  );
  assert.deepEqual(
    parseBugReferences('### 关联原 Issue\n\n#12\n\n### 关联原 PR\n\n#34\n\n### bug 现象\n\n播放器跳转失败'),
    { sourceIssue: 12, sourcePr: 34 },
  );
});

test('renderProgressMarkdown includes active tasks, score summary and ledger', () => {
  const progress = applyFeatureMerge(
    claimIssue(
      createEmptyProgress(),
      { number: 12, title: '实现录制控制栏', labels: ['score:5', 'stack:react', 'status:open'] },
      'alice',
      '2026-05-22T09:00:00.000Z',
    ),
    {
      issue: 12,
      pr: 34,
      score: 5,
      developer: 'alice',
      reviewer: 'bob',
      createdAt: '2026-05-22T12:00:00.000Z',
    },
  );

  const markdown = renderProgressMarkdown(progress);
  assert.match(markdown, /自动生成/);
  assert.match(markdown, /alice/);
  assert.match(markdown, /3\.75/);
  assert.match(markdown, /#12/);
});

test('hasStatus checks labels from both strings and GitHub label objects', () => {
  assert.equal(hasStatus(['status:open'], 'open'), true);
  assert.equal(hasStatus([{ name: 'status:claimed' }], 'claimed'), true);
});

test('pullNumberFromEvent supports workflow_run retry events', () => {
  assert.equal(
    pullNumberFromEvent({
      workflow_run: {
        pull_requests: [{ number: 34 }],
      },
    }),
    34,
  );
});
