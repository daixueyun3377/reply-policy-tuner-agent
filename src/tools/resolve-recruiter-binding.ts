import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import { resolveRecruiterUsername } from "../services/recruiter-binding.ts";
import { getAuthContext } from "../services/reply-authority-client.ts";
import { translateRasHttpError } from "../ras-errors.ts";

const ResolveRecruiterBindingInputSchema = z.object({
  tenantId: z.string().min(1).optional().describe("目标运营人员 ID（tenantId）；未提供时通过 recruiterUsername 自动解析"),
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
    "解析 BOSS 招聘账号绑定。两种用法：1）传 recruiterUsername（不传 tenantId）→ 返回该账号对应的 tenantId；2）传 tenantId + recruiterUsername → 校验绑定关系。会自动校验当前 token 是否有该 tenantId 的管理权限。",
  input: ResolveRecruiterBindingInputSchema,
  output: ResolveRecruiterBindingOutputSchema,
  execute: async (input, ctx) => {
    ctx.logger.info(`Resolving recruiter binding${input.tenantId ? ` for tenant: ${input.tenantId}` : " (auto-resolve tenantId)"}`);

    const binding = await resolveRecruiterUsername(input.tenantId, input.recruiterUsername);
    if (!binding.ok || binding.data === undefined) {
      throw new Error(
        translateRasHttpError(binding.status, "evaluate", binding.errorMessage),
      );
    }

    const resolvedTenantId = binding.data.tenantId;

    // 校验当前 token 是否有该 tenantId 的管理权限
    const authResult = await getAuthContext();
    if (!authResult.ok || authResult.data === undefined) {
      throw new Error("无法验证当前账号权限，请检查 Token 配置是否正确。");
    }

    const { tenantIds, role } = authResult.data;

    // Admin token 的 tenantIds 为 null 表示可管理所有租户
    if (tenantIds !== null && !tenantIds.includes(resolvedTenantId)) {
      const displayName = binding.data.username;
      throw new Error(
        `你没有管理「${displayName}」回复策略的权限。当前账号${role === "admin" ? "可管理的运营人员不包含该用户" : "只能管理自己的策略"}，请联系管理员开通权限。`,
      );
    }

    return {
      tenantId: resolvedTenantId,
      recruiterUsername: binding.data.username,
    };
  },
});
