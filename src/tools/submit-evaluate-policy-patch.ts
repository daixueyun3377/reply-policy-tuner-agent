import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { deriveEvaluationOrchestration } from "../presentation/evaluation-orchestration.ts";
import { formatEvaluationSummaryMarkdown } from "../presentation/evaluation-summary.ts";
import { evaluatePolicyPatch, isReplyAuthorityTimeout } from "../services/reply-authority-client.ts";
import { hashPolicyPatch, recordEvaluatePublishGate } from "../evaluate-publish-gate.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { EvaluationOrchestrationSchema } from "../presentation/evaluation-orchestration.ts";
import { BuiltCaseSchema, EvaluateSummarySchema } from "../types/reply-policy.ts";

/** 超时降级重试时保留的 case 数量上限（优先保留 primary） */
const DEGRADED_RETRY_CASE_LIMIT = 2;

const SubmitEvaluatePolicyPatchInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本"),
  patch: z.record(z.unknown()).describe("待评估的策略补丁"),
  cases: z
    .array(BuiltCaseSchema)
    .min(1)
    .max(5)
    .describe("已拼装完整的评估用例（从 build_evaluate_cases 获取；推荐 2-3 条，超时会自动降级重试一次）"),
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

type BuiltCase = z.infer<typeof BuiltCaseSchema>;

/**
 * 超时降级：优先保留 primary，再补 regression，最多 DEGRADED_RETRY_CASE_LIMIT 条。
 * 若原本就已 ≤ 上限则返回 undefined（无可降级空间）。
 */
function degradeCases(cases: BuiltCase[]): BuiltCase[] | undefined {
  if (cases.length <= DEGRADED_RETRY_CASE_LIMIT) {
    return undefined;
  }
  const primary = cases.filter((c) => c.role === "primary");
  const regression = cases.filter((c) => c.role === "regression");
  const reduced = [...primary, ...regression].slice(0, DEGRADED_RETRY_CASE_LIMIT);
  return reduced;
}

export const submitEvaluatePolicyPatchTool = defineTool({
  name: "submit_evaluate_policy_patch",
  description:
    "提交 POST /tenants/:tenantId/reply-policy:evaluate 请求。judgeEnabled 固定为 true。输入须为 build_evaluate_cases 的输出。Hard Gate 或 Fact blocking 未通过时 orchestration.action=rollback_to_propose 且 publishBlocked=true；仅 Judge 未通过时为 decide_with_warnings。超时时自动减少 case 数量重试一次，仍超时则报错。发布前必须调用且必须成功；超时/失败时禁止跳过直接 update_policy；update_policy 须与本次 evaluate 的 patch 完全一致，且 hardRecommendedForPublish 与 factRecommendedForPublish 均为 true、publishBlocked=false",
  input: SubmitEvaluatePolicyPatchInputSchema,
  output: SubmitEvaluatePolicyPatchOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Submitting evaluate policy patch for tenant: ${input.tenantId}`);

    const callEvaluate = (cases: BuiltCase[]) =>
      evaluatePolicyPatch(input.tenantId, {
        basePolicyVersion: input.basePolicyVersion,
        patch: input.patch,
        cases: cases.map((c) => ({
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

    let result;
    let usedCases = input.cases;
    try {
      result = await callEvaluate(input.cases);
    } catch (error) {
      if (!isReplyAuthorityTimeout(error)) {
        throw error;
      }

      // 超时降级：减少 case 数量重试一次
      const degraded = degradeCases(input.cases);
      if (degraded === undefined) {
        throw new Error(
          `评估超时：本次 ${input.cases.length} 条用例已是最小规模，仍未在限定时间内完成。请稍后重试，或检查 Reply Authority Service 是否繁忙。`,
        );
      }

      ctx.logger.info(
        `Evaluate timed out with ${input.cases.length} cases; retrying with degraded ${degraded.length} cases`,
      );

      try {
        result = await callEvaluate(degraded);
        usedCases = degraded;
      } catch (retryError) {
        if (isReplyAuthorityTimeout(retryError)) {
          throw new Error(
            `评估两次超时：先后用 ${input.cases.length} 条、${degraded.length} 条用例都未在限定时间内完成。请稍后重试，或减少要评估的场景。`,
          );
        }
        throw retryError;
      }
    }

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

    const degradedNotice =
      usedCases.length < input.cases.length
        ? [
            `⚠️ 首次评估超时，已自动减少到 ${usedCases.length} 条最关键用例重新评估（原 ${input.cases.length} 条）。结论基于精简后的样本。`,
          ]
        : [];

    return {
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      draftPolicyVersion: data.draftPolicyVersion,
      summary: data.summary,
      recommendedForPublish: data.summary.recommendedForPublish,
      orchestration,
      evaluationSummaryMarkdown: formatEvaluationSummaryMarkdown(data),
      warnings: [...degradedNotice, ...data.warnings],
    };
  },
});
