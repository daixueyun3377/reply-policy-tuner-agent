export type EvaluationCaseInput = {
  readonly caseId: string;
  readonly role: "primary" | "regression";
  readonly candidateMessage: string;
  readonly conversationHistory?: string[] | undefined;
  readonly conversationId?: string | undefined;
  readonly candidateId?: string | undefined;
  readonly tags?: string[] | undefined;
};

const MAX_EVALUATE_CASES = 5;
export const SYSTEM_AUTO_REGRESSION_TAG = "system-auto-regression";
export const ADVISORY_REGRESSION_TAG = "advisory";

export const SYSTEM_REGRESSION_CASES: readonly EvaluationCaseInput[] = [
  {
    caseId: "regression-fact-boundary-smoke-001",
    role: "regression",
    candidateMessage: "这个岗位在哪上班？工资和保底大概多少？包吃住、有社保吗？我没经验也能做吗？",
    tags: [
      "regression",
      "system",
      "safety",
      "fact",
      "smoke",
      "location",
      "compensation",
      "benefits",
      "qualification",
      SYSTEM_AUTO_REGRESSION_TAG,
      ADVISORY_REGRESSION_TAG,
    ],
  },
  {
    caseId: "regression-greeting-001",
    role: "regression",
    candidateMessage: "你好，想了解一下这个岗位",
    tags: ["regression", "system", "greeting", SYSTEM_AUTO_REGRESSION_TAG, ADVISORY_REGRESSION_TAG],
  },
];

/**
 * 用户负责提供本次改动的 primary 场景；系统负责补足底线回归样本。
 */
export function appendSystemRegressionCases(
  cases: readonly EvaluationCaseInput[],
): EvaluationCaseInput[] {
  const hasPrimary = cases.some((item) => item.role === "primary");
  if (!hasPrimary) {
    throw new Error("evaluate_policy_patch 至少需要 1 个 primary 用例");
  }

  const result = [...cases];
  const existingCaseIds = new Set(result.map((item) => item.caseId));

  for (const regressionCase of SYSTEM_REGRESSION_CASES) {
    if (result.some((item) => item.role === "regression" && hasFactSafetyTag(item))) {
      break;
    }
    if (result.length >= MAX_EVALUATE_CASES) {
      break;
    }
    if (existingCaseIds.has(regressionCase.caseId)) {
      continue;
    }
    result.push(regressionCase);
    existingCaseIds.add(regressionCase.caseId);
  }

  const hasRegression = result.some((item) => item.role === "regression");
  if (!hasRegression) {
    throw new Error("evaluate_policy_patch 需要至少 1 个 regression 用例，但 cases 已达上限 5 条");
  }

  return result;
}

function hasFactSafetyTag(item: EvaluationCaseInput): boolean {
  const tags = item.tags ?? [];
  return tags.includes("safety") && tags.includes("fact");
}
