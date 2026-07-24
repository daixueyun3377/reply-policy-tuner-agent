import { createHash } from "node:crypto";
import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { describeDangerousPatchReason, isDangerousPolicyPatch } from "../dangerous-patch.ts";
import { assertEvaluatePublishGateAllowsUpdate } from "../evaluate-publish-gate.ts";
import { updatePolicy } from "../services/reply-authority-client.ts";
import {
  assertTunerToolAllowed,
  getTunerPolicy,
  type TunerToolPolicy,
} from "../policy.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { ToolActionApprovalSchema } from "../tool-action-approval.ts";

const UpdatePolicyInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("要合并的策略片段"),
  reason: z.string().min(1).describe("变更原因（记入审计日志）"),
  toolActionApproval: ToolActionApprovalSchema.optional().describe(
    "仅当 tool 动态升级为 confirm 时需要；由编排层原样带回的一次性批准 ID",
  ),
});

const UpdatePolicyOutputSchema = z.object({
  tenantId: z.string(),
  source: z.string(),
  policyVersion: z.string(),
  policy: z.record(z.unknown()),
  warnings: z.array(z.string()),
});

/** update_policy 至少需要 confirm；显式 deny 仍优先。 */
export function resolveUpdatePolicyApprovalPolicy(): TunerToolPolicy {
  const configured = getTunerPolicy().tools["update_policy"]?.policy;
  return configured === "deny" ? "deny" : "confirm";
}

export const UPDATE_POLICY_CONFIRMATION_MESSAGE =
  "这次策略修改已通过安全检查。请回复「确认保存」完成修改，或回复「取消」。";

export const updatePolicyTool = defineTool({
  name: "update_policy",
  description:
    "对当前策略做局部更新（deep merge），写入前自动验证。须先 evaluate 且 orchestration.publishBlocked=false。评估结果展示后调用本 tool 获取唯一一次文字保存确认；无 toolActionApproval 时返回 needs_confirmation 并提示用户回复「确认保存」或「取消」，绝不会写入。用户文字明确确认后，上层原样合并 approvalRequest.retryInput 重试；不得要求点击按钮",
  input: UpdatePolicyInputSchema,
  output: UpdatePolicyOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Updating reply policy for tenant: ${input.tenantId}`);

    await assertEvaluatePublishGateAllowsUpdate({
      tenantId: input.tenantId,
      basePolicyVersion: input.basePolicyVersion,
      patch: input.patch,
    });

    // Tool policy guard
    const digest = createHash("sha256")
      .update(`${input.tenantId}:${input.basePolicyVersion}:${JSON.stringify(input.patch)}:${input.reason}`)
      .digest("hex")
      .slice(0, 16);

    const dangerous = isDangerousPolicyPatch(input.patch);

    const assertInput = {
      subject: {
        tool: "update_policy",
        target: input.tenantId,
        digest: `sha256:${digest}`,
        summary: dangerous
          ? `高危策略更新（${describeDangerousPatchReason(input.patch)}）: ${input.reason}`
          : `更新策略: ${input.reason}`,
      },
      deferApprovalConsumption: true,
      policyOverride: resolveUpdatePolicyApprovalPolicy(),
      confirmationMessage: UPDATE_POLICY_CONFIRMATION_MESSAGE,
      ...(input.toolActionApproval !== undefined ? { approval: input.toolActionApproval } : {}),
    } as const;

    const { consumeApproval } = await assertTunerToolAllowed(ctx, assertInput);

    // Call RAS
    const result = await updatePolicy(input.tenantId, {
      basePolicyVersion: input.basePolicyVersion,
      reason: input.reason,
      patch: input.patch,
    });

    if (!result.ok) {
      throw new Error(translateRasHttpError(result.status, "write", result.errorMessage));
    }

    // Consume approval after successful write
    await consumeApproval();

    const data = result.data;
    if (data === undefined) {
      throw new Error("更新策略成功但响应数据为空");
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
