import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  buildPolicyComparisonRowsFromDiff,
  formatPolicyComparisonTable,
  formatReplyComparisonTable,
} from "../presentation/comparison.ts";
import { previewPolicyEffect } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";
import { PolicyDiffEntrySchema } from "../types/reply-policy.ts";

const PreviewPolicyEffectInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  basePolicyVersion: z.string().min(1).describe("当前策略版本（从 get_policy 获取）"),
  patch: z.record(z.unknown()).describe("待预览的策略补丁"),
  sampleMessage: z
    .string()
    .optional()
    .describe("用于预览的示例候选人消息（默认用通用示例）"),
  conversationHistory: z.array(z.string()).optional().describe("对话历史（可选）"),
  recruiterUsername: z.string().optional().describe("BOSS 招聘账号名（可选；未提供时自动解析）"),
});

const PreviewPolicyEffectOutputSchema = z.object({
  sampleMessage: z.string(),
  currentReply: z.string(),
  previewReply: z.string(),
  stage: z.string(),
  baseConfidence: z.number().optional(),
  draftConfidence: z.number().optional(),
  diff: z.array(PolicyDiffEntrySchema),
  replyComparisonMarkdown: z.string(),
  policyComparisonMarkdown: z.string(),
});

const DEFAULT_SAMPLE_MESSAGE = "你好，想了解一下这个岗位";

export const previewPolicyEffectTool = defineTool({
  name: "preview_policy_effect",
  description:
    "生成修改前/后话术对比。【重要】展示预览后必须停顿等用户确认，由用户选择「按这个做评估」还是「继续改策略」——这是进入评估的确认点，禁止自动继续 submit_evaluate_policy_patch。只有用户明确同意评估后，下一步才是 submit_evaluate_policy_patch（安全评估）；用户选「继续改」则回到重新生成 patch。注意：preview 后的确认仅授权评估，不是落库确认——禁止在展示预览后说「确认写入吗」「要保存吗」。preview 通过只代表方向可能对，必须评估通过后才能问确认保存",
  input: PreviewPolicyEffectInputSchema,
  output: PreviewPolicyEffectOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Previewing policy effect for tenant: ${input.tenantId}`);

    const candidateMessage = input.sampleMessage ?? DEFAULT_SAMPLE_MESSAGE;

    const result = await previewPolicyEffect(input.tenantId, {
      basePolicyVersion: input.basePolicyVersion,
      patch: input.patch,
      candidateMessage,
      ...(input.conversationHistory !== undefined
        ? { conversationHistory: input.conversationHistory }
        : {}),
      ...(input.recruiterUsername !== undefined
        ? { recruiterUsername: input.recruiterUsername }
        : {}),
    });

    if (!result.ok) {
      throw new Error(translateRasHttpError(result.status, "preview", result.errorMessage));
    }

    const data = result.data;
    if (data === undefined) {
      throw new Error("预览策略效果成功但响应数据为空");
    }

    const policyRows = buildPolicyComparisonRowsFromDiff(data.diff);

    return {
      sampleMessage: candidateMessage,
      currentReply: data.currentReply,
      previewReply: data.previewReply,
      stage: data.stage,
      ...(data.baseConfidence !== undefined ? { baseConfidence: data.baseConfidence } : {}),
      ...(data.draftConfidence !== undefined ? { draftConfidence: data.draftConfidence } : {}),
      diff: data.diff,
      replyComparisonMarkdown: formatReplyComparisonTable({
        sampleMessage: candidateMessage,
        currentReply: data.currentReply,
        previewReply: data.previewReply,
        stage: data.stage,
      }),
      policyComparisonMarkdown: formatPolicyComparisonTable(policyRows),
    };
  },
});
