import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { buildEvaluateTargetInput } from "../services/reply-authority-client.ts";
import { BuiltCaseSchema } from "../types/reply-policy.ts";

const CaseInputSchema = z.object({
  caseId: z.string().min(1).describe("用例 ID"),
  role: z.enum(["primary", "regression"]).describe("primary=本次目标样本；regression=回归样本"),
  regressionScope: z
    .enum(["related", "general"])
    .optional()
    .describe("回归类型：related=与本次修改相关，可阻塞；general=通用观察，新增事实问题只告警"),
  candidateMessage: z.string().min(1).describe("候选人消息"),
  conversationHistory: z.array(z.string()).optional().describe("对话历史（可选）"),
  tags: z.array(z.string()).optional().describe("标签（可选）"),
});

const BuildEvaluateCasesInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("待评估的策略补丁"),
  recruiterUsername: z.string().min(1).describe("已解析的 BOSS 招聘账号名（从 resolve_recruiter_binding 获取）"),
  previewSampleMessage: z
    .string()
    .min(1)
    .describe("preview_policy_effect 返回的 sampleMessage；primary 必须原样复用"),
  cases: z
    .array(CaseInputSchema)
    .min(2)
    .max(3)
    .describe("聚焦评估用例：必须且只能有 1 个 primary，并复用本次 preview/用户提出的问题；必须有 1～2 个 regression，至少 1 个 related；默认生成 1 个 related + 1 个 general。general 可覆盖地点、薪资等通用场景，其新增事实问题只告警"),
});

const BuildEvaluateCasesOutputSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  patch: z.record(z.unknown()),
  cases: z.array(BuiltCaseSchema),
});

export function prepareEvaluateCases(
  cases: z.infer<typeof CaseInputSchema>[],
  previewSampleMessage: string,
): z.infer<typeof CaseInputSchema>[] {
  const hasPrimary = cases.some((item) => item.role === "primary");
  if (!hasPrimary) {
    throw new Error("evaluate_policy_patch 至少需要 1 个 primary 用例");
  }
  const primaryCount = cases.filter((item) => item.role === "primary").length;
  if (primaryCount > 1) {
    throw new Error(
      "聚焦评估只能有 1 个 primary，且必须复用本次 preview/用户提出的问题；地点、薪资等其他场景请标为 regression",
    );
  }
  const primary = cases.find((item) => item.role === "primary");
  if (primary?.candidateMessage.trim() !== previewSampleMessage.trim()) {
    throw new Error(
      "primary.candidateMessage 必须与 preview_policy_effect 返回的 sampleMessage 完全一致，禁止换成其他评估问题",
    );
  }
  const regressionCount = cases.filter((item) => item.role === "regression").length;
  if (regressionCount < 1) {
    throw new Error(
      "聚焦评估至少需要 1 个 regressionScope=related 的回归样本；默认生成 1 个 related + 1 个 general",
    );
  }
  if (regressionCount > 2) {
    throw new Error(
      "聚焦评估最多只能有 2 个 regression；可覆盖地点、薪资等通用场景",
    );
  }
  const regressionCases = cases.filter((item) => item.role === "regression");
  if (regressionCases.some((item) => item.regressionScope === undefined)) {
    throw new Error(
      "每个 regression 都必须声明 regressionScope：related=与本次修改相关，general=通用观察",
    );
  }
  if (!regressionCases.some((item) => item.regressionScope === "related")) {
    throw new Error("聚焦评估至少需要 1 个 regressionScope=related 的回归样本");
  }
  if (cases.some((item) => item.role === "primary" && item.regressionScope !== undefined)) {
    throw new Error("primary 不得设置 regressionScope");
  }

  return [...cases];
}

export const buildEvaluateCasesTool = defineTool({
  name: "build_evaluate_cases",
  description:
    "根据 recruiterUsername 拼装聚焦评估用例。必须且只能有 1 个 primary，并复用本次 preview 或用户明确提出的问题；必须提供 1～2 个 regression，至少 1 个 regressionScope=related。默认生成 1 个 related（与修改相关）+ 1 个 general（地点、薪资等通用观察），并把 related 放在 general 前。related 中 patch 新增的 Hard/Fact 问题可阻塞；general 中新增 Hard 问题阻塞、新增 Fact 问题只告警。相关性由 Agent 根据用户意图和完整 patch 语义判断，不写关键词正则。输出可直接传给 submit_evaluate_policy_patch。",
  input: BuildEvaluateCasesInputSchema,
  output: BuildEvaluateCasesOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Building evaluate cases for tenant: ${input.tenantId}`);

    const cases = prepareEvaluateCases(input.cases, input.previewSampleMessage);

    const builtCases = cases.map((item) => ({
      caseId: item.caseId,
      role: item.role,
      ...(item.regressionScope !== undefined
        ? { regressionScope: item.regressionScope }
        : {}),
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
