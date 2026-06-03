import type { EvaluatePatchResponse } from "../types/reply-policy.ts";
import {
  deriveEvaluationOrchestration,
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

/**
 * 将 evaluate 结果格式化为运营可读的 Markdown 摘要（含 RSI 编排指引）。
 */
export function formatEvaluationSummaryMarkdown(data: EvaluatePatchResponse): string {
  const { summary } = data;
  const orchestration = deriveEvaluationOrchestration(data);

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

  for (const item of data.cases) {
    const draftBlocking = item.factVerification?.draft.blockingIssues ?? [];
    const draftNonBlocking = item.factVerification?.draft.nonBlockingIssues ?? [];
    const gateViolations = item.draft.gateViolations ?? [];

    lines.push(`#### ${roleLabel(item.role)} · ${item.caseId}`);
    lines.push("");
    lines.push("| | 修改前 | 修改后 |");
    lines.push("| --- | --- | --- |");
    lines.push(`| 回复 | ${escapeCell(item.base.suggestedReply)} | ${escapeCell(item.draft.suggestedReply)} |`);
    lines.push("");
    lines.push(`- Hard Gate 违规：${gateViolations.length > 0 ? gateViolations.join("；") : "无"}`);
    lines.push(`- 事实阻塞（blocking）：${formatFactIssues(draftBlocking)}`);
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

