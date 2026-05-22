const closingKeywordPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

export function parseClosingIssues(body = '') {
  const issues = [];
  for (const match of body.matchAll(closingKeywordPattern)) {
    issues.push(Number(match[1]));
  }
  return [...new Set(issues)];
}

export function requireSingleClosingIssue(body = '') {
  const issues = parseClosingIssues(body);
  if (issues.length !== 1) {
    throw new Error(`expected exactly one closing issue, got ${issues.length}`);
  }
  return issues[0];
}

export function findValidReviewer({ reviews = [], comments = [], prAuthor, latestCommitAt }) {
  const latestCommitTime = Date.parse(latestCommitAt || '1970-01-01T00:00:00.000Z');
  const candidates = [];

  for (const review of reviews) {
    const login = review?.user?.login;
    const type = review?.user?.type;
    const submittedAt = review?.submitted_at || review?.submittedAt;
    if (
      review?.state === 'APPROVED' &&
      login &&
      login !== prAuthor &&
      type !== 'Bot' &&
      Date.parse(submittedAt) >= latestCommitTime
    ) {
      candidates.push({ login, at: submittedAt });
    }
  }

  for (const comment of comments) {
    const login = comment?.user?.login;
    const type = comment?.user?.type;
    const createdAt = comment?.created_at || comment?.createdAt;
    if (
      comment?.body?.trim() === 'CR通过' &&
      login &&
      login !== prAuthor &&
      type !== 'Bot' &&
      Date.parse(createdAt) >= latestCommitTime
    ) {
      candidates.push({ login, at: createdAt });
    }
  }

  candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return candidates[0]?.login ?? null;
}

export function isTimedOut(createdAt, now, hours = 24) {
  return Date.parse(now) - Date.parse(createdAt) > hours * 60 * 60 * 1000;
}
