/** 默认首次评估规模：2 条 primary + 1 条 regression */
export const DEFAULT_EVALUATE_FIRST_ATTEMPT_LIMIT = 3;

/** 超时降级重试规模：1 条 primary + 1 条 regression */
export const DEGRADED_EVALUATE_CASE_LIMIT = 2;

export type EvaluateCaseRole = "primary" | "regression";

export type EvaluateCasePickable = {
  readonly caseId: string;
  readonly role: EvaluateCaseRole;
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
  const regression = cases.filter((c) => c.role === "regression").slice(0, limits.maxRegression);
  return [...primary, ...regression].slice(0, limits.maxTotal);
}

/** C1：首次请求前封顶，避免先跑满量再超时（默认 2p+1r） */
export function capCasesForFirstAttempt<T extends EvaluateCasePickable>(
  cases: readonly T[],
  maxTotal: number = DEFAULT_EVALUATE_FIRST_ATTEMPT_LIMIT,
): { readonly cases: T[]; readonly capped: boolean } {
  if (cases.length <= maxTotal) {
    return { cases: [...cases], capped: false };
  }

  return {
    cases: pickEvaluateCases(cases, {
      maxTotal,
      maxPrimary: 2,
      maxRegression: 1,
    }),
    capped: true,
  };
}

/**
 * C2：超时降级为 1p+1r；若已是该规模或更小则返回 undefined（无可降级空间）。
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
  return `⚠️ 传入 ${inputCount} 条用例，首次评估已自动裁至 ${attemptCount} 条（2 条 primary + 1 条 regression）。结论基于裁切后的样本。`;
}

export function formatDegradeCasesWarning(
  firstAttemptCount: number,
  retryCount: number,
): string {
  return `⚠️ 首次评估超时，已自动减至 ${retryCount} 条用例重试（1 条 primary + 1 条 regression，原 ${firstAttemptCount} 条）。结论基于精简后的样本。`;
}
