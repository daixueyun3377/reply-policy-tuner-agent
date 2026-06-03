import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { resolveRecruiterUsername } from "../services/recruiter-binding.ts";
import { translateRasHttpError } from "../ras-errors.ts";

const ResolveRecruiterBindingInputSchema = z.object({
  tenantId: z.string().min(1).describe("目标运营人员 ID（tenantId）"),
  recruiterUsername: z
    .string()
    .optional()
    .describe("BOSS 招聘账号名（可选；未提供时自动解析）"),
});

const ResolveRecruiterBindingOutputSchema = z.object({
  tenantId: z.string(),
  recruiterUsername: z.string(),
});

export const resolveRecruiterBindingTool = defineTool({
  name: "resolve_recruiter_binding",
  description:
    "解析 evaluate/preview 所需的 BOSS 招聘账号绑定。返回确认可用的 recruiterUsername，供后续 build_evaluate_cases 使用。",
  input: ResolveRecruiterBindingInputSchema,
  output: ResolveRecruiterBindingOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Resolving recruiter binding for tenant: ${input.tenantId}`);

    const binding = await resolveRecruiterUsername(input.tenantId, input.recruiterUsername);
    if (!binding.ok || binding.data === undefined) {
      throw new Error(
        translateRasHttpError(binding.status, "evaluate", binding.errorMessage),
      );
    }

    return {
      tenantId: input.tenantId,
      recruiterUsername: binding.data.username,
    };
  },
});
