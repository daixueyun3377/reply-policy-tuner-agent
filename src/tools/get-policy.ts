import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { summarizePolicyForOperator } from "../presentation/policy-summary.ts";
import { getPolicy } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { GetPolicyResponseSchema } from "../types/reply-policy.ts";

const POLICY_SECTIONS = [
  "persona",
  "stageGoals",
  "hardConstraints",
  "industryVoices",
  "factGate",
  "qualificationPolicy",
  "outputGuards",
] as const;

const GetPolicyInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  section: z
    .enum(POLICY_SECTIONS)
    .optional()
    .describe("只返回指定模块（可选）"),
});

const GetPolicyOutputSchema = z.object({
  tenantId: z.string(),
  source: z.string(),
  policyVersion: z.string(),
  policy: z.record(z.unknown()),
  warnings: z.array(z.string()),
  operatorSummary: z.string().optional(),
});

export const getPolicyTool = defineTool({
  name: "get_policy",
  description:
    "读取当前生效策略。返回 policyVersion（编排须记下作 basePolicyVersion，勿向运营展示）与 operatorSummary（人设/阶段/保护规则等要点，供运营阅读）",
  input: GetPolicyInputSchema,
  output: GetPolicyOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Reading reply policy for tenant: ${input.tenantId}`);

    const result = await getPolicy(input.tenantId);

    if (!result.ok) {
      throw new Error(translateRasHttpError(result.status, "read", result.errorMessage));
    }

    const data = GetPolicyResponseSchema.parse(result.data);

    // If section is specified, only return that section
    if (input.section !== undefined) {
      const sectionData = (data.policy as Record<string, unknown>)[input.section];
      const policy = { [input.section]: sectionData };
      return {
        tenantId: data.tenantId,
        source: data.source,
        policyVersion: data.policyVersion,
        policy,
        warnings: data.warnings,
        operatorSummary: summarizePolicyForOperator(policy, data.warnings),
      };
    }

    const policy = data.policy as Record<string, unknown>;
    return {
      tenantId: data.tenantId,
      source: data.source,
      policyVersion: data.policyVersion,
      policy,
      warnings: data.warnings,
      operatorSummary: summarizePolicyForOperator(policy, data.warnings),
    };
  },
});
