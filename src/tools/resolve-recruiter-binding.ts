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
    "解析 BOSS 招聘账号绑定。默认修改本人策略时，传当前 BOSS recruiterUsername 且不传 tenantId，自动返回唯一绑定租户，不让用户选择。仅当用户明确修改他人策略并从 Token 可管理范围选定 tenantId 后，传 tenantId + 目标 recruiterUsername 校验绑定。始终自动校验当前 Token 是否有租户管理权限。",
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

    const { tenantIds } = authResult.data;

    // Admin token 的 tenantIds 为 null 表示可管理所有租户
    if (tenantIds !== null && !tenantIds.includes(resolvedTenantId)) {
      const displayName = binding.data.username;
      throw new Error(
        `「${displayName}」对应的策略你暂时无权限修改，请联系管理员。`,
      );
    }

    return {
      tenantId: resolvedTenantId,
      recruiterUsername: binding.data.username,
    };
  },
});
