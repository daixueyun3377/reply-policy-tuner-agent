import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { buildEvaluateTargetInput } from "../services/reply-authority-client.ts";
import { BuiltCaseSchema } from "../types/reply-policy.ts";

const CaseInputSchema = z.object({
  caseId: z.string().min(1).describe("用例 ID"),
  role: z.enum(["primary", "regression"]).describe("primary=主样本；regression=回归样本"),
  candidateMessage: z.string().min(1).describe("候选人消息"),
  conversationHistory: z.array(z.string()).optional().describe("对话历史（可选）"),
  tags: z.array(z.string()).optional().describe("标签（可选）"),
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
    .describe("评估用例（至少 1 个 primary；推荐 2-3 条 primary + 自动补 1 条 regression；总数不超过 5 条避免超时）"),
});

const BuildEvaluateCasesOutputSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  patch: z.record(z.unknown()),
  cases: z.array(BuiltCaseSchema),
});

const DEFAULT_REGRESSION_CASE = {
  caseId: "regression-greeting-001",
  role: "regression" as const,
  candidateMessage: "你好，想了解一下这个岗位",
  tags: ["regression", "greeting"],
};

function ensureRegressionCase(
  cases: z.infer<typeof CaseInputSchema>[],
): z.infer<typeof CaseInputSchema>[] {
  const hasPrimary = cases.some((item) => item.role === "primary");
  if (!hasPrimary) {
    throw new Error("evaluate_policy_patch 至少需要 1 个 primary 用例");
  }

  const hasRegression = cases.some((item) => item.role === "regression");
  if (hasRegression) {
    return cases;
  }

  if (cases.length >= 5) {
    throw new Error("evaluate_policy_patch 需要至少 1 个 regression 用例，但 cases 已达上限 5 条");
  }

  return [...cases, DEFAULT_REGRESSION_CASE];
}

export const buildEvaluateCasesTool = defineTool({
  name: "build_evaluate_cases",
  description:
    "根据 recruiterUsername 和用例列表，拼装完整的 evaluate 请求 cases（含 target 结构）。自动补齐 regression 样本。输出可直接传给 submit_evaluate_policy_patch。",
  input: BuildEvaluateCasesInputSchema,
  output: BuildEvaluateCasesOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Building evaluate cases for tenant: ${input.tenantId}`);

    const cases = ensureRegressionCase(input.cases);

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
