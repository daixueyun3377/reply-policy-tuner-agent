# @roll-agent/reply-policy-tuner-agent

## Unreleased

### Patch Changes

- 招聘账号绑定解析新增进程内短 TTL 缓存（`resolveRecruiterUsername`）：一轮迭代内复用同一 `tenantId`+`username` 的解析结果，避免 `preview_policy_effect` / `resolve_recruiter_binding` 重复触发 `POST /resolve-recruiter-binding` 往返与候选串行试探；仅缓存成功结果，失败不缓存。可通过 `REPLY_POLICY_TUNER_BINDING_CACHE_TTL_MS` 配置 TTL（默认 60000，设为 0 禁用）

## 0.1.0

### Minor Changes

- 严格对齐 reply-policy 迭代循环：`validate_patch` → `evaluate_policy_patch` → `preview_policy_effect` → `update_policy`
- 新增 `GET /auth/context` 探测（`diagnostic_status.authContext`）
- 预览迁移至 `POST /reply-policy:preview`（移除 `generate-signed-reply` workaround）
- 新增 `validate_patch`、`evaluate_policy_patch` tools；`preview_policy_effect` 输入改为 `basePolicyVersion` + `patch`
- 策略对比优先使用 API `diff` 真实 before/after
