import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { appendSystemRegressionCases } from "../evaluate-regression-cases.ts";
import { assertPolicyPatchShape } from "../policy-patch-guard.ts";
import { buildEvaluateTargetInput } from "../services/reply-authority-client.ts";
import { BuiltCaseSchema } from "../types/reply-policy.ts";

const CaseInputSchema = z
  .object({
    caseId: z.string().min(1).describe("用例 ID"),
    role: z.enum(["primary", "regression"]).describe("primary=主样本；regression=回归样本"),
    candidateMessage: z.string().min(1).describe("候选人消息"),
    conversationHistory: z.array(z.string()).optional().describe("对话历史（可选）"),
    conversationId: z
      .string()
      .min(1)
      .optional()
      .describe("真实会话 ID（可选；如果当前上下文能拿到，必须和 candidateId 一起原样传入）"),
    candidateId: z
      .string()
      .min(1)
      .optional()
      .describe("真实候选人 ID（可选；如果当前上下文能拿到，必须和 conversationId 一起原样传入）"),
    tags: z.array(z.string()).optional().describe("标签（可选）"),
  })
  .superRefine((value, ctx) => {
    if ((value.conversationId === undefined) !== (value.candidateId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "真实会话 ID 和候选人 ID 必须同时传入；如果当前拿不到，可以两个都不传。",
        path: value.conversationId === undefined ? ["conversationId"] : ["candidateId"],
      });
    }
  });

const BuildEvaluateCasesInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("待评估的策略补丁"),
  recruiterUsername: z.string().min(1).describe("已解析的 BOSS 招聘账号名（从 resolve_recruiter_binding 获取）"),
  cases: z
    .array(CaseInputSchema)
    .min(1)
    .max(5)
    .describe("评估用例（至少 1 个 primary；系统会自动补 1 条事实边界 smoke regression；总数不超过 5 条，submit 会按 2p+1r 裁切）"),
});

const BuildEvaluateCasesOutputSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  patch: z.record(z.unknown()),
  cases: z.array(BuiltCaseSchema),
});

export const buildEvaluateCasesTool = defineTool({
  name: "build_evaluate_cases",
  description:
    "根据 recruiterUsername 和用例列表，拼装完整的 evaluate 请求 cases（含 target 结构）。自动补齐系统事实边界 smoke regression。输出可直接传给 submit_evaluate_policy_patch。",
  input: BuildEvaluateCasesInputSchema,
  output: BuildEvaluateCasesOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Building evaluate cases for tenant: ${input.tenantId}`);
    assertPolicyPatchShape(input.patch);

    const cases = appendSystemRegressionCases(input.cases);

    const builtCases = cases.map((item) => ({
      caseId: item.caseId,
      role: item.role,
      ...(item.tags !== undefined ? { tags: item.tags } : {}),
      input: buildEvaluateTargetInput({
        tenantId: input.tenantId,
        recruiterUsername: input.recruiterUsername,
        caseId: item.caseId,
        candidateMessage: item.candidateMessage,
        ...(item.conversationHistory !== undefined
          ? { conversationHistory: item.conversationHistory }
          : {}),
        ...(item.conversationId !== undefined ? { conversationId: item.conversationId } : {}),
        ...(item.candidateId !== undefined ? { candidateId: item.candidateId } : {}),
      }),
    }));

    return {
      tenantId: input.tenantId,
      basePolicyVersion: input.basePolicyVersion,
      patch: input.patch,
      cases: builtCases,
    };
  },
});
