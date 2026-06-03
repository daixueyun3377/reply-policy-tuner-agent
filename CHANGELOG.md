# @roll-agent/reply-policy-tuner-agent

## 0.1.0

### Minor Changes

- 严格对齐 reply-policy 迭代循环：`validate_patch` → `evaluate_policy_patch` → `preview_policy_effect` → `update_policy`
- 新增 `GET /auth/context` 探测（`diagnostic_status.authContext`）
- 预览迁移至 `POST /reply-policy:preview`（移除 `generate-signed-reply` workaround）
- 新增 `validate_patch`、`evaluate_policy_patch` tools；`preview_policy_effect` 输入改为 `basePolicyVersion` + `patch`
- 策略对比优先使用 API `diff` 真实 before/after
