export const CONTRACT_DIFF_FILTER = 'ACDMRTUXB';

const impactSummaryFields = ['风险等级', '关键骨架变更', '影响分析', '验证结果'];
const impactSummaryPlaceholders = new Set(['-', '无', 'none', 'n/a', 'na', 'todo', '待补充']);
const riskLevels = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const criticalContractRules = [
  {
    category: 'recording-schema',
    testPattern: /^apps\/web\/src\/shared\/recording-schema\/__tests__\//,
    matches: (file) => file.startsWith('apps/web/src/shared/recording-schema/'),
  },
  {
    category: 'runtime-preview',
    testPattern: /^apps\/web\/src\/features\/runtime-preview\/__tests__\//,
    matches: (file) => file.startsWith('apps/web/src/features/runtime-preview/'),
  },
  {
    category: 'recording-repository',
    testPattern: /^apps\/web\/src\/features\/library\/__tests__\//,
    matches: (file) => file.startsWith('apps/web/src/features/library/recordingStore'),
  },
  {
    category: 'replay-core',
    testPattern: /^apps\/web\/src\/features\/player\/__tests__\//,
    matches: (file) =>
      file.startsWith('apps/web/src/features/player/replay') ||
      file.startsWith('apps/web/src/features/player/packageLoader') ||
      file.startsWith('apps/web/src/features/player/timelineClock') ||
      file.startsWith('apps/web/src/features/player/mediaClockAdapter'),
  },
  {
    category: 'workflow-contract',
    testPattern: /^scripts\/tests\//,
    matches: (file) =>
      file.startsWith('.github/workflows/') ||
      file.startsWith('scripts/workflows/') ||
      file === '.github/PULL_REQUEST_TEMPLATE.md' ||
      file === '.github/CODEOWNERS',
  },
  {
    category: 'authority-docs',
    testPattern: /^docs\/contracts\/|^scripts\/tests\//,
    matches: (file) =>
      [
        'README.md',
        'AGENTS.md',
        'CLAUDE.md',
        'docs/PRD/代码讲解工具.md',
        'docs/技术方案.md',
        'docs/技术模块拆解.md',
        'docs/项目时间规划.md',
        'docs/规范工作流程.md',
        'docs/知识库契约.md',
      ].includes(file) ||
      file.startsWith('docs/contracts/') ||
      file.startsWith('docs/竞品分析/'),
  },
];

export function classifyContractPaths(files) {
  const critical = [];
  const nonCritical = [];
  for (const file of normalizeFiles(files)) {
    const rule = criticalContractRules.find((candidate) => candidate.matches(file));
    if (rule) {
      critical.push({ file, category: rule.category });
    } else {
      nonCritical.push(file);
    }
  }
  return { critical, nonCritical };
}

export function combineChangedFiles(changedFiles, untrackedFiles) {
  return normalizeFiles([...(changedFiles ?? []), ...(untrackedFiles ?? [])]);
}

export function evaluateGitNexusContract({ changedFiles, impactSummary = '' }) {
  const normalized = normalizeFiles(changedFiles);
  const classification = classifyContractPaths(normalized);
  const reasons = [];
  const warnings = [];
  const suggestions = [
    'Inspect affected callers and tests before editing critical skeleton code.',
    'Optionally run npm run contract:local and use GitNexus detect_changes/query/context/impact for complex changes.',
    'Summarize the impact analysis and validation result in the PR self-check.',
  ];

  if (classification.critical.length === 0) {
    warnings.push('No critical contract surface changed; GitNexus analysis is advisory for this diff.');
    return { ok: true, reasons, warnings, suggestions, ...classification };
  }

  const touchedCategories = new Set(classification.critical.map((item) => item.category));
  for (const category of touchedCategories) {
    const rule = criticalContractRules.find((candidate) => candidate.category === category);
    if (!rule) continue;
    const hasMatchingTest = normalized.some((file) => rule.testPattern.test(file));
    if (!hasMatchingTest) {
      reasons.push(`Missing contract test for critical category: ${category}`);
    }
  }

  reasons.push(...validateStructuredImpactSummary(impactSummary));

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    suggestions,
    ...classification,
  };
}

export function extractImpactSummary(text) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /^#{1,6}\s*(?:GitNexus\s*)?影响分析摘要\s*$/iu.test(line.trim()),
  );
  if (headingIndex === -1) return text.trim();

  const section = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^#{1,6}\s+\S/u.test(line.trim())) break;
    section.push(line);
  }
  return section.join('\n').trim();
}

function validateStructuredImpactSummary(value) {
  const normalized = value.trim();
  if (isPlaceholder(normalized)) {
    return ['Missing structured impact summary. Fill the PR template fields for critical skeleton changes.'];
  }

  const fields = parseImpactSummaryFields(normalized);
  const reasons = [];
  for (const field of impactSummaryFields) {
    const fieldValue = fields.get(field);
    if (fieldValue === undefined) {
      reasons.push(`Missing impact summary field: ${field}`);
    } else if (isPlaceholder(fieldValue)) {
      reasons.push(`Impact summary field is empty or placeholder: ${field}`);
    }
  }

  const riskLevel = fields.get('风险等级')?.toUpperCase();
  if (riskLevel && !riskLevels.has(riskLevel)) {
    reasons.push('Invalid risk level. Use LOW, MEDIUM, HIGH, or CRITICAL.');
  }

  return reasons;
}

function parseImpactSummaryFields(value) {
  const fields = new Map();
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(?:\*\*)?([^:*：]+?)(?:\*\*)?\s*[:：]\s*(.*)\s*$/u.exec(line);
    if (match) {
      const key = match[1].trim();
      fields.set(key === 'GitNexus 影响面' ? '影响分析' : key, match[2].trim());
    }
  }
  return fields;
}

function isPlaceholder(value) {
  return !value.trim() || impactSummaryPlaceholders.has(value.trim().toLowerCase());
}

function normalizeFiles(files) {
  return [...new Set((files ?? []).map((file) => file.replaceAll('\\', '/')).filter(Boolean))];
}
