export function summarizeSonarIssues(result) {
  if (
    !result ||
    !Number.isSafeInteger(result.total) ||
    result.total < 0 ||
    !Array.isArray(result.issues) ||
    result.issues.length !== result.total
  ) {
    throw new Error("SonarQube issue response is incomplete or invalid");
  }

  const counts = (items) =>
    Object.fromEntries(
      [...items.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
  const increment = (map, key) =>
    map.set(key || "unknown", (map.get(key || "unknown") ?? 0) + 1);
  const severities = new Map();
  const types = new Map();
  const rules = new Map();
  const files = new Map();
  const issues = result.issues.map((issue) => {
    const component = String(issue.component ?? "");
    const file = component.includes(":")
      ? component.slice(component.indexOf(":") + 1)
      : component;
    increment(severities, issue.severity);
    increment(types, issue.type);
    increment(rules, issue.rule);
    increment(files, file);
    return {
      rule: issue.rule ?? "unknown",
      severity: issue.severity ?? "unknown",
      type: issue.type ?? "unknown",
      file,
      ...(Number.isSafeInteger(issue.line) ? { line: issue.line } : {}),
    };
  });
  const ranked = (map) =>
    [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort(
        (left, right) =>
          right.count - left.count || left.key.localeCompare(right.key),
      );

  return {
    total: result.total,
    returned: issues.length,
    severityCounts: counts(severities),
    typeCounts: counts(types),
    topRules: ranked(rules).slice(0, 50),
    topFiles: ranked(files).slice(0, 50),
    issues,
  };
}
