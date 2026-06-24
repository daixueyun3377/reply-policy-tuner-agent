import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  buildPolicyComparisonRowsFromDiff,
  formatPolicyComparisonTable,
} from "../presentation/comparison.ts";
import { validatePatch } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { PolicyDiffEntrySchema } from "../types/reply-policy.ts";
import { getUnsupportedPolicyPatchPaths } from "../policy-patch-guard.ts";
import { buildPolicyPatchRecovery, PATCH_RECOVERY_NEXT_ACTIONS } from "../policy-patch-recovery.ts";

const ValidatePatchInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("待校验的策略补丁（局部片段）"),
  userRequest: z
    .string()
    .min(1)
    .describe(
      "用户原始需求，必须原样传入，不要总结、不要改写。用于 patch 校验失败时重新生成可支持的修改方案。",
    ),
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
  recoverable: z.boolean().optional(),
  nextAction: z.enum(PATCH_RECOVERY_NEXT_ACTIONS).optional(),
  agentInstruction: z.string().optional(),
  userFacingPlan: z.string().optional(),
  suggestedPatch: z.record(z.unknown()).optional(),
});

export const validatePatchTool = defineTool({
  name: "validate_patch",
  description:
    "校验策略补丁是否合法（不写入）；返回字段级 diff 与 lint 警告。必须把用户原始需求原样放入 userRequest，不要总结、不要改写。用户只需要说业务目标；生成 patch 时由 Agent 自己映射到现有策略项，面向用户只说“调整回复语气、调整提问方式”等口语化描述，不展示策略 JSON 字段名，不新造策略项。若返回 recoverable=true 且 nextAction=retry_with_suggested_patch，必须直接用 suggestedPatch 重新调用 validate_patch，不要向用户展示内部失败原因。validate 通过后自动继续 preview_policy_effect（无须向用户要确认）；preview 展示后须停顿等用户确认是否进入 submit_evaluate_policy_patch（安全评估）。不得在 validate 通过后问用户确认写入",
  input: ValidatePatchInputSchema,
  output: ValidatePatchOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Validating reply policy patch for tenant: ${input.tenantId}`);

    const unsupportedPaths = getUnsupportedPolicyPatchPaths(input.patch);
    if (unsupportedPaths.length > 0) {
      ctx.logger.warn(
        `validate_patch generated unsupported policy paths: ${unsupportedPaths.join(", ")}`,
      );
      const recovery = buildPolicyPatchRecovery(input.userRequest);
      return {
        valid: false,
        tenantId: input.tenantId,
        basePolicyVersion: input.basePolicyVersion,
        draftPolicyVersion: "",
        source: "",
        warnings: [],
        diff: [],
        policyComparisonMarkdown: "请使用修正后的修改方案重新校验，通过后再生成策略对比。",
        errors: [recovery.agentInstruction],
        recoverable: recovery.recoverable,
        nextAction: recovery.nextAction,
        agentInstruction: recovery.agentInstruction,
        userFacingPlan: recovery.userFacingPlan,
        ...(recovery.suggestedPatch !== undefined ? { suggestedPatch: recovery.suggestedPatch } : {}),
      };
    }

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
