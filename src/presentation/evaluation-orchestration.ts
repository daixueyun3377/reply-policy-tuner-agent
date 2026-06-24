import { z } from "zod";
import type { EvaluatePatchResponse } from "../types/reply-policy.ts";

/** 与 reply-policy RSI 机制页一致的编排动作（由上层 Agent 执行，非 tool 自动跳转） */
export const EVALUATION_ORCHESTRATION_ACTIONS = [
  "rollback_to_propose",
  "decide_with_warnings",
  "ready_to_publish",
] as const;

export type EvaluationOrchestrationAction =
  (typeof EVALUATION_ORCHESTRATION_ACTIONS)[number];

export type EvaluationOrchestration = {
  /** 上层 Agent 下一步应执行的动作 */
  action: EvaluationOrchestrationAction;
  /** Hard Gate 或 Fact Verification 未通过，禁止发布，须回 Propose 重修 patch */
  publishBlocked: boolean;
  /** Hard + Fact 均已通过（与 Judge 无关） */
  mandatoryPublishReady: boolean;
  /** 仅 Judge 未通过或回归质量告警；可展示 warning 并由用户决定是否仍发布 */
  judgeAdvisoryOnly: boolean;
  /** Hard/Fact 已通过、可进入发布确认流程；尚未写入，须用户明确同意后才可 update_policy */
  requiresExplicitPublishConfirmation: boolean;
  /** 给编排层 / 运营的一句话指引 */
  guidance: string;
};

export type EvaluationOrchestrationOptions = {
  readonly advisoryCaseIds?: readonly string[];
};

export const EvaluationOrchestrationSchema = z.object({
  action: z.enum(EVALUATION_ORCHESTRATION_ACTIONS),
  publishBlocked: z.boolean(),
  mandatoryPublishReady: z.boolean(),
  judgeAdvisoryOnly: z.boolean(),
  requiresExplicitPublishConfirmation: z.boolean(),
  guidance: z.string(),
});

function buildAdvisoryCaseIdSet(options: EvaluationOrchestrationOptions | undefined): Set<string> {
  return new Set(options?.advisoryCaseIds ?? []);
}

function isAdvisoryCase(caseId: string, advisoryCaseIds: ReadonlySet<string>): boolean {
  return advisoryCaseIds.has(caseId);
}

function caseHasDraftBlockingFactIssues(item: EvaluatePatchResponse["cases"][number]): boolean {
  const blocking = item.factVerification?.draft.blockingIssues ?? [];
  return blocking.length > 0;
}

function hasDraftBlockingFactIssues(
  data: EvaluatePatchResponse,
  input?: { readonly advisoryCaseIds?: ReadonlySet<string>; readonly includeAdvisory?: boolean },
): boolean {
  const advisoryCaseIds = input?.advisoryCaseIds ?? new Set<string>();
  const includeAdvisory = input?.includeAdvisory ?? true;
  for (const item of data.cases) {
    if (!includeAdvisory && isAdvisoryCase(item.caseId, advisoryCaseIds)) {
      continue;
    }
    if (caseHasDraftBlockingFactIssues(item)) {
      return true;
    }
  }
  return false;
}

/** 硬阻断时拼入 orchestration.guidance，供上层 Agent 读取（子 Agent 勿向运营念原文） */
const PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX =
  "禁止 update_policy。update_policy 的 patch 须与最近一次 evaluate_policy_patch 的 patch 完全一致，不得换用未评估内容。" +
  "勿以删除 factGate.forbiddenWhenMissingFacts、放宽 factGate.mode 等方式规避 Fact 阻塞；" +
  "证据不符（如 contradicted_location）须改 Reply Authority 门店证据或修订 patch 后重新 Validate → Evaluate。";

function caseHasDraftGateViolations(item: EvaluatePatchResponse["cases"][number]): boolean {
  const violations = item.draft.gateViolations ?? [];
  return violations.length > 0 || item.comparison?.draftIntroducedGateViolations === true;
}

function hasDraftGateViolations(
  data: EvaluatePatchResponse,
  input?: { readonly advisoryCaseIds?: ReadonlySet<string>; readonly includeAdvisory?: boolean },
): boolean {
  const advisoryCaseIds = input?.advisoryCaseIds ?? new Set<string>();
  const includeAdvisory = input?.includeAdvisory ?? true;
  for (const item of data.cases) {
    if (!includeAdvisory && isAdvisoryCase(item.caseId, advisoryCaseIds)) {
      continue;
    }
    if (caseHasDraftGateViolations(item)) {
      return true;
    }
  }
  return false;
}

function hasAdvisoryDraftBlockingFactIssues(
  data: EvaluatePatchResponse,
  advisoryCaseIds: ReadonlySet<string>,
): boolean {
  return data.cases.some(
    (item) => isAdvisoryCase(item.caseId, advisoryCaseIds) && caseHasDraftBlockingFactIssues(item),
  );
}

function hasAdvisoryDraftGateViolations(
  data: EvaluatePatchResponse,
  advisoryCaseIds: ReadonlySet<string>,
): boolean {
  return data.cases.some(
    (item) => isAdvisoryCase(item.caseId, advisoryCaseIds) && caseHasDraftGateViolations(item),
  );
}

/**
 * 从 evaluate 响应推导 RSI 编排动作（见 references/orchestration.md）：
 * - Hard Gate / Fact Verification 失败 → rollback_to_propose
 * - 仅 L4 Judge 失败（Hard+Fact 已过）→ decide_with_warnings（用户确认后可写入）
 * - Hard+Fact+Judge 均通过 → ready_to_publish
 */
export function deriveEvaluationOrchestration(
  data: EvaluatePatchResponse,
  options?: EvaluationOrchestrationOptions,
): EvaluationOrchestration {
  const { summary } = data;
  const advisoryCaseIds = buildAdvisoryCaseIdSet(options);
  const hasNonAdvisoryFactBlocking = hasDraftBlockingFactIssues(data, {
    advisoryCaseIds,
    includeAdvisory: false,
  });
  const hasNonAdvisoryGateViolations = hasDraftGateViolations(data, {
    advisoryCaseIds,
    includeAdvisory: false,
  });
  const hasAdvisoryFactBlocking = hasAdvisoryDraftBlockingFactIssues(data, advisoryCaseIds);
  const hasAdvisoryGateViolations = hasAdvisoryDraftGateViolations(data, advisoryCaseIds);
  const factFailureIsAdvisoryOnly =
    !summary.factRecommendedForPublish && hasAdvisoryFactBlocking && !hasNonAdvisoryFactBlocking;
  const hardFailureIsAdvisoryOnly =
    !summary.hardRecommendedForPublish &&
    hasAdvisoryGateViolations &&
    !hasNonAdvisoryGateViolations;
  const effectiveFactRecommendedForPublish =
    summary.factRecommendedForPublish || factFailureIsAdvisoryOnly;
  const effectiveHardRecommendedForPublish =
    summary.hardRecommendedForPublish || hardFailureIsAdvisoryOnly;
  const mandatoryPublishReady =
    effectiveHardRecommendedForPublish &&
    effectiveFactRecommendedForPublish &&
    !hasNonAdvisoryFactBlocking;

  const publishBlocked =
    !mandatoryPublishReady ||
    hasNonAdvisoryGateViolations ||
    !effectiveHardRecommendedForPublish ||
    !effectiveFactRecommendedForPublish;

  const judgeAdvisoryOnly =
    mandatoryPublishReady &&
    !publishBlocked &&
    !summary.judgeRecommendedForPublish;

  const advisoryRegressionWarningOnly =
    mandatoryPublishReady &&
    !publishBlocked &&
    (factFailureIsAdvisoryOnly || hardFailureIsAdvisoryOnly);

  let action: EvaluationOrchestrationAction;
  let guidance: string;

  if (publishBlocked) {
    action = "rollback_to_propose";
    const reasons: string[] = [];
    if (!effectiveHardRecommendedForPublish || hasNonAdvisoryGateViolations) {
      reasons.push("Hard Gate 未通过");
    }
    if (!effectiveFactRecommendedForPublish || hasNonAdvisoryFactBlocking) {
      reasons.push("Fact Verification 存在阻塞项");
    }
    guidance = `硬性安全校验未通过（${reasons.join("、")}），须回到 Propose 修订最小 patch 后重新 Validate → Evaluate。${PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX}`;
  } else if (advisoryRegressionWarningOnly) {
    action = "decide_with_warnings";
    guidance =
      "系统自动回归样本发现弱相关风险，已降级为风险提示，不直接阻断保存。请向运营展示 warning、话术对比和修订方案；运营可选择修订后重新评估，或明确确认接受风险后继续保存。";
  } else if (judgeAdvisoryOnly) {
    action = "decide_with_warnings";
    guidance =
      "Hard Gate 与 Fact Verification 已通过；L4 Judge 给出质量告警（或回归样本变差）。向运营展示 warning 与话术对比，由用户选择「修订 patch」或「仍要发布」。仅在用户明确确认保存后调用 update_policy（首次会 needs_confirmation，须带 toolActionApproval 重试）。禁止将用户描述修改意图当作确认写入。";
  } else if (summary.judgeRecommendedForPublish) {
    action = "ready_to_publish";
    guidance =
      "Hard Gate、Fact Verification 与 Judge（若启用）均已通过。须先向运营展示评估结论与对比，待运营明确确认保存后再调用 update_policy（首次会 needs_confirmation，须带 toolActionApproval 重试）。禁止在确认前宣称已更新或提前写入。";
  } else {
    // Judge 未启用但 RAS 仍返回 false 的兜底：按硬阻断处理
    action = "rollback_to_propose";
    guidance =
      `评估未达发布建议且存在非 Judge 类问题，须回到 Propose 修订 patch 后重新 Validate → Evaluate。${PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX}`;
  }

  const requiresExplicitPublishConfirmation = mandatoryPublishReady && !publishBlocked;

  return {
    action,
    publishBlocked,
    mandatoryPublishReady,
    judgeAdvisoryOnly,
    requiresExplicitPublishConfirmation,
    guidance,
  };
}
