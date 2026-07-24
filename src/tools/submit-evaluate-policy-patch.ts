import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  capCasesForFirstAttempt,
  degradeCasesForRetry,
  formatCapCasesWarning,
  formatDegradeCasesWarning,
} from "../evaluate-case-selection.ts";
import {
  deriveEvaluationGateDecision,
  deriveEvaluationOrchestration,
} from "../presentation/evaluation-orchestration.ts";
import { formatEvaluationSummaryMarkdown } from "../presentation/evaluation-summary.ts";
import { evaluatePolicyPatch, isReplyAuthorityTimeout } from "../services/reply-authority-client.ts";
import { hashPolicyPatch, recordEvaluatePublishGate } from "../evaluate-publish-gate.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { EvaluationOrchestrationSchema } from "../presentation/evaluation-orchestration.ts";
import { BuiltCaseSchema, EvaluateSummarySchema } from "../types/reply-policy.ts";

export const SubmitEvaluatePolicyPatchInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本"),
  patch: z.record(z.unknown()).describe("待评估的策略补丁"),
  cases: z
    .array(BuiltCaseSchema)
    .min(2)
    .max(5)
    .refine((cases) => cases.some((item) => item.role === "primary"), {
      message: "聚焦评估至少需要 1 条本次目标 primary",
    })
    .refine((cases) => cases.some((item) => item.role === "regression"), {
      message: "聚焦评估至少需要 1 条 regression，禁止零回归评估",
    })
    .refine(
      (cases) =>
        cases
          .filter((item) => item.role === "regression")
          .every((item) => item.regressionScope !== undefined),
      {
        message: "每条 regression 都必须声明 regressionScope=related 或 general",
      },
    )
    .refine(
      (cases) =>
        cases.some(
          (item) =>
            item.role === "regression" &&
            item.regressionScope === "related",
        ),
      {
        message: "聚焦评估至少需要 1 条 regressionScope=related 的回归样本",
      },
    )
    .refine(
      (cases) =>
        cases.every(
          (item) => item.role !== "primary" || item.regressionScope === undefined,
        ),
      {
        message: "primary 不得设置 regressionScope",
      },
    )
    .describe(
      "从 build_evaluate_cases 获取的聚焦评估用例：1 条本次目标 primary + 1～2 条 regression，至少 1 条 related；默认 1 条 related + 1 条 general。多余用例会被裁掉，零回归会被拒绝",
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
    "提交聚焦安全评估。首次评估必须包含 1 条本次目标 primary 和 1～2 条 regression，至少 1 条 related；默认 1 条 related + 1 条 general。primary/related 中 patch 新增的 Hard/Fact 问题可阻塞；general 中新增 Hard 问题阻塞，新增 Fact 问题只告警。修改前已存在的问题只告警。超时时优先保留 related 回归重试一次。发布以 orchestration.publishBlocked=false 为准",
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
          `评估超时：本次 ${firstAttemptCases.length} 条用例已无法继续精简，仍未在限定时间内完成。请稍后重试，或检查 Reply Authority Service 是否繁忙。`,
        );
      }

      ctx.logger.info(
        `Evaluate timed out with ${firstAttemptCases.length} cases; retrying with degraded ${degraded.length} cases`,
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

    const generalRegressionCaseIds = new Set(
      usedCases
        .filter(
          (item) =>
            item.role === "regression" &&
            item.regressionScope === "general",
        )
        .map((item) => item.caseId),
    );
    const scopeOptions = { generalRegressionCaseIds };
    const orchestration = deriveEvaluationOrchestration(data, scopeOptions);
    const gateDecision = deriveEvaluationGateDecision(data, scopeOptions);

    await recordEvaluatePublishGate({
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      patchDigest: hashPolicyPatch(input.patch),
      recommendedForPublish: data.summary.recommendedForPublish,
      hardRecommendedForPublish: !gateDecision.hardBlocked,
      factRecommendedForPublish: !gateDecision.factBlocked,
      publishBlocked: orchestration.publishBlocked,
      orchestrationAction: orchestration.action,
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: data.draftPolicyVersion,
    });

    const degradedNotice =
      usedCases.length < firstAttemptCases.length
        ? [formatDegradeCasesWarning(firstAttemptCases.length, usedCases.length)]
        : [];
    const advisoryFactNotice =
      gateDecision.advisoryFactIssues > 0
        ? [
            `通用回归发现 ${String(gateDecision.advisoryFactIssues)} 个本次新增事实问题，仅告警、不阻断本次保存。`,
          ]
        : [];

    return {
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      draftPolicyVersion: data.draftPolicyVersion,
      summary: data.summary,
      recommendedForPublish: data.summary.recommendedForPublish,
      orchestration,
      evaluationSummaryMarkdown: formatEvaluationSummaryMarkdown(data, scopeOptions),
      warnings: [
        ...preAttemptWarnings,
        ...degradedNotice,
        ...advisoryFactNotice,
        ...data.warnings,
      ],
    };
  },
});
