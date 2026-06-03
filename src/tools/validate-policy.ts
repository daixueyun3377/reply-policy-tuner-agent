import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { validatePolicy } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";

const ValidatePolicyInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  policy: z.record(z.unknown()).describe("完整策略对象（当前策略 + patch 合并后的结果）"),
});

const ValidatePolicyOutputSchema = z.object({
  valid: z.boolean(),
  tenantId: z.string(),
  source: z.string().optional(),
  policyVersion: z.string().optional(),
  policy: z.record(z.unknown()).optional(),
  warnings: z.array(z.string()),
  errors: z.array(z.string()).optional(),
});

export const validatePolicyTool = defineTool({
  name: "validate_policy",
  description: "验证一份策略草稿是否合法，不实际写入。用于修改前的预检",
  input: ValidatePolicyInputSchema,
  output: ValidatePolicyOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Validating reply policy draft for tenant: ${input.tenantId}`);

    const result = await validatePolicy(input.tenantId, { policy: input.policy });

    if (!result.ok) {
      if (result.status === 400) {
        return {
          valid: false,
          tenantId: input.tenantId,
          warnings: [],
          errors: [translateRasHttpError(400, "validate", result.errorMessage)],
        };
      }

      throw new Error(translateRasHttpError(result.status, "validate", result.errorMessage));
    }

    const data = result.data;
    if (data === undefined) {
      throw new Error("验证策略成功但响应数据为空");
    }

    return {
      valid: true,
      tenantId: data.tenantId,
      source: data.source,
      policyVersion: data.policyVersion,
      policy: data.policy as Record<string, unknown>,
      warnings: data.warnings,
    };
  },
});
