export type RasErrorContext =
  | "read"
  | "write"
  | "validate"
  | "validatePatch"
  | "reset"
  | "preview"
  | "evaluate"
  | "admin"
  | "auth";

const STATUS_MESSAGES: Record<number, Partial<Record<RasErrorContext, string>>> = {
  400: {
    write: "策略验证失败：配置不合法，请根据提示调整后重试",
    validate: "策略验证失败：配置不合法",
    validatePatch: "补丁验证失败：配置不合法，请根据提示调整后重试",
    preview: "预览请求参数无效，无法生成话术对比",
    evaluate: "评估请求参数无效，无法完成 base/draft 对比",
  },
  401: {
    read: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    write: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    validate: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    validatePatch: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    reset: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    preview: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    evaluate: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    admin: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
    auth: "Token 无效或未配置，请检查 REPLY_AUTHORITY_BEARER_TOKEN",
  },
  403: {
    read: "当前 Token 无权访问该运营人员的策略（缺少 reply-policy:read scope 或 tenantId 未绑定）",
    write: "当前 Token 无权修改该运营人员的策略（缺少 reply-policy:write scope 或 tenantId 不在管辖范围）",
    validate: "当前 Token 无权验证该运营人员的策略（缺少 reply-policy:validate scope）",
    validatePatch: "当前 Token 无权校验该运营人员的策略补丁（缺少 reply-policy:validate scope）",
    reset: "当前 Token 无权重置该运营人员的策略（缺少 reply-policy:write scope）",
    preview: "当前 Token 无权预览该运营人员的话术效果（缺少 reply-policy:preview scope 或 tenant/recruiter 不匹配）",
    evaluate: "当前 Token 无权评估该运营人员的策略补丁（缺少 reply-policy:preview scope 或 tenant/recruiter 不匹配）",
    admin: "当前 Token 不是 Admin Token，无法列出运营人员列表",
    auth: "当前 Token 无法读取授权上下文",
  },
  404: {
    read: "未找到该运营人员的配置",
    preview: "无法解析招聘账号绑定或租户配置不可用，请检查 REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME",
    evaluate: "无法解析招聘账号绑定或租户配置不可用，请检查 REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME",
  },
  409: {
    write: "策略版本冲突：策略刚被其他人修改过，请重新读取最新版本后再试",
    reset: "策略版本冲突：策略刚被其他人修改过，请重新读取最新版本后再试",
    validatePatch: "策略版本冲突：基准策略已变更，请重新 get_policy 后再试",
    preview: "策略版本冲突：基准策略已变更，请重新 get_policy 后再试",
    evaluate: "策略版本冲突：基准策略已变更，请重新 get_policy 后再试",
  },
  429: {
    read: "请求过于频繁，请稍后再试",
    write: "请求过于频繁，请稍后再试",
    preview: "预览请求过于频繁，请稍后再试",
    evaluate: "评估请求过于频繁，请稍后再试",
  },
};

export function translateRasError(input: {
  readonly status: number;
  readonly context: RasErrorContext;
  readonly fallbackMessage?: string | undefined;
}): string {
  const byContext = STATUS_MESSAGES[input.status]?.[input.context];
  if (byContext !== undefined) {
    if (input.status === 400 && input.fallbackMessage !== undefined && input.fallbackMessage.length > 0) {
      return `${byContext}（${input.fallbackMessage}）`;
    }
    return byContext;
  }

  if (input.fallbackMessage !== undefined && input.fallbackMessage.length > 0) {
    return input.fallbackMessage;
  }

  return `请求失败（HTTP ${String(input.status)}）`;
}

export function translateRasHttpError(
  status: number,
  context: RasErrorContext,
  errorMessage?: string | undefined,
): string {
  return translateRasError({
    status,
    context,
    ...(errorMessage !== undefined ? { fallbackMessage: errorMessage } : {}),
  });
}
