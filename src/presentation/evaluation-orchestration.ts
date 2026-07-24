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
  /** Hard/Fact 已通过，可调用 update_policy 请求文字保存确认；确认前不会写入 */
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

type EvaluateFactIssue = NonNullable<
  EvaluatePatchResponse["cases"][number]["factVerification"]
>["draft"]["blockingIssues"][number];

export type EvaluationGateDecision = {
  hardBlocked: boolean;
  factBlocked: boolean;
  historicalHardIssues: number;
  historicalFactIssues: number;
  advisoryFactIssues: number;
};

export type EvaluationCaseScopeOptions = {
  readonly generalRegressionCaseIds?: ReadonlySet<string>;
};

function countNewByKey<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => string,
): number {
  const remainingBaseline = new Map<string, number>();
  for (const value of baseline) {
    const key = keyOf(value);
    remainingBaseline.set(key, (remainingBaseline.get(key) ?? 0) + 1);
  }

  let newCount = 0;
  for (const value of current) {
    const key = keyOf(value);
    const remaining = remainingBaseline.get(key) ?? 0;
    if (remaining > 0) {
      remainingBaseline.set(key, remaining - 1);
    } else {
      newCount += 1;
    }
  }
  return newCount;
}

function countNewFactIssues(
  current: readonly EvaluateFactIssue[],
  baseline: readonly EvaluateFactIssue[],
): number {
  // claim/expected 可能由 LLM 改写；同 code 且数量未增加视为同一历史问题。
  return countNewByKey(current, baseline, (issue) => issue.code);
}

/** 硬阻断时拼入 orchestration.guidance，供上层 Agent 读取（子 Agent 勿向运营念原文） */
const PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX =
  "禁止 update_policy。update_policy 的 patch 须与最近一次 evaluate_policy_patch 的 patch 完全一致，不得换用未评估内容。" +
  "勿以删除 factGate.forbiddenWhenMissingFacts、放宽 factGate.mode 等方式规避 Fact 阻塞；" +
  "证据不符（如 contradicted_location）须改 Reply Authority 门店证据或修订 patch 后重新 Validate → Evaluate。";

/**
 * 所有样本都比较 base/draft：
 * - primary / related regression：阻断本次 patch 新增的 Hard/Fact 问题；
 * - general regression：新增 Hard 问题仍阻断，新增 Fact 问题只告警；
 * - 服务端 aggregate 为 false 但仅能定位到历史或通用回归事实问题时，不阻断。
 */
export function deriveEvaluationGateDecision(
  data: EvaluatePatchResponse,
  options: EvaluationCaseScopeOptions = {},
): EvaluationGateDecision {
  let explicitHardBlocked = false;
  let explicitFactBlocked = false;
  let historicalHardIssues = 0;
  let historicalFactIssues = 0;
  let advisoryFactIssues = 0;

  for (const item of data.cases) {
    const baseGateViolations = item.base.gateViolations ?? [];
    const draftGateViolations = item.draft.gateViolations ?? [];
    const baseFactIssues = item.factVerification?.base.blockingIssues ?? [];
    const draftFactIssues = item.factVerification?.draft.blockingIssues ?? [];

    const newGateViolationCount =
      item.comparison?.draftIntroducedGateViolations === true
        ? Math.max(
            1,
            countNewByKey(draftGateViolations, baseGateViolations, (value) => value),
          )
        : item.comparison?.draftIntroducedGateViolations === false
          ? 0
          : countNewByKey(draftGateViolations, baseGateViolations, (value) => value);
    const rawNewFactIssueCount = countNewFactIssues(draftFactIssues, baseFactIssues);
    const isGeneralRegression =
      item.role === "regression" &&
      options.generalRegressionCaseIds?.has(item.caseId) === true;
    const newFactIssueCount = isGeneralRegression ? 0 : rawNewFactIssueCount;

    if (newGateViolationCount > 0) {
      explicitHardBlocked = true;
    }
    if (newFactIssueCount > 0) {
      explicitFactBlocked = true;
    }

    historicalHardIssues += Math.max(
      0,
      draftGateViolations.length - newGateViolationCount,
    );
    historicalFactIssues += Math.max(
      0,
      draftFactIssues.length - rawNewFactIssueCount,
    );
    advisoryFactIssues += isGeneralRegression ? rawNewFactIssueCount : 0;
  }

  const unexplainedHardFailure =
    !data.summary.hardRecommendedForPublish &&
    historicalHardIssues === 0 &&
    !explicitHardBlocked;
  const unexplainedFactFailure =
    !data.summary.factRecommendedForPublish &&
    historicalFactIssues + advisoryFactIssues === 0 &&
    !explicitFactBlocked;

  return {
    hardBlocked: explicitHardBlocked || unexplainedHardFailure,
    factBlocked: explicitFactBlocked || unexplainedFactFailure,
    historicalHardIssues,
    historicalFactIssues,
    advisoryFactIssues,
  };
}

/**
 * 从 evaluate 响应推导 RSI 编排动作（见 references/orchestration.md）：
 * - Hard Gate / Fact Verification 失败 → rollback_to_propose
 * - 仅 L4 Judge 失败（Hard+Fact 已过）→ decide_with_warnings（可请求文字保存确认）
 * - Hard+Fact+Judge 均通过 → ready_to_publish
 */
export function deriveEvaluationOrchestration(
  data: EvaluatePatchResponse,
  options: EvaluationCaseScopeOptions = {},
): EvaluationOrchestration {
  const { summary } = data;
  const gateDecision = deriveEvaluationGateDecision(data, options);
  const mandatoryPublishReady = !gateDecision.hardBlocked && !gateDecision.factBlocked;
  const publishBlocked = !mandatoryPublishReady;

  const judgeAdvisoryOnly =
    mandatoryPublishReady &&
    !publishBlocked &&
    !summary.judgeRecommendedForPublish;

  let action: EvaluationOrchestrationAction;
  let guidance: string;

  if (publishBlocked) {
    action = "rollback_to_propose";
    const reasons: string[] = [];
    if (gateDecision.hardBlocked) {
      reasons.push("Hard Gate 未通过");
    }
    if (gateDecision.factBlocked) {
      reasons.push("Fact Verification 存在阻塞项");
    }
    guidance = `硬性安全校验未通过（${reasons.join("、")}），须回到 Propose 修订最小 patch 后重新 Validate → Evaluate。${PUBLISH_BLOCKED_ORCHESTRATION_SUFFIX}`;
  } else if (judgeAdvisoryOnly) {
    action = "decide_with_warnings";
    const generalFactWarning =
      gateDecision.advisoryFactIssues > 0
        ? `另有 ${String(gateDecision.advisoryFactIssues)} 个通用回归事实告警，仅展示、不阻断。`
        : "";
    guidance =
      `本次修改未新增 Hard Gate 或相关 Fact Verification 阻塞；L4 Judge 给出质量告警。${generalFactWarning}展示 warning 与话术对比后，调用 update_policy 获取唯一一次保存确认，并提示用户回复「确认保存」或「取消」。`;
  } else if (summary.judgeRecommendedForPublish) {
    action = "ready_to_publish";
    const historicalWarningCount =
      gateDecision.historicalHardIssues + gateDecision.historicalFactIssues;
    const advisoryWarningCount = gateDecision.advisoryFactIssues;
    guidance =
      historicalWarningCount + advisoryWarningCount > 0
        ? `本次修改未新增阻塞问题；检测到 ${String(historicalWarningCount)} 个历史已有问题、${String(advisoryWarningCount)} 个通用回归事实告警，均不阻断本次保存。展示评估结论与对比后，调用 update_policy 获取文字保存确认。`
        : "Hard Gate、Fact Verification 与 Judge（若启用）均已通过。展示评估结论与对比后，调用 update_policy 获取文字保存确认，并提示用户回复「确认保存」或「取消」；写入成功前不得宣称已更新。";
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
