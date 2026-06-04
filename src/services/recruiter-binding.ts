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

// ========== Binding 解析缓存 ==========
//
// preview / resolve_recruiter_binding 会重复解析同一个 tenantId+username 的绑定，
// 每次都触发一次 POST /resolve-recruiter-binding 往返；未显式传 username 时还会
// 按候选列表串行试探多次。一轮迭代内绑定关系不会变，用短 TTL 进程内缓存复用
// 已成功的解析结果，省掉重复往返与候选试探。
//
// 仅缓存成功结果：失败可能是瞬时网络问题或绑定尚未建立，不应被缓存放大。

const DEFAULT_BINDING_CACHE_TTL_MS = 60_000;

interface BindingCacheEntry {
  readonly result: RecruiterBindingResult;
  readonly expiresAtMs: number;
}

const bindingCache = new Map<string, BindingCacheEntry>();

let bindingCacheTtlMsOverride: number | undefined;

function resolveBindingCacheTtlMs(): number {
  if (bindingCacheTtlMsOverride !== undefined) {
    return bindingCacheTtlMsOverride;
  }

  const raw = process.env["REPLY_POLICY_TUNER_BINDING_CACHE_TTL_MS"]?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && String(parsed) === raw) {
      return parsed;
    }
  }

  return DEFAULT_BINDING_CACHE_TTL_MS;
}

function bindingCacheKey(
  tenantId: string | undefined,
  explicitUsername: string | undefined,
  configInput?: ReplyAuthorityConfig,
): string {
  // baseUrl 影响绑定来源；configured username 影响候选列表 → 一并纳入 key，
  // 避免切换环境/默认账号时命中过期缓存。
  const baseUrl = configInput?.baseUrl ?? process.env["REPLY_AUTHORITY_URL"]?.trim() ?? "";
  return [
    baseUrl,
    tenantId ?? "<auto>",
    explicitUsername ?? "",
    configuredRecruiterUsername() ?? "",
  ].join("\u0000");
}

function readBindingCache(key: string): RecruiterBindingResult | undefined {
  const entry = bindingCache.get(key);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.expiresAtMs <= Date.now()) {
    bindingCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function writeBindingCache(key: string, result: RecruiterBindingResult): void {
  const ttlMs = resolveBindingCacheTtlMs();
  if (ttlMs <= 0) {
    return;
  }
  bindingCache.set(key, { result, expiresAtMs: Date.now() + ttlMs });
}

/** 测试辅助：清空缓存并可临时覆盖 TTL（传 undefined 还原为默认/env） */
export function resetRecruiterBindingCacheForTests(ttlMsOverride?: number): void {
  bindingCache.clear();
  bindingCacheTtlMsOverride = ttlMsOverride;
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
  const cacheKey = bindingCacheKey(tenantId, explicitUsername, configInput);
  const cached = readBindingCache(cacheKey);
  if (cached !== undefined) {
    return { ok: true, status: 200, data: cached };
  }

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
      const data = { tenantId: result.data.tenantId, username };
      writeBindingCache(cacheKey, data);
      return {
        ok: true,
        status: result.status,
        data,
      };
    }

    // 指定了 tenantId：校验匹配
    if (result.data.tenantId === tenantId) {
      const data = { tenantId, username };
      writeBindingCache(cacheKey, data);
      return { ok: true, status: result.status, data };
    }
  }

  return {
    ok: false,
    status: 404,
    errorMessage:
      "无法解析预览/评估用的招聘账号绑定；请设置 REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME 或确认 tenant 已绑定 BOSS 账号",
  };
}
