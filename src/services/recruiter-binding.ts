import { z } from "zod";
import type { ReplyAuthorityConfig } from "./reply-authority-client.ts";
import type { RasResponse } from "./reply-authority-client.ts";
import { request } from "./reply-authority-client.ts";

const ResolveRecruiterBindingResponseSchema = z.object({
  tenantId: z.string(),
  recruiterBinding: z.object({
    platform: z.literal("zhipin"),
    username: z.string(),
    accountId: z.string().optional(),
  }),
});

export interface RecruiterBindingResult {
  tenantId: string;
  username: string;
}

const DEFAULT_RECRUITER_CANDIDATES = ["任思文"] as const;

function configuredRecruiterUsername(): string | undefined {
  const value = process.env["REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME"]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function recruiterCandidates(explicitUsername: string | undefined): readonly string[] {
  const configured = configuredRecruiterUsername();
  const candidates: string[] = [];

  if (explicitUsername !== undefined && explicitUsername.length > 0) {
    candidates.push(explicitUsername);
  }

  if (configured !== undefined && !candidates.includes(configured)) {
    candidates.push(configured);
  }

  for (const fallback of DEFAULT_RECRUITER_CANDIDATES) {
    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }

  return candidates;
}

/**
 * 调用 POST /resolve-recruiter-binding 解析 BOSS 招聘账号绑定。
 * 接口入参：{ platform: "zhipin", username }
 * 接口返回：{ tenantId, recruiterBinding: { platform, username, accountId? } }
 *
 * 当 tenantId 传入时：校验返回的 tenantId 是否与期望一致（用于 evaluate/preview 前的绑定校验）。
 * 当 tenantId 未传入时：直接返回接口返回的 tenantId（用于按人名定位 tenant）。
 */
export async function resolveRecruiterUsername(
  tenantId: string | undefined,
  explicitUsername: string | undefined,
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<RecruiterBindingResult>> {
  for (const username of recruiterCandidates(explicitUsername)) {
    const result = await request(
      {
        method: "POST",
        pathname: "resolve-recruiter-binding",
        body: { platform: "zhipin", username },
      },
      ResolveRecruiterBindingResponseSchema,
      configInput,
    );

    if (!result.ok || result.data === undefined) {
      continue;
    }

    // 未指定 tenantId：直接返回接口解析到的 tenantId
    if (tenantId === undefined) {
      return {
        ok: true,
        status: result.status,
        data: { tenantId: result.data.tenantId, username },
      };
    }

    // 指定了 tenantId：校验匹配
    if (result.data.tenantId === tenantId) {
      return { ok: true, status: result.status, data: { tenantId, username } };
    }
  }

  return {
    ok: false,
    status: 404,
    errorMessage:
      "无法解析预览/评估用的招聘账号绑定；请设置 REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME 或确认 tenant 已绑定 BOSS 账号",
  };
}
