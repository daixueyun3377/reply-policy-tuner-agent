import type { EvaluatePatchResponse } from "../types/reply-policy.ts";
import {
  deriveEvaluationGateDecision,
  deriveEvaluationOrchestration,
  type EvaluationCaseScopeOptions,
  type EvaluationOrchestration,
} from "./evaluation-orchestration.ts";

function formatFactIssues(
  issues: ReadonlyArray<{ code: string; claim?: string | undefined; expected?: string | undefined }>,
): string {
  if (issues.length === 0) {
    return "无";
  }

  return issues
    .map((issue) => {
      const parts = [issue.code];
      if (issue.claim !== undefined && issue.claim.length > 0) {
        parts.push(`「${issue.claim}」`);
      }
      if (issue.expected !== undefined && issue.expected.length > 0) {
        parts.push(`期望：${issue.expected}`);
      }
      return parts.join(" ");
    })
    .join("；");
}

function roleLabel(
  role: "primary" | "regression",
  isGeneralRegression: boolean,
): string {
  if (role === "primary") {
    return "本次目标样本";
  }
  return isGeneralRegression
    ? "通用回归样本（事实仅告警）"
    : "关联回归样本";
}

function orchestrationActionLabel(action: EvaluationOrchestration["action"]): string {
  const labels: Record<EvaluationOrchestration["action"], string> = {
    rollback_to_propose: "回 Propose 重修 patch（硬阻断）",
    decide_with_warnings: "进入 Decide，Judge 告警由用户决策",
    ready_to_publish: "可进入 Decide → Publish",
  };
  return labels[action];
}

function gateResultLabel(passed: boolean, blocked: boolean): string {
  if (passed) {
    return "✅ 通过";
  }
  return blocked ? "❌ 未通过（硬阻断）" : "⚠️ 未通过（建议性）";
}

function partitionByBaseline<T>(
  current: readonly T[],
  baseline: readonly T[],
  keyOf: (value: T) => string,
): { introduced: T[]; historical: T[] } {
  const remainingBaseline = new Map<string, number>();
  for (const value of baseline) {
    const key = keyOf(value);
    remainingBaseline.set(key, (remainingBaseline.get(key) ?? 0) + 1);
  }

  const introduced: T[] = [];
  const historical: T[] = [];
  for (const value of current) {
    const key = keyOf(value);
    const remaining = remainingBaseline.get(key) ?? 0;
    if (remaining > 0) {
      remainingBaseline.set(key, remaining - 1);
      historical.push(value);
    } else {
      introduced.push(value);
    }
  }
  return { introduced, historical };
}

/**
 * 将 evaluate 结果格式化为运营可读的 Markdown 摘要（含 RSI 编排指引）。
 */
export function formatEvaluationSummaryMarkdown(
  data: EvaluatePatchResponse,
  options: EvaluationCaseScopeOptions = {},
): string {
  const { summary } = data;
  const orchestration = deriveEvaluationOrchestration(data, options);
  const gateDecision = deriveEvaluationGateDecision(data, options);
  const generalRegressionCases = data.cases.filter(
    (item) =>
      item.role === "regression" &&
      options.generalRegressionCaseIds?.has(item.caseId) === true,
  ).length;
  const relatedRegressionCases = Math.max(
    0,
    summary.regressionCases - generalRegressionCases,
  );

  const rasAggregate = summary.recommendedForPublish
    ? "服务端原始综合 recommendedForPublish = true"
    : "服务端原始综合 recommendedForPublish = false";
  const effectiveResult = orchestration.publishBlocked
    ? "❌ 本次修改存在新增阻塞问题，暂不可保存"
    : "✅ 本次修改未新增阻塞问题，可进入保存确认";

  const lines = [
    "### 策略评估结果",
    "",
    `**编排动作**：${orchestrationActionLabel(orchestration.action)}`,
    "",
    `**最终结论**：${effectiveResult}`,
    "",
    orchestration.guidance,
    "",
    `**${rasAggregate}**（Hard ∧ Fact ∧ Judge；Judge 未启用时 Judge 视为通过）`,
    "",
    "| 检查层 | 结果 | 编排含义 |",
    "| --- | --- | --- |",
    `| L1 Hard Gate | ${gateResultLabel(!gateDecision.hardBlocked, gateDecision.hardBlocked)} | 只有本次 patch 新增问题才阻断 |`,
    `| L3 Fact Verification | ${gateResultLabel(!gateDecision.factBlocked, gateDecision.factBlocked)} | primary/related 新增问题阻断；general 新增问题只告警 |`,
    `| L4 Frozen Rubric Judge | ${gateResultLabel(summary.judgeRecommendedForPublish, false)} | 未通过时展示 warning，由用户决定是否仍发布 |`,
    `| 硬性可发布（Hard+Fact） | ${orchestration.mandatoryPublishReady ? "✅ 是" : "❌ 否"} | 与 Judge 无关的发布前置条件 |`,
    `| 本次目标样本数 | ${String(summary.primaryCases)} | |`,
    `| 关联回归样本数 | ${String(relatedRegressionCases)} | |`,
    `| 通用回归样本数 | ${String(generalRegressionCases)} | 事实问题只告警 |`,
    "",
    "### 各样本详情",
    "",
  ];

  for (const item of data.cases) {
    const isGeneralRegression =
      item.role === "regression" &&
      options.generalRegressionCaseIds?.has(item.caseId) === true;
    const draftBlocking = item.factVerification?.draft.blockingIssues ?? [];
    const draftNonBlocking = item.factVerification?.draft.nonBlockingIssues ?? [];
    const gateViolations = item.draft.gateViolations ?? [];
    const baseBlocking = item.factVerification?.base.blockingIssues ?? [];
    const baseGateViolations = item.base.gateViolations ?? [];

    lines.push(`#### ${roleLabel(item.role, isGeneralRegression)} · ${item.caseId}`);
    lines.push("");
    lines.push("| | 修改前 | 修改后 |");
    lines.push("| --- | --- | --- |");
    lines.push(`| 回复 | ${escapeCell(item.base.suggestedReply)} | ${escapeCell(item.draft.suggestedReply)} |`);
    lines.push("");
    const gateDelta = partitionByBaseline(
      gateViolations,
      baseGateViolations,
      (violation) => violation,
    );
    const factDelta = partitionByBaseline(
      draftBlocking,
      baseBlocking,
      (issue) => issue.code,
    );
    const introducedGateViolations =
      item.comparison?.draftIntroducedGateViolations === false
        ? []
        : item.comparison?.draftIntroducedGateViolations === true &&
            gateDelta.introduced.length === 0
          ? ["服务端判定本次新增违规"]
          : gateDelta.introduced;
    const historicalGateViolations =
      item.comparison?.draftIntroducedGateViolations === false
        ? gateViolations
        : item.comparison?.draftIntroducedGateViolations === true &&
            gateDelta.introduced.length === 0
          ? []
          : gateDelta.historical;

    lines.push(
      `- 本次新增 Hard Gate 违规：${introducedGateViolations.length > 0 ? introducedGateViolations.join("；") : "无"}`,
    );
    lines.push(
      `- 历史已有 Hard Gate 违规：${historicalGateViolations.length > 0 ? historicalGateViolations.join("；") : "无"}`,
    );
    lines.push(
      isGeneralRegression
        ? `- 通用回归新增事实告警（不阻塞）：${formatFactIssues(factDelta.introduced)}`
        : `- 本次新增事实阻塞：${formatFactIssues(factDelta.introduced)}`,
    );
    lines.push(`- 历史已有事实阻塞：${formatFactIssues(factDelta.historical)}`);
    lines.push(`- 事实警告（nonBlocking）：${formatFactIssues(draftNonBlocking)}`);

    if (item.judge?.rationale !== undefined && item.judge.rationale.length > 0) {
      lines.push(`- L4 Judge：${item.judge.rationale}`);
    }
    if (item.judge?.winner !== undefined && item.judge.winner.length > 0) {
      lines.push(`- Judge Winner：${item.judge.winner}`);
    }

    lines.push("");
  }

  if (data.warnings.length > 0) {
    lines.push("### 服务端 warnings");
    lines.push("");
    for (const warning of data.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
