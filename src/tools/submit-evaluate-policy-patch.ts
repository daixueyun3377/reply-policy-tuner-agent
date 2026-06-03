import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { deriveEvaluationOrchestration } from "../presentation/evaluation-orchestration.ts";
import { formatEvaluationSummaryMarkdown } from "../presentation/evaluation-summary.ts";
import { evaluatePolicyPatch } from "../services/reply-authority-client.ts";
import { hashPolicyPatch, recordEvaluatePublishGate } from "../evaluate-publish-gate.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { EvaluationOrchestrationSchema } from "../presentation/evaluation-orchestration.ts";
import { BuiltCaseSchema, EvaluateSummarySchema } from "../types/reply-policy.ts";

const SubmitEvaluatePolicyPatchInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本"),
  patch: z.record(z.unknown()).describe("待评估的策略补丁"),
  cases: z
    .array(BuiltCaseSchema)
    .min(1)
    .max(5)
    .describe("已拼装完整的评估用例（从 build_evaluate_cases 获取；推荐 2-3 条 primary + 1 条 regression，总数 ≤5 避免服务端超时）"),
});

const SubmitEvaluatePolicyPatchOutputSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  draftPolicyVersion: z.string(),
  summary: EvaluateSummarySchema,
  /** 服务端综合结论（Hard ∧ Fact ∧ Judge） */
  recommendedForPublish: z.boolean(),
  /** RSI 编排动作：上层 Agent 据此决定回 Propose / Decide+warning / 可发布 */
  orchestration: EvaluationOrchestrationSchema,
  evaluationSummaryMarkdown: z.string(),
  warnings: z.array(z.string()),
});

export const submitEvaluatePolicyPatchTool = defineTool({
  name: "submit_evaluate_policy_patch",
  description:
    "提交 POST /tenants/:tenantId/reply-policy:evaluate 请求。judgeEnabled 固定为 true。输入须为 build_evaluate_cases 的输出。Hard Gate 或 Fact blocking 未通过时 orchestration.action=rollback_to_propose 且 publishBlocked=true；仅 Judge 未通过时为 decide_with_warnings。发布前必须调用且必须成功；超时/失败时禁止跳过直接 update_policy；update_policy 须与本次 evaluate 的 patch 完全一致，且 hardRecommendedForPublish 与 factRecommendedForPublish 均为 true、publishBlocked=false",
  input: SubmitEvaluatePolicyPatchInputSchema,
  output: SubmitEvaluatePolicyPatchOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Submitting evaluate policy patch for tenant: ${input.tenantId}`);

    const result = await evaluatePolicyPatch(input.tenantId, {
      basePolicyVersion: input.basePolicyVersion,
      patch: input.patch,
      cases: input.cases.map((c) => ({
        caseId: c.caseId,
        role: c.role,
        ...(c.tags !== undefined ? { tags: c.tags } : {}),
        input: {
          candidateMessage: c.input.candidateMessage,
          ...(c.input.conversationHistory !== undefined
            ? { conversationHistory: c.input.conversationHistory }
            : {}),
          target: c.input.target,
        },
      })),
      judge: { enabled: true },
    });

    if (!result.ok) {
      throw new Error(translateRasHttpError(result.status, "evaluate", result.errorMessage));
    }

    const data = result.data;
    if (data === undefined) {
      throw new Error("评估补丁成功但响应数据为空");
    }

    const orchestration = deriveEvaluationOrchestration(data);

    await recordEvaluatePublishGate({
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      patchDigest: hashPolicyPatch(input.patch),
      recommendedForPublish: data.summary.recommendedForPublish,
      hardRecommendedForPublish: data.summary.hardRecommendedForPublish,
      factRecommendedForPublish: data.summary.factRecommendedForPublish,
      publishBlocked: orchestration.publishBlocked,
      orchestrationAction: orchestration.action,
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: data.draftPolicyVersion,
    });

    return {
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      draftPolicyVersion: data.draftPolicyVersion,
      summary: data.summary,
      recommendedForPublish: data.summary.recommendedForPublish,
      orchestration,
      evaluationSummaryMarkdown: formatEvaluationSummaryMarkdown(data),
      warnings: data.warnings,
    };
  },
});
