import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  buildPolicyComparisonRowsFromDiff,
  buildPolicyComparisonRowsFromPatch,
  formatPolicyComparisonTable,
  formatReplyComparisonTable,
} from "../presentation/comparison.ts";
import { summarizePolicyForOperator } from "../presentation/policy-summary.ts";
import { PolicyDiffEntrySchema } from "../types/reply-policy.ts";

const FormatPolicyPreviewInputSchema = z.object({
  patch: z.record(z.unknown()).describe("待确认的 patch"),
  sampleMessage: z.string().min(1).describe("话术对比使用的示例候选人消息"),
  currentReply: z.string().min(1).describe("修改前回复（来自 preview_policy_effect）"),
  previewReply: z.string().min(1).describe("修改后回复（来自 preview_policy_effect）"),
  stage: z.string().optional().describe("招聘阶段（可选）"),
  policySummary: z
    .record(z.unknown())
    .optional()
    .describe("当前完整策略（可选，用于生成策略概览）"),
  diff: z
    .array(PolicyDiffEntrySchema)
    .optional()
    .describe("策略 diff（来自 validate_patch 或 preview_policy_effect；优先于 patch 推断）"),
  comparisonRows: z
    .array(
      z.object({
        label: z.string(),
        before: z.string(),
        after: z.string(),
      }),
    )
    .optional()
    .describe("策略对比行（可选；未提供时根据 diff 或 patch 自动生成）"),
  evaluationSummaryMarkdown: z
    .string()
    .optional()
    .describe("评估摘要 Markdown（来自 evaluate_policy_patch，可选）"),
});

const FormatPolicyPreviewOutputSchema = z.object({
  policyComparisonMarkdown: z.string(),
  replyComparisonMarkdown: z.string(),
  combinedMarkdown: z.string(),
  policySummary: z.string().optional(),
});

export const PREVIEW_CONFIRMATION_PROMPT =
  "请回复「确认评估」继续，或直接告诉我需要调整的内容。";

export const formatPolicyPreviewTool = defineTool({
  name: "format_policy_preview",
  description:
    "将 validate/preview/evaluate 结果格式化为运营可读的「策略对比 + 话术对比 + 评估摘要」Markdown。首次预览结果末尾固定提示用户回复「确认评估」或直接说明调整内容，不依赖按钮。用户文字确认评估后才执行安全评估；这一步不是落库确认。评估通过并展示后调用 update_policy 获取唯一一次文字保存确认",
  input: FormatPolicyPreviewInputSchema,
  output: FormatPolicyPreviewOutputSchema,
  execute: async (input) => {
    const rows =
      input.comparisonRows !== undefined && input.comparisonRows.length > 0
        ? input.comparisonRows
        : input.diff !== undefined && input.diff.length > 0
          ? buildPolicyComparisonRowsFromDiff(input.diff)
          : buildPolicyComparisonRowsFromPatch(input.patch);

    const policyComparisonMarkdown = formatPolicyComparisonTable(rows);
    const replyComparisonMarkdown = formatReplyComparisonTable({
      sampleMessage: input.sampleMessage,
      currentReply: input.currentReply,
      previewReply: input.previewReply,
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
    });

    const policySummary =
      input.policySummary !== undefined
        ? summarizePolicyForOperator(input.policySummary)
        : undefined;

    const sections = [
      "### 策略对比",
      policyComparisonMarkdown,
      "",
      "### 话术对比",
      replyComparisonMarkdown,
    ];

    if (input.evaluationSummaryMarkdown !== undefined && input.evaluationSummaryMarkdown.length > 0) {
      sections.push("", input.evaluationSummaryMarkdown);
    }

    if (policySummary !== undefined) {
      sections.unshift("### 当前策略概览", policySummary, "");
    }

    if (
      input.evaluationSummaryMarkdown === undefined ||
      input.evaluationSummaryMarkdown.length === 0
    ) {
      sections.push("", PREVIEW_CONFIRMATION_PROMPT);
    }

    return {
      policyComparisonMarkdown,
      replyComparisonMarkdown,
      combinedMarkdown: sections.join("\n"),
      ...(policySummary !== undefined ? { policySummary } : {}),
    };
  },
});
