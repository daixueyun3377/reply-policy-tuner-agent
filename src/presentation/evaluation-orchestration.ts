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

export const EvaluationOrchestrationSchema = z.object({
  action: z.enum(EVALUATION_ORCHESTRATION_ACTIONS),
  publishBlocked: z.boolean(),
  mandatoryPublishReady: z.boolean(),
  judgeAdvisoryOnly: z.boolean(),
  requiresExplicitPublishConfirmation: z.boolean(),
  guidance: z.string(),
});

function hasDraftBlockingFactIssues(data: EvaluatePatchResponse): boolean {
  for (const item of data.cases) {
    const blocking = item.factVerification?.draft.blockingIssues ?? [];
    if (blocking.length > 0) {
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

function hasDraftGateViolations(data: EvaluatePatchResponse): boolean {
  for (const item of data.cases) {
    const violations = item.draft.gateViolations ?? [];
    if (violations.length > 0) {
      return true;
    }
    if (item.comparison?.draftIntroducedGateViolations === true) {
      return true;
    }
  }
  return false;
}

/**
 * 从 evaluate 响应推导 RSI 编排动作（见 references/orchestration.md）：
 * - Hard Gate / Fact Verification 失败 → rollback_to_propose
 * - 仅 L4 Judge 失败（Hard+Fact 已过）→ decide_with_warnings（用户确认后可写入）
 * - Hard+Fact+Judge 均通过 → ready_to_publish
 */
export function deriveEvaluationOrchestration(
  data: EvaluatePatchResponse,
): EvaluationOrchestration {
  const { summary } = data;
  const mandatoryPublishReady =
    summary.hardRecommendedForPublish &&
    summary.factRecommendedForPublish &&
    !hasDraftBlockingFactIssues(data);

  const publishBlocked =
    !mandatoryPublishReady ||
    hasDraftGateViolations(data) ||
    !summary.hardRecommendedForPublish ||
    !summary.factRecommendedForPublish;

  const judgeAdvisoryOnly =
    mandatoryPublishReady &&
    !publishBlocked &&
    !summary.judgeRecommendedForPublish;

  let action: EvaluationOrchestrationAction;
  let guidance: string;

  if (publishBlocked) {
    action = "rollback_to_propose";
    const reasons: string[] = [];
    if (!summary.hardRecommendedForPublish || hasDraftGateViolations(data)) {
      reasons.push("Hard Gate 未通过");
    }
    if (!summary.factRecommendedForPublish || hasDraftBlockingFactIssues(data)) {
      reasons.push("Fact Verification 存在阻塞项");
    }
    guidance = `硬性安全校验未通过（${reasons.join("、")}），须回到 Propose 修订最小 patch 后重新 Validate → Evaluate。${PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX}`;
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
