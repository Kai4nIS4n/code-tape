import { loadPrGuardContext } from './action-context.mjs';
import { evaluatePrGuard } from './guard-pr.mjs';
import { GitHubClient, readEvent } from './github-client.mjs';

const event = await readEvent();
if (event.workflow_run && event.workflow_run.conclusion !== 'success') {
  console.log(`workflow_run conclusion is ${event.workflow_run.conclusion}; skipping auto merge`);
  process.exit(0);
}

const client = new GitHubClient();
let context;
try {
  context = await loadPrGuardContext(client, event);
} catch (error) {
  if (/does not reference a pull request/.test(error.message)) {
    console.log('event does not reference a pull request; skipping auto merge');
    process.exit(0);
  }
  throw error;
}
const result = evaluatePrGuard({
  ...context,
  now: new Date().toISOString(),
});

if (!result.ok) {
  console.log(`PR #${context.pr.number} is not ready to merge:\n- ${result.reasons.join('\n- ')}`);
  process.exit(0);
}

if (context.rawPull.draft) {
  console.log(`PR #${context.pr.number} is draft; skipping auto merge`);
  process.exit(0);
}

if (context.rawPull.mergeable_state && context.rawPull.mergeable_state !== 'clean') {
  console.log(`PR #${context.pr.number} mergeable_state is ${context.rawPull.mergeable_state}; waiting for branch protection and checks`);
  process.exit(0);
}

await client.mergePull(context.pr.number, {
  commitTitle: `#${result.issueNumber} ${context.rawPull.title}`,
  commitMessage: `Closes #${result.issueNumber}\n\nMerged automatically after workflow guard and CR passed.`,
});

if (context.pr.headRepoFullName === context.pr.baseRepoFullName && context.pr.headRef !== 'main') {
  await client.deleteBranch(context.pr.headRef);
}

console.log(`merged PR #${context.pr.number} for issue #${result.issueNumber}`);
