function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function isEmptyRulesArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function countRulesInPatch(patch: Record<string, unknown>): number | undefined {
  const hardConstraints = asRecord(patch["hardConstraints"]);
  if (hardConstraints === undefined) {
    return undefined;
  }

  const rules = hardConstraints["rules"];
  if (!Array.isArray(rules)) {
    return undefined;
  }

  return rules.length;
}

/**
 * 检测 patch 是否属于高危变更（update_policy 摘要中会标注「高危」）。
 */
export function isDangerousPolicyPatch(patch: Record<string, unknown>): boolean {
  const hardConstraints = asRecord(patch["hardConstraints"]);
  if (hardConstraints !== undefined && isEmptyRulesArray(hardConstraints["rules"])) {
    return true;
  }

  const factGate = asRecord(patch["factGate"]);
  if (factGate?.["mode"] === "open") {
    return true;
  }

  const ruleCount = countRulesInPatch(patch);
  if (ruleCount !== undefined && ruleCount <= 1) {
    return true;
  }

  for (const stageKey of [
    "trust_building",
    "private_channel",
    "qualify_candidate",
    "job_consultation",
    "interview_scheduling",
    "onboard_followup",
  ]) {
    const stageGoals = asRecord(patch["stageGoals"]);
    const stage = asRecord(stageGoals?.[stageKey]);
    if (stage !== undefined && isEmptyRulesArray(stage["disallowedActions"])) {
      return true;
    }
  }

  return false;
}

export function describeDangerousPatchReason(patch: Record<string, unknown>): string {
  const hardConstraints = asRecord(patch["hardConstraints"]);
  if (hardConstraints !== undefined && isEmptyRulesArray(hardConstraints["rules"])) {
    return "将清空全部保护规则";
  }

  const factGate = asRecord(patch["factGate"]);
  if (factGate?.["mode"] === "open") {
    return "将事实核查模式调整为开放模式，可能降低回复准确性";
  }

  const ruleCount = countRulesInPatch(patch);
  if (ruleCount !== undefined && ruleCount <= 1) {
    return "保护规则数量过少，可能削弱安全约束";
  }

  return "包含可能影响回复质量的高危策略变更";
}
