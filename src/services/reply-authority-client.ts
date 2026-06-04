import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AdminTenantsResponseSchema,
  AuthContextResponseSchema,
  EvaluatePatchResponseSchema,
  GetPolicyResponseSchema,
  PreviewPatchResponseSchema,
  PreviewPolicyEffectResponseSchema,
  ValidatePatchResponseSchema,
  type AdminTenantsResponse,
  type AuthContextResponse,
  type EvaluatePatchResponse,
  type GetPolicyResponse,
  type PreviewPatchResponse,
  type PreviewPolicyEffectResponse,
  type ValidatePatchResponse,
} from "../types/reply-policy.ts";
import { resolveRecruiterUsername } from "./recruiter-binding.ts";

// ========== Inlined from @roll-agent/reply-authority-client ==========

export interface ReplyAuthorityConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}

interface ReplyAuthorityRequestMeta {
  readonly url: string;
  readonly timeoutMs: number;
  readonly requestId?: string;
}

interface ReplyAuthorityRequestErrorOptions extends ErrorOptions {
  readonly meta: ReplyAuthorityRequestMeta;
  readonly timedOut?: boolean;
}

function formatRequestMeta(meta: ReplyAuthorityRequestMeta): string {
  const details = [`url=${meta.url}`, `timeoutMs=${String(meta.timeoutMs)}`];
  if (meta.requestId !== undefined) {
    details.push(`requestId=${meta.requestId}`);
  }
  return details.join(", ");
}

export class ReplyAuthorityRequestError extends Error {
  readonly meta: ReplyAuthorityRequestMeta;
  /** 是否因请求超时（AbortError）导致 */
  readonly timedOut: boolean;

  constructor(message: string, options: ReplyAuthorityRequestErrorOptions) {
    super(`${message} (${formatRequestMeta(options.meta)})`, { cause: options.cause });
    this.name = "ReplyAuthorityRequestError";
    this.meta = options.meta;
    this.timedOut = options.timedOut ?? false;
  }
}

/** 判断错误是否为 Reply Authority 请求超时（用于 evaluate 降级重试） */
export function isReplyAuthorityTimeout(error: unknown): boolean {
  return error instanceof ReplyAuthorityRequestError && error.timedOut;
}

// ========== End inlined ==========

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** evaluate 接口涉及双路回放 + 可选 Judge，需要更长超时 */
const DEFAULT_EVALUATE_TIMEOUT_MS = 60_000;

function resolveEvaluateTimeoutMs(configuredTimeoutMs: number | undefined): number {
  const envRaw = process.env["REPLY_AUTHORITY_EVALUATE_TIMEOUT_MS"]?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && String(parsed) === envRaw) {
      return parsed;
    }
  }

  if (configuredTimeoutMs !== undefined && configuredTimeoutMs > DEFAULT_REQUEST_TIMEOUT_MS) {
    return configuredTimeoutMs;
  }

  return DEFAULT_EVALUATE_TIMEOUT_MS;
}

// ========== Config Resolution ==========

interface ResolvedConfig {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
}

interface RequestMeta {
  readonly url: string;
  readonly method: string;
  readonly timeoutMs: number;
  readonly requestId: string;
}

function resolveRequestTimeoutMs(configuredTimeoutMs: number | undefined): number {
  if (configuredTimeoutMs !== undefined) {
    return Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const raw = process.env["REPLY_AUTHORITY_TIMEOUT_MS"]?.trim();
  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

function getRequiredEnv(name: "REPLY_AUTHORITY_URL" | "REPLY_AUTHORITY_BEARER_TOKEN"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} 未配置，无法调用 Reply Authority Service。`);
  }
  return value;
}

function loadConfig(config?: ReplyAuthorityConfig): ResolvedConfig {
  return {
    baseUrl: config?.baseUrl ?? getRequiredEnv("REPLY_AUTHORITY_URL"),
    bearerToken: config?.bearerToken ?? getRequiredEnv("REPLY_AUTHORITY_BEARER_TOKEN"),
    timeoutMs: resolveRequestTimeoutMs(config?.timeoutMs),
  };
}

function buildEndpoint(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(pathname, normalizedBaseUrl).toString();
}

// ========== HTTP Helpers ==========

const ErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  error: z.string().optional(),
  message: z.string(),
});

function wrapError(error: unknown, meta: RequestMeta): ReplyAuthorityRequestError {
  if (error instanceof ReplyAuthorityRequestError) {
    return error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new ReplyAuthorityRequestError("Reply Authority Service 请求超时。", {
      cause: error,
      timedOut: true,
      meta: { url: meta.url, timeoutMs: meta.timeoutMs, requestId: meta.requestId },
    });
  }

  if (error instanceof Error) {
    return new ReplyAuthorityRequestError(error.message, {
      cause: error,
      meta: { url: meta.url, timeoutMs: meta.timeoutMs, requestId: meta.requestId },
    });
  }

  return new ReplyAuthorityRequestError("Reply Authority Service 请求失败。", {
    cause: error,
    meta: { url: meta.url, timeoutMs: meta.timeoutMs, requestId: meta.requestId },
  });
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Reply Authority Service 返回了非 JSON 响应。");
  }
}

function parseErrorMessage(status: number, payload: unknown): string {
  const parsed = ErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return parsed.data.message;
  }
  return `HTTP ${String(status)}`;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  readonly method: HttpMethod;
  readonly pathname: string;
  readonly body?: unknown;
  readonly config?: ReplyAuthorityConfig;
}

export interface RasResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: T;
  readonly errorMessage?: string;
}

export async function request<T>(
  options: RequestOptions,
  schema: z.ZodType<T>,
  configInput?: ReplyAuthorityConfig,
  timeoutOverrideMs?: number,
): Promise<RasResponse<T>> {
  const config = loadConfig(configInput ?? options.config);
  const effectiveTimeoutMs = timeoutOverrideMs ?? config.timeoutMs;
  const requestId = randomUUID();
  const url = buildEndpoint(config.baseUrl, options.pathname);
  const meta: RequestMeta = {
    url,
    method: options.method,
    timeoutMs: effectiveTimeoutMs,
    requestId,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${config.bearerToken}`,
      "x-request-id": requestId,
    };

    const fetchOptions: RequestInit = {
      method: options.method,
      headers,
      signal: controller.signal,
    };

    if (options.body !== undefined) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);
    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorMessage: parseErrorMessage(response.status, payload),
      };
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ReplyAuthorityRequestError(
        `Reply Authority Service 响应校验失败: ${parsed.error.message}`,
        { meta: { url: meta.url, timeoutMs: meta.timeoutMs, requestId: meta.requestId } },
      );
    }

    return { ok: true, status: response.status, data: parsed.data };
  } catch (error) {
    if (error instanceof ReplyAuthorityRequestError) {
      throw error;
    }
    throw wrapError(error, meta);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ========== Public API ==========

/**
 * GET /health — 无需 Token，验证 RAS 可达
 */
export async function checkHealth(
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<{ status: string; timestamp: string }>> {
  const config = loadConfig(configInput);
  const url = buildEndpoint(config.baseUrl, "health");
  const requestId = randomUUID();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "x-request-id": requestId },
      signal: controller.signal,
    });

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorMessage: parseErrorMessage(response.status, payload),
      };
    }

    const schema = z.object({ status: z.string(), timestamp: z.string() });
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, status: response.status, errorMessage: "响应格式异常" };
    }

    return { ok: true, status: response.status, data: parsed.data };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, status: 0, errorMessage: "请求超时" };
    }
    return {
      ok: false,
      status: 0,
      errorMessage: error instanceof Error ? error.message : "未知错误",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * GET /auth/context — Token 授权上下文（tenantIds + scopes）
 */
export async function getAuthContext(
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<AuthContextResponse>> {
  return request({ method: "GET", pathname: "auth/context" }, AuthContextResponseSchema, configInput);
}

/**
 * GET /admin/tenants — Token 类型探测 + 运营人员列表
 */
export async function listAdminTenants(
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<AdminTenantsResponse>> {
  return request({ method: "GET", pathname: "admin/tenants" }, AdminTenantsResponseSchema, configInput);
}

/**
 * GET /tenants/:tenantId/reply-policy — 读取当前策略
 */
export async function getPolicy(
  tenantId: string,
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<GetPolicyResponse>> {
  return request(
    { method: "GET", pathname: `tenants/${tenantId}/reply-policy` },
    GetPolicyResponseSchema,
    configInput,
  );
}

/**
 * PATCH /tenants/:tenantId/reply-policy — 局部更新策略
 */
export async function updatePolicy(
  tenantId: string,
  body: { basePolicyVersion: string; reason: string; patch: Record<string, unknown> },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<GetPolicyResponse>> {
  return request(
    { method: "PATCH", pathname: `tenants/${tenantId}/reply-policy`, body },
    GetPolicyResponseSchema,
    configInput,
  );
}

/**
 * POST /tenants/:tenantId/reply-policy:validate — 验证策略草稿
 */
export async function validatePolicy(
  tenantId: string,
  body: { policy: Record<string, unknown> },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<GetPolicyResponse>> {
  return request(
    { method: "POST", pathname: `tenants/${tenantId}/reply-policy:validate`, body },
    GetPolicyResponseSchema,
    configInput,
  );
}

/**
 * POST /tenants/:tenantId/reply-policy:validate-patch — 校验补丁
 */
export async function validatePatch(
  tenantId: string,
  body: {
    basePolicyVersion: string;
    patch: Record<string, unknown>;
    hypothesis?: string;
  },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<ValidatePatchResponse>> {
  return request(
    { method: "POST", pathname: `tenants/${tenantId}/reply-policy:validate-patch`, body },
    ValidatePatchResponseSchema,
    configInput,
  );
}

/**
 * POST /tenants/:tenantId/reply-policy:preview — base/draft 话术预览
 */
export async function previewPolicyPatch(
  tenantId: string,
  body: {
    basePolicyVersion: string;
    patch: Record<string, unknown>;
    input: {
      candidateMessage: string;
      conversationHistory?: string[];
      defaultWechatId?: string;
      target: {
        platform: "zhipin";
        tenantId: string;
        recruiterBinding: { platform: "zhipin"; username: string };
        conversationId: string;
        candidateId: string;
      };
    };
  },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<PreviewPatchResponse>> {
  return request(
    { method: "POST", pathname: `tenants/${tenantId}/reply-policy:preview`, body },
    PreviewPatchResponseSchema,
    configInput,
  );
}

export interface EvaluateCaseInput {
  readonly caseId: string;
  readonly role: "primary" | "regression";
  readonly tags?: string[];
  readonly input: {
    readonly candidateMessage: string;
    readonly conversationHistory?: string[];
    readonly defaultWechatId?: string;
    readonly target: {
      readonly platform: "zhipin";
      readonly tenantId: string;
      readonly recruiterBinding: { readonly platform: "zhipin"; readonly username: string };
      readonly conversationId: string;
      readonly candidateId: string;
    };
  };
}

/**
 * POST /tenants/:tenantId/reply-policy:evaluate — 批量回放 base/draft
 */
export async function evaluatePolicyPatch(
  tenantId: string,
  body: {
    basePolicyVersion: string;
    patch: Record<string, unknown>;
    cases: EvaluateCaseInput[];
    judge?: { enabled: boolean; mode?: "pairwise"; rubricVersion?: string };
  },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<EvaluatePatchResponse>> {
  const evaluateTimeoutMs = resolveEvaluateTimeoutMs(configInput?.timeoutMs);
  return request(
    { method: "POST", pathname: `tenants/${tenantId}/reply-policy:evaluate`, body },
    EvaluatePatchResponseSchema,
    configInput,
    evaluateTimeoutMs,
  );
}

/**
 * DELETE /tenants/:tenantId/reply-policy — 删除租户覆盖，回退全局默认
 */
export async function resetPolicy(
  tenantId: string,
  body: { basePolicyVersion: string; reason: string },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<GetPolicyResponse>> {
  return request(
    { method: "DELETE", pathname: `tenants/${tenantId}/reply-policy`, body },
    GetPolicyResponseSchema,
    configInput,
  );
}

/**
 * 预览修改前后话术：POST /tenants/:tenantId/reply-policy:preview
 */
export async function previewPolicyEffect(
  tenantId: string,
  body: {
    basePolicyVersion: string;
    patch: Record<string, unknown>;
    candidateMessage: string;
    conversationHistory?: string[];
    recruiterUsername?: string;
  },
  configInput?: ReplyAuthorityConfig,
): Promise<RasResponse<PreviewPolicyEffectResponse>> {
  const binding = await resolveRecruiterUsername(tenantId, body.recruiterUsername, configInput);
  if (!binding.ok || binding.data === undefined) {
    return {
      ok: false,
      status: binding.status,
      errorMessage: binding.errorMessage ?? "预览失败",
    };
  }

  const result = await previewPolicyPatch(
    tenantId,
    {
      basePolicyVersion: body.basePolicyVersion,
      patch: body.patch,
      input: {
        candidateMessage: body.candidateMessage,
        ...(body.conversationHistory !== undefined
          ? { conversationHistory: body.conversationHistory }
          : {}),
        target: {
          platform: "zhipin",
          tenantId,
          recruiterBinding: {
            platform: "zhipin",
            username: binding.data.username,
          },
          conversationId: "preview-conv",
          candidateId: "preview-candidate",
        },
      },
    },
    configInput,
  );

  if (!result.ok || result.data === undefined) {
    return {
      ok: false,
      status: result.status,
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    };
  }

  const data = result.data;
  return {
    ok: true,
    status: result.status,
    data: PreviewPolicyEffectResponseSchema.parse({
      currentReply: data.base.suggestedReply,
      previewReply: data.draft.suggestedReply,
      stage: data.draft.stage,
      ...(data.base.confidence !== undefined ? { baseConfidence: data.base.confidence } : {}),
      ...(data.draft.confidence !== undefined ? { draftConfidence: data.draft.confidence } : {}),
      diff: data.diff,
    }),
  };
}

export function buildEvaluateTargetInput(input: {
  readonly tenantId: string;
  readonly recruiterUsername: string;
  readonly caseId: string;
  readonly candidateMessage: string;
  readonly conversationHistory?: string[];
  readonly defaultWechatId?: string;
}): EvaluateCaseInput["input"] {
  return {
    candidateMessage: input.candidateMessage,
    ...(input.conversationHistory !== undefined
      ? { conversationHistory: input.conversationHistory }
      : {}),
    ...(input.defaultWechatId !== undefined ? { defaultWechatId: input.defaultWechatId } : {}),
    target: {
      platform: "zhipin",
      tenantId: input.tenantId,
      recruiterBinding: {
        platform: "zhipin",
        username: input.recruiterUsername,
      },
      conversationId: `eval-${input.caseId}`,
      candidateId: `candidate-${input.caseId}`,
    },
  };
}
