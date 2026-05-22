export function labelNames(labels = []) {
  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter(Boolean);
}

export function hasStatus(labels, status) {
  return labelNames(labels).includes(`status:${status}`);
}

export function parseScore(labels) {
  const scoreLabels = labelNames(labels).filter((label) => label.startsWith('score:'));
  if (scoreLabels.length !== 1) {
    throw new Error(`expected exactly one score label, got ${scoreLabels.length}`);
  }

  const rawScore = scoreLabels[0].slice('score:'.length);
  const score = Number(rawScore);
  if (!Number.isFinite(score) || score <= 0) {
    throw new Error(`invalid score label: ${scoreLabels[0]}`);
  }

  return score;
}

export function parseStack(labels) {
  return labelNames(labels)
    .filter((label) => label.startsWith('stack:'))
    .map((label) => label.slice('stack:'.length))
    .filter(Boolean);
}

export function parseBugReferences(body = '') {
  const sourceIssue = findNumberAfterLabel(body, /关联原\s*Issue/i);
  const sourcePr = findNumberAfterLabel(body, /关联原\s*PR/i);

  if (!sourceIssue || !sourcePr) {
    throw new Error('bug issue body must include source issue and source PR');
  }

  return { sourceIssue, sourcePr };
}

function findNumberAfterLabel(body, labelPattern) {
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!labelPattern.test(line)) {
      continue;
    }
    const match = line.match(/#(\d+)/);
    if (match) {
      return Number(match[1]);
    }
    for (const nextLine of lines.slice(index + 1)) {
      if (!nextLine.trim()) {
        continue;
      }
      const nextMatch = nextLine.match(/#(\d+)/);
      return nextMatch ? Number(nextMatch[1]) : null;
    }
  }
  return null;
}
