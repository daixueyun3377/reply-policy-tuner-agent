import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  buildPolicyComparisonRowsFromDiff,
  formatPolicyComparisonTable,
} from "../presentation/comparison.ts";
import { validatePatch } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { PolicyDiffEntrySchema } from "../types/reply-policy.ts";

const ValidatePatchInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("待校验的策略补丁（局部片段）"),
  hypothesis: z.string().optional().describe("变更假设说明（可选，用于审计上下文）"),
});

const ValidatePatchOutputSchema = z.object({
  valid: z.boolean(),
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  draftPolicyVersion: z.string(),
  source: z.string(),
  warnings: z.array(z.string()),
  diff: z.array(PolicyDiffEntrySchema),
  policyComparisonMarkdown: z.string(),
  errors: z.array(z.string()).optional(),
});

export const validatePatchTool = defineTool({
  name: "validate_patch",
  description:
    "校验策略补丁是否合法（不写入）；返回字段级 diff 与 lint 警告。valid=true 只表示结构和服务端规则通过，不能替代基于完整当前策略的语义一致性检查；该检查必须在向用户展示方案前完成并先内部修正冲突。validate 通过后自动继续 preview_policy_effect（无须向用户要确认）；preview 展示后须停顿等用户确认是否进入 submit_evaluate_policy_patch（安全评估）。不得在 validate 通过后问用户确认写入",
  input: ValidatePatchInputSchema,
  output: ValidatePatchOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Validating reply policy patch for tenant: ${input.tenantId}`);

    const result = await validatePatch(input.tenantId, {
      basePolicyVersion: input.basePolicyVersion,
      patch: input.patch,
      ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
    });

    if (!result.ok) {
      if (result.status === 400) {
        return {
          valid: false,
          tenantId: input.tenantId,
          basePolicyVersion: input.basePolicyVersion,
          draftPolicyVersion: "",
          source: "",
          warnings: [],
          diff: [],
          policyComparisonMarkdown: "（校验失败，无 diff）",
          errors: [translateRasHttpError(400, "validatePatch", result.errorMessage)],
        };
      }

      throw new Error(translateRasHttpError(result.status, "validatePatch", result.errorMessage));
    }

    const data = result.data;
    if (data === undefined) {
      throw new Error("校验补丁成功但响应数据为空");
    }

    const rows = buildPolicyComparisonRowsFromDiff(data.diff);

    return {
      valid: true,
      tenantId: data.tenantId,
      basePolicyVersion: data.basePolicyVersion,
      draftPolicyVersion: data.draftPolicyVersion,
      source: data.source,
      warnings: data.warnings,
      diff: data.diff,
      policyComparisonMarkdown: formatPolicyComparisonTable(rows),
    };
  },
});
