import { createHash } from "node:crypto";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { resetPolicy } from "../services/reply-authority-client.ts";
import { assertTunerToolAllowed } from "../policy.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { ToolActionApprovalSchema } from "../tool-action-approval.ts";

const ResetPolicyInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本"),
  reason: z.string().min(1).describe("变更原因"),
  toolActionApproval: ToolActionApprovalSchema.optional().describe(
    "当 tool policy 返回 needs_confirmation 后，由编排层原样带回的一次性批准 ID",
  ),
});

const ResetPolicyOutputSchema = z.object({
  tenantId: z.string(),
  source: z.string(),
  policyVersion: z.string(),
  policy: z.record(z.unknown()),
  warnings: z.array(z.string()),
});

export const resetPolicyTool = defineTool({
  name: "reset_policy",
  description: "删除租户的自定义策略，回退到全局默认策略。高危操作，需要双层确认",
  input: ResetPolicyInputSchema,
  output: ResetPolicyOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Resetting reply policy for tenant: ${input.tenantId}`);

    // Tool policy guard — reset_policy defaults to "confirm"
    const digest = createHash("sha256")
      .update(`${input.tenantId}:${input.basePolicyVersion}:${input.reason}:reset`)
      .digest("hex")
      .slice(0, 16);

    const assertInput = {
      subject: {
        tool: "reset_policy",
        target: input.tenantId,
        digest: `sha256:${digest}`,
        summary: `重置策略：清除全部自定义，回退系统默认`,
      },
      deferApprovalConsumption: true,
      ...(input.toolActionApproval !== undefined ? { approval: input.toolActionApproval } : {}),
    } as const;

    const { consumeApproval } = await assertTunerToolAllowed(ctx, assertInput);

    // Call RAS DELETE
    const result = await resetPolicy(input.tenantId, {
      basePolicyVersion: input.basePolicyVersion,
      reason: input.reason,
    });

    if (!result.ok) {
      throw new Error(translateRasHttpError(result.status, "reset", result.errorMessage));
    }

    // Consume approval after successful delete
    await consumeApproval();

    const data = result.data;
    if (data === undefined) {
      throw new Error("重置策略成功但响应数据为空");
    }

    return {
      tenantId: data.tenantId,
      source: data.source,
      policyVersion: data.policyVersion,
      policy: data.policy as Record<string, unknown>,
      warnings: data.warnings,
    };
  },
});
