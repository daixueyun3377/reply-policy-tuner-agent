/** 聚焦评估上限：1 条本次目标 primary + 2 条 regression */
export const DEFAULT_EVALUATE_FIRST_ATTEMPT_LIMIT = 3;

/** 超时降级：保留本次目标 primary + 1 条 regression */
export const DEGRADED_EVALUATE_CASE_LIMIT = 2;

export type EvaluateCaseRole = "primary" | "regression";

export type EvaluateCasePickable = {
  readonly caseId: string;
  readonly role: EvaluateCaseRole;
  readonly regressionScope?: "related" | "general" | undefined;
};

type PickLimits = {
  readonly maxTotal: number;
  readonly maxPrimary: number;
  readonly maxRegression: number;
};

/**
 * 按 primary 在前、regression 在后的顺序选取用例（保留输入顺序内的前 N 条）。
 */
export function pickEvaluateCases<T extends EvaluateCasePickable>(
  cases: readonly T[],
  limits: PickLimits,
): T[] {
  const primary = cases.filter((c) => c.role === "primary").slice(0, limits.maxPrimary);
  const regression = cases
    .filter((c) => c.role === "regression")
    .sort((left, right) => {
      const priority = (value: T): number => value.regressionScope === "general" ? 1 : 0;
      return priority(left) - priority(right);
    })
    .slice(0, limits.maxRegression);
  return [...primary, ...regression].slice(0, limits.maxTotal);
}

/** C1：无论输入总数多少，都只保留 1 条 primary + 1～2 条 regression。 */
export function capCasesForFirstAttempt<T extends EvaluateCasePickable>(
  cases: readonly T[],
  maxTotal: number = DEFAULT_EVALUATE_FIRST_ATTEMPT_LIMIT,
): { readonly cases: T[]; readonly capped: boolean } {
  const picked = pickEvaluateCases(cases, {
    maxTotal,
    maxPrimary: 1,
    maxRegression: 2,
  });

  return {
    cases: picked,
    capped: picked.length < cases.length,
  };
}

/**
 * C2：超时后保留目标 primary + 1 条 regression；无法继续精简时不重试。
 */
export function degradeCasesForRetry<T extends EvaluateCasePickable>(
  cases: readonly T[],
): T[] | undefined {
  if (cases.length <= DEGRADED_EVALUATE_CASE_LIMIT) {
    return undefined;
  }

  return pickEvaluateCases(cases, {
    maxTotal: DEGRADED_EVALUATE_CASE_LIMIT,
    maxPrimary: 1,
    maxRegression: 1,
  });
}

export function formatCapCasesWarning(inputCount: number, attemptCount: number): string {
  return `⚠️ 传入 ${inputCount} 条用例，聚焦评估已裁至 ${attemptCount} 条（1 条本次目标 primary + 1～2 条 regression）。`;
}

export function formatDegradeCasesWarning(
  firstAttemptCount: number,
  retryCount: number,
): string {
  return `⚠️ 首次评估超时，已缩减为 ${retryCount} 条用例重试（原 ${firstAttemptCount} 条）：1 条本次目标 primary + 1 条 regression。`;
}
