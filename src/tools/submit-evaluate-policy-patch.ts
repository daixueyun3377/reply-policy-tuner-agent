import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  capCasesForFirstAttempt,
  degradeCasesForRetry,
  formatCapCasesWarning,
  formatDegradeCasesWarning,
} from "../evaluate-case-selection.ts";
import { deriveEvaluationOrchestration } from "../presentation/evaluation-orchestration.ts";
import { formatEvaluationSummaryMarkdown } from "../presentation/evaluation-summary.ts";
import { evaluatePolicyPatch, isReplyAuthorityTimeout } from "../services/reply-authority-client.ts";
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
    .describe(
      "已拼装完整的评估用例（从 build_evaluate_cases 获取；默认 2 条 primary + 1 条 regression；超过 3 条时首次请求前自动裁切；超时再降为 1p+1r 重试一次）",
    ),
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

type EvaluateAttemptLabel = "first" | "retry";

function evaluateTimerLabel(attempt: EvaluateAttemptLabel): string {
  return `submit_evaluate_policy_patch:evaluate:${attempt}`;
}

export const submitEvaluatePolicyPatchTool = defineTool({
  name: "submit_evaluate_policy_patch",
  description:
    "提交 POST /tenants/:tenantId/reply-policy:evaluate 请求。judgeEnabled 固定为 true。输入须为 build_evaluate_cases 的输出。默认首次评估 2 条 primary + 1 条 regression；传入超过 3 条时首次请求前自动裁切。Hard Gate 或 Fact blocking 未通过时 orchestration.action=rollback_to_propose 且 publishBlocked=true；仅 Judge 未通过时为 decide_with_warnings。超时时自动降为 1 条 primary + 1 条 regression 重试一次，仍超时则报错。发布前必须调用且必须成功；超时/失败时禁止跳过直接 update_policy；update_policy 须与本次 evaluate 的 patch 完全一致，且 hardRecommendedForPublish 与 factRecommendedForPublish 均为 true、publishBlocked=false",
  input: SubmitEvaluatePolicyPatchInputSchema,
  output: SubmitEvaluatePolicyPatchOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Submitting evaluate policy patch for tenant: ${input.tenantId}`);

    const { cases: firstAttemptCases, capped: cappedBeforeFirstAttempt } = capCasesForFirstAttempt(
      input.cases,
    );

    const callEvaluate = async (cases: BuiltCase[], attempt: EvaluateAttemptLabel) => {
      console.time(evaluateTimerLabel(attempt));
      try {
        return await evaluatePolicyPatch(input.tenantId, {
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
      } finally {
        console.timeEnd(evaluateTimerLabel(attempt));
      }
    };

    let result;
    let usedCases = firstAttemptCases;
    const preAttemptWarnings: string[] = cappedBeforeFirstAttempt
      ? [formatCapCasesWarning(input.cases.length, firstAttemptCases.length)]
      : [];

    try {
      result = await callEvaluate(firstAttemptCases, "first");
    } catch (error) {
      if (!isReplyAuthorityTimeout(error)) {
        throw error;
      }

      const degraded = degradeCasesForRetry(firstAttemptCases);
      if (degraded === undefined) {
        throw new Error(
          `评估超时：本次 ${firstAttemptCases.length} 条用例已是最小规模（1 条 primary + 1 条 regression），仍未在限定时间内完成。请稍后重试，或检查 Reply Authority Service 是否繁忙。`,
        );
      }

      ctx.logger.info(
        `Evaluate timed out with ${firstAttemptCases.length} cases; retrying with degraded ${degraded.length} cases (1p+1r)`,
      );

      try {
        result = await callEvaluate(degraded, "retry");
        usedCases = degraded;
      } catch (retryError) {
        if (isReplyAuthorityTimeout(retryError)) {
          throw new Error(
            `评估两次超时：先后用 ${firstAttemptCases.length} 条、${degraded.length} 条用例都未在限定时间内完成。请稍后重试，或减少要评估的场景。`,
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
      usedCases.length < firstAttemptCases.length
        ? [formatDegradeCasesWarning(firstAttemptCases.length, usedCases.length)]
        : [];

    return {
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      draftPolicyVersion: data.draftPolicyVersion,
      summary: data.summary,
      recommendedForPublish: data.summary.recommendedForPublish,
      orchestration,
      evaluationSummaryMarkdown: formatEvaluationSummaryMarkdown(data),
      warnings: [...preAttemptWarnings, ...degradedNotice, ...data.warnings],
    };
  },
});
