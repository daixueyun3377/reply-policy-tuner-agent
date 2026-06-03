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
 * 解析 preview / evaluate 所需的 BOSS 招聘账号绑定。
 */
export async function resolveRecruiterUsername(
  tenantId: string,
  explicitUsername: string | undefined,
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<{ username: string }>> {
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

    if (result.ok && result.data?.tenantId === tenantId) {
      return { ok: true, status: result.status, data: { username } };
    }
  }

  return {
    ok: false,
    status: 404,
    errorMessage:
      "无法解析预览/评估用的招聘账号绑定；请设置 REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME 或确认 tenant 已绑定 BOSS 账号",
  };
}
