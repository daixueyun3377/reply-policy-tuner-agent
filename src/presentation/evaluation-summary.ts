import type { EvaluatePatchResponse } from "../types/reply-policy.ts";
import {
  deriveEvaluationOrchestration,
  type EvaluationOrchestrationOptions,
  type EvaluationOrchestration,
} from "./evaluation-orchestration.ts";

function sanitizeUserFacingDiagnostic(value: string): string {
  return value.replace(/\b[a-z][a-z0-9]*_[a-z0-9_]*\b/g, "内部告警项");
}

function formatFactIssues(
  issues: ReadonlyArray<{ code: string; claim?: string | undefined; expected?: string | undefined }>,
): string {
  if (issues.length === 0) {
    return "无";
  }

  return issues
    .map((issue) => {
      const parts = [sanitizeUserFacingDiagnostic(issue.code)];
      if (issue.claim !== undefined && issue.claim.length > 0) {
        parts.push(`「${sanitizeUserFacingDiagnostic(issue.claim)}」`);
      }
      if (issue.expected !== undefined && issue.expected.length > 0) {
        parts.push(`期望：${sanitizeUserFacingDiagnostic(issue.expected)}`);
      }
      return parts.join(" ");
    })
    .join("；");
}

function roleLabel(role: "primary" | "regression"): string {
  return role === "primary" ? "主样本" : "回归样本";
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

function isAdvisoryCase(caseId: string, options: EvaluationOrchestrationOptions | undefined): boolean {
  return (options?.advisoryCaseIds ?? []).includes(caseId);
}

function collectRevisionSuggestions(
  data: EvaluatePatchResponse,
  options: EvaluationOrchestrationOptions | undefined,
): string[] {
  const suggestions: string[] = [];
  let hasAdvisoryFactBlocking = false;
  let hasAdvisoryGateViolation = false;

  for (const item of data.cases) {
    if (!isAdvisoryCase(item.caseId, options)) {
      continue;
    }

    if ((item.factVerification?.draft.blockingIssues ?? []).length > 0) {
      hasAdvisoryFactBlocking = true;
    }
    if (
      (item.draft.gateViolations ?? []).length > 0 ||
      item.comparison?.draftIntroducedGateViolations === true
    ) {
      hasAdvisoryGateViolation = true;
    }
  }

  if (hasAdvisoryFactBlocking) {
    suggestions.push(
      "事实风险：将 patch 收窄为只影响本次目标场景；补充“缺少证据时先追问/确认，不直接承诺地点、薪资、社保、食宿、经验要求等事实”的约束。",
    );
  }

  if (hasAdvisoryGateViolation) {
    suggestions.push(
      "硬规则风险：恢复或补强 hardConstraints（硬约束）与 factGate（事实门禁），不要通过放宽事实门禁来让评估通过。",
    );
  }

  if ((hasAdvisoryFactBlocking || hasAdvisoryGateViolation) && !data.summary.judgeRecommendedForPublish) {
    suggestions.push(
      "质量告警：保留本次目标改动，但降低影响范围，只修改和用户目标相关的字段、阶段或话术规则。",
    );
  }

  if (!hasAdvisoryFactBlocking && !hasAdvisoryGateViolation && !data.summary.judgeRecommendedForPublish) {
    suggestions.push(
      "评审告警：保留用户明确要求的改动，减少对无关场景的影响；必要时把 patch 收窄到本次目标阶段或目标话术。",
    );
  }

  if (suggestions.length === 0 && data.summary.regressionWarnings > 0) {
    suggestions.push(
      "回归告警：对比告警样本的修改前后回复，优先收窄本次 patch 的生效范围；如果确认风险可接受，再继续保存。",
    );
  }

  return suggestions;
}

/**
 * 将 evaluate 结果格式化为运营可读的 Markdown 摘要（含 RSI 编排指引）。
 */
export function formatEvaluationSummaryMarkdown(
  data: EvaluatePatchResponse,
  options?: EvaluationOrchestrationOptions,
): string {
  const { summary } = data;
  const orchestration = deriveEvaluationOrchestration(data, options);
  const revisionSuggestions = collectRevisionSuggestions(data, options);

  const rasAggregate = summary.recommendedForPublish
    ? "服务端综合 recommendedForPublish = true"
    : "服务端综合 recommendedForPublish = false";

  const lines = [
    "### 策略评估结果",
    "",
    `**编排动作**：${orchestrationActionLabel(orchestration.action)}`,
    "",
    orchestration.guidance,
    "",
    `**${rasAggregate}**（Hard ∧ Fact ∧ Judge；Judge 未启用时 Judge 视为通过）`,
    "",
    "| 检查层 | 结果 | 编排含义 |",
    "| --- | --- | --- |",
    `| L1 Hard Gate | ${gateResultLabel(summary.hardRecommendedForPublish, orchestration.publishBlocked)} | 未通过须回 Propose，不得发布 |`,
    `| L3 Fact Verification | ${gateResultLabel(summary.factRecommendedForPublish, orchestration.publishBlocked)} | blockingIssues 须回 Propose；nonBlockingIssues 仅 warning |`,
    `| L4 Frozen Rubric Judge | ${gateResultLabel(summary.judgeRecommendedForPublish, false)} | 未通过时展示 warning，由用户决定是否仍发布 |`,
    `| 硬性可发布（Hard+Fact） | ${orchestration.mandatoryPublishReady ? "✅ 是" : "❌ 否"} | 与 Judge 无关的发布前置条件 |`,
    `| 主样本数 | ${String(summary.primaryCases)} | |`,
    `| 回归样本数 | ${String(summary.regressionCases)} | |`,
    "",
    "### 各样本详情",
    "",
  ];

  if (
    orchestration.action === "decide_with_warnings" &&
    revisionSuggestions.length > 0 &&
    !orchestration.publishBlocked
  ) {
    lines.push("### 风险提示");
    lines.push("");
    lines.push("评估发现建议性风险，但硬性可发布条件已通过，因此不直接阻断保存。");
    lines.push("");
    lines.push("可选处理：");
    lines.push("1. 继续保存：接受该风险，后续观察。");
    lines.push("2. 修订后再评估：参考下面的修改方案，收窄 patch 后重新评估。");
    lines.push("");
    lines.push("对应修改方案：");
    for (const suggestion of revisionSuggestions) {
      lines.push(`- ${suggestion}`);
    }
    lines.push("");
  }

  for (const item of data.cases) {
    const advisoryLabel = isAdvisoryCase(item.caseId, options) ? " · 系统风险提示" : "";
    const draftBlocking = item.factVerification?.draft.blockingIssues ?? [];
    const draftNonBlocking = item.factVerification?.draft.nonBlockingIssues ?? [];
    const gateViolations = item.draft.gateViolations ?? [];

    lines.push(`#### ${roleLabel(item.role)} · ${item.caseId}${advisoryLabel}`);
    lines.push("");
    lines.push("| | 修改前 | 修改后 |");
    lines.push("| --- | --- | --- |");
    lines.push(`| 回复 | ${escapeCell(item.base.suggestedReply)} | ${escapeCell(item.draft.suggestedReply)} |`);
    lines.push("");
    lines.push(
      `- Hard Gate 违规：${
        gateViolations.length > 0
          ? gateViolations.map((item) => sanitizeUserFacingDiagnostic(item)).join("；")
          : "无"
      }`,
    );
    lines.push(`- 事实阻塞（blocking）：${formatFactIssues(draftBlocking)}`);
    lines.push(`- 事实警告（nonBlocking）：${formatFactIssues(draftNonBlocking)}`);

    if (item.judge?.rationale !== undefined && item.judge.rationale.length > 0) {
      lines.push(`- L4 Judge：${sanitizeUserFacingDiagnostic(item.judge.rationale)}`);
    }
    if (item.judge?.winner !== undefined && item.judge.winner.length > 0) {
      lines.push(`- Judge Winner：${sanitizeUserFacingDiagnostic(item.judge.winner)}`);
    }

    lines.push("");
  }

  if (data.warnings.length > 0) {
    lines.push("### 服务端 warnings");
    lines.push("");
    for (const warning of data.warnings) {
      lines.push(`- ${sanitizeUserFacingDiagnostic(warning)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
