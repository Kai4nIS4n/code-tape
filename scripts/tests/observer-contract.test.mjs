import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('collaborative observation contract separates transport metadata from recorded documents', () => {
  const plan = readFileSync('docs/技术方案.md', 'utf8').split('## 十八、')[1];
  const prd = readFileSync('docs/PRD.md', 'utf8');
  const protocol = readFileSync('apps/web/src/features/interview/interviewObserver.ts', 'utf8');
  const candidate = readFileSync('apps/web/src/features/interview/CandidateInterviewPage.tsx', 'utf8');
  assert.match(plan, /observer-event.*observer-snapshot/u);
  assert.match(plan, /不直接过滤序号/u);
  assert.match(plan, /旧只读模式保持 recording-event\/state-snapshot/u);
  assert.match(prd, /完整历史仍写入候选人录制包/u);
  const stateDeclaration = protocol.match(/export type InterviewObserverState = \{[\s\S]*?\n\};/u)?.[0];
  assert.ok(stateDeclaration);
  assert.doesNotMatch(stateDeclaration, /\b(?:code|editor|documents|initialDocuments)\s*:/u);
  assert.match(candidate, /observerModeRef = useRef\(featureFlags\.collaboration\)/u);
  assert.match(candidate, /mode: "observer"/u);
});
