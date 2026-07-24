# 编排层指南

> 入口摘要见同包 `SKILL.md` → **「上层编排 Agent（必读）」**；本文是完整步骤、batch 与 `needs_confirmation` 说明。

上层 Agent（Cursor / OpenClaw / 自定义脚本）在调用 `reply-policy-tuner-agent` 时，除 tool 本身外还需承担三类编排职责：

1. **招聘账号识别** — 通过 `browser-use-agent` 从 BOSS 页面 DOM 读取 `recruiterUsername`，供 preview / evaluate 使用
2. **RSI 评估分支** — 根据 `submit_evaluate_policy_patch` 返回的 `orchestration` 调度回 Propose / Decide+warning / Publish
3. **文字确认与工具授权** — 处理 `reset_policy` / `update_policy` 返回的 `needs_confirmation`

---

## RSI Evaluate 编排分支（必读）

`submit_evaluate_policy_patch` 在服务端完成 L1 Hard Gate、L3 Fact Verification、可选 L4 Frozen Rubric Judge 后，tuner **本地推导** `orchestration` 供上层调度（tool 不会自动跳阶段）。

### 字段说明

| 字段 | 含义 |
|------|------|
| `orchestration.action` | `rollback_to_propose` \| `decide_with_warnings` \| `ready_to_publish` |
| `orchestration.publishBlocked` | 任一样本出现新增 Hard，或 primary/related 样本出现新增 Fact 时为 true |
| `orchestration.mandatoryPublishReady` | 本次修改未新增上述阻塞（与 Judge 无关） |
| `orchestration.judgeAdvisoryOnly` | 仅 Judge/回归告警，Hard+Fact 已通过 |
| `orchestration.guidance` | 一句话编排指引 |
| `summary.recommendedForPublish` | 服务端 Hard∧Fact∧Judge 综合；**发布决策以 orchestration 为准** |

### 调度表（与机制页一致）

```text
submit_evaluate_policy_patch 返回后：

IF orchestration.action == "rollback_to_propose"
  → 展示 Hard Gate / Fact blocking 原因
  → 回到 Propose（重新生成 patch）→ validate_patch → evaluate → preview
  → 不得 update_policy

ELSE IF orchestration.action == "decide_with_warnings"
  → 展示 Judge rationale、回归样本对比（warning 语气）
  → 调用 update_policy 获取文字保存确认
  → 提示用户回复「确认保存」或「取消」
  → 取消：不重试；明确确认：原样合并 approvalRequest.retryInput 重试

ELSE IF orchestration.action == "ready_to_publish"
  → 展示建议发布 + 对比表 + 评估结果
  → 直接调用 update_policy → 首次 needs_confirmation（不会写入）
  → 用户回复「确认保存」→ 原样合并 approvalRequest.retryInput 重试落库
```

### 伪代码

```javascript
const ev = await submit_evaluate_policy_patch({ ... });

switch (ev.orchestration.action) {
  case "rollback_to_propose":
    await loopProposeValidateEvaluate(); // 直到 publishBlocked 为 false
    break;
  case "decide_with_warnings":
    await requestUpdatePolicyTextConfirmation(); // 首次只返回 needs_confirmation
    break;
  case "ready_to_publish":
    await requestUpdatePolicyTextConfirmation(); // 用户文字确认后带内部 approval 重试
    break;
}

// update_policy 前置（编排层 + Tool 门禁）：
// !ev.orchestration.publishBlocked
// && 同一 tenantId/basePolicyVersion/patch 的 evaluate 记录在 TTL 内
// 服务端原始 aggregate 可因历史已有问题为 false；发布以 orchestration 为准
// Judge、历史问题或 general 回归事实告警：可以请求文字保存确认
```

### 三层安全与发布关系

| 层 | 失败时 | 能否请求保存确认 |
|----|--------|------------------------|
| L1 Hard Gate（本次 patch 新增） | `rollback_to_propose` | **否** |
| L3 Fact Verification（primary/related 中本次新增） | `rollback_to_propose` | **否** |
| L3 Fact Verification（general 中本次新增） | warning | **是**（Hard 通过时） |
| L3 nonBlockingIssues | 展示 warning，可继续迭代 patch | 视 Hard+Fact 而定 |
| L4 Judge（enabled） | `decide_with_warnings` | **是**（本次无新增 Hard/Fact 阻塞） |

所有样本都采用增量判定：base 与 draft 中都存在的问题属于历史问题，只展示 warning。新增 Hard Gate 违规始终阻断；新增 Fact blocking issue 仅在 primary 或 related regression 中阻断，在 general regression 中只告警。

首次评估固定为 1 条本次目标 primary（复用 preview/用户问题）+ 1～2 条 regression，至少 1 条 `related（修改相关）`；默认生成 1 条 related + 1 条 `general（通用观察）`。general 可覆盖地点、薪资等场景，其新增事实问题只告警。相关性由 Agent 根据用户意图和完整 patch 语义判断，不写关键词正则。

调用 `build_evaluate_cases` 时必须把 `preview_policy_effect.sampleMessage` 原样传入 `previewSampleMessage`；Tool 会拒绝 primary 使用其他候选人问题。

Judge 默认启用（`judgeEnabled` 省略或为 `true`）；显式传 `judgeEnabled=false` 时 L4 不调用，`judgeRecommendedForPublish` 视为通过。须 token 具备 `reply-policy:judge` scope。

### validate / preview / evaluate / update 分工（必读）

```text
get_policy（不传 section，读取完整策略）
  → 内部生成候选 patch
  → 对完整策略 + patch 做语义一致性检查
  → 可解决冲突：内部修正后再展示
  → 不可调整的安全冲突：直接说明限制并给替代方案
  → 禁止先推荐再自我否定

validate_patch (valid: true)
  → 仅表示结构/服务端规则合法，不替代方案语义一致性检查
  → 不向用户要确认，自动继续 preview

preview_policy_effect + format_policy_preview
  → 展示策略修改内容 + 新旧话术对比
  → 停顿，引导用户选择「按这个做评估」还是「继续改策略」
  → 用户选「评估」→ 执行 submit_evaluate_policy_patch
  → 用户选「继续改」→ 回到 propose 重新生成 patch

submit_evaluate_policy_patch
  → 展示 evaluationSummaryMarkdown
  → publishBlocked=false 时调用 update_policy 获取文字保存确认
  → tool 提示用户回复「确认保存」或「取消」，不依赖按钮
```

**禁止话术：**「验证已通过，确认写入吗？确认后我会执行 evaluate + update_policy」——会把 evaluate 与落库绑成一次确认，运营无法在看到评估结果后再决策。

### 编排反模式（禁止）

| 反模式 | 正确做法 |
|--------|----------|
| evaluate 后先增加一次确认，再调用 `update_policy` | 展示 evaluate 结果后同一轮调用 `update_policy`；由返回的 `needs_confirmation` 提示用户回复「确认保存」或「取消」，这就是第二次确认 |
| preview 展示后直接自动跑 evaluate，不停顿等用户确认 | preview 展示策略修改 + 话术对比后**必须停顿**，引导用户选「按这个评估」还是「继续改」；用户确认评估后才跑 evaluate |
| 用户在 preview 后说「确认评估」就执行 evaluate + `update_policy` | preview 后的确认仅授权 evaluate；必须先展示 evaluate 结果，随后才能请求文字保存确认 |
| `validate_patch` 通过后问「确认写入」或「确认后 evaluate + update」 | 说「校验通过，接下来做回放评估」并执行 evaluate；文字保存确认只能在 evaluate 展示之后请求 |
| evaluate 超时/失败，仅 preview 成功，仍问「继续写入吗」或 `update_policy` | 说明评估未完成；tool 已自动降级重试，仍失败时不得写入 |
| evaluate 超时后向用户提议「跳过评估直接写入」或问「要不要先保存等会再试」 | evaluate 是 RSI 安全防线，不可跳过。tool 首次要求 1 条目标 primary + 1～2 条 regression；超时优先保留目标 primary + 1 条 related regression 重试。**零容忍跳过** |
| `ready_to_publish` / 评估全过，未展示评估摘要与对比就调用 `update_policy` 或说「已生效」 | 先展示 `evaluationSummaryMarkdown` + `format_policy_preview`，再请求文字保存确认 |
| 用户第二轮改需求（如「其他不要变」），跳过 evaluate 直接写入 | 新 patch → validate → evaluate → 展示 → 文字保存确认 |
| `publishBlocked === true` 仍 `update_policy`，或问「是否确认写入」 | 回 Propose → validate → evaluate，直至可发布 |
| 用户说「先保存 / 门店后配」当作发布确认 | 硬阻断下仍零写入；口语说明 Fact/证据原因 |
| evaluate 失败后换 patch 直接 `update_policy`（如删 `factGate.forbiddenWhenMissingFacts`） | 对新 patch 完整 validate → evaluate；Tool 按 patch 摘要校验 `mismatch` |
| 用删禁止项、放宽 `factGate.mode` 规避 `contradicted_location` | 扩 Reply Authority 门店证据，或改话术 patch/评估样本后重评 |
| 只读 `evaluationSummaryMarkdown` 分支 | 以 `orchestration.action`、`publishBlocked`、`orchestration.guidance` 为准 |

`submit_evaluate_policy_patch` 在 `publishBlocked === true` 时会在 `orchestration.guidance` 中附带上述约束的摘要，上层须遵守。

---

## 招聘账号识别（recruiterUsername）

### 原则

- `reply-policy-tuner-agent` **不读 DOM**，也**不依赖** browser-use 的代码级绑定
- preview / evaluate 需要 `recruiterUsername`，编排层负责提供；推荐来源是 `browser-use-agent.zhipin_get_username()`
- **不要**依赖 `REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME` 环境变量或内置 fallback 作为生产路径；未显式传入 `recruiterUsername` 时可能误用错误账号

### 目标定位规则

由 Agent 按用户意图区分两条路径，不写关键词正则：

| 用户意图 | tenantId 来源 | 是否让用户选择 |
|----------|---------------|----------------|
| 查看/修改自己的策略 | 当前 BOSS 账号 → `resolve_recruiter_binding` 自动反查 | 否 |
| 明确查看/修改别人的策略 | 当前 Token 的可管理租户列表 | 是，只展示有权限的租户 |

默认流程：

```text
当前 browserInstance
→ open_platform(zhipin)
→ zhipin_get_username
→ resolve_recruiter_binding(recruiterUsername=<当前账号>)，不传 tenantId
→ 返回唯一 tenantId 并校验 Token 权限
→ 本轮 preview/evaluate 固定使用该 tenantId + recruiterUsername
```

禁止默认调用 `diagnostic_status` 后展示租户列表，也禁止遍历多个 BOSS 账号让用户选择。识别结果只作告知；当前账号错误时，让用户切换 BOSS 登录账号后重试。

修改他人策略时：

```text
diagnostic_status
→ 读取 authContext.tenantIds / adminTenantsProbe.tenants
→ 仅展示当前 Token 有权管理的 tenantId（可附 displayName）
→ 用户选择目标租户
→ 获取目标 BOSS 登录账号
→ resolve_recruiter_binding(tenantId=<目标租户>, recruiterUsername=<目标账号>)
→ 校验通过后进入策略修改
```

若目标租户没有可用的 BOSS 登录账号，提示用户登录目标账号后重试；不得改用未绑定的当前账号。

`validate_patch` / `get_policy` / `update_policy` **不需要** `recruiterUsername`。

### 注意事项

1. **默认只读取当前实例** — 不遍历多实例让用户选择；修改他人策略时才按目标租户寻找对应登录账号。
2. **`browser_status` 不会启动 Chrome** — 首次读 username 前对目标实例调用 `open_platform`。
3. **同一轮迭代固定 username** — preview 与 evaluate 必须使用同一个 `recruiterUsername`。
4. **browser-use 仅在识别账号时需要在线** — 纯读策略 / validate 不依赖 browser-use；preview / evaluate 前确保 `browser-use-agent` 服务可用。

### 解析后的 tuner 调用示例

```bash
RECRUITER="张三"
TENANT="demo-tenant-a"
VER=$(roll run reply-policy-tuner-agent get_policy --tenant-id=$TENANT --json | jq -r '.policyVersion')

roll run reply-policy-tuner-agent preview_policy_effect \
  --tenant-id=$TENANT --base-policy-version="$VER" \
  --patch='{"persona":{"questionStyle":"单轮只问一个最关键的问题"}}' \
  --recruiter-username="$RECRUITER" \
  --sample-message="你好，想了解一下这个岗位" --json

roll run reply-policy-tuner-agent submit_evaluate_policy_patch \
  --tenant-id=$TENANT --base-policy-version="$VER" \
  --patch='{"persona":{"questionStyle":"单轮只问一个最关键的问题"}}' \
  --recruiter-username="$RECRUITER" \
  --cases='[{"caseId":"main-001","role":"primary","candidateMessage":"你好，想了解一下这个岗位"}]' \
  --json
```

---

## needs_confirmation 处理（Phase 2）

`reset_policy` 在 Tool policy=`confirm` 时需要确认；`update_policy` 强制至少为 `confirm`（显式 `deny` 仍优先）。首次 `roll run --json` 会返回结构化 `needs_confirmation`，上层须将其转为文字回复确认，不依赖按钮。

### 识别

```json
{
  "ok": false,
  "result": {
    "code": "needs_confirmation",
    "message": "Tool execution requires confirmation by reply-policy-tuner tool policy.",
    "details": {
      "reason": "tool_policy_confirm",
      "tool": "reset_policy",
      "target": "demo-tenant-a",
      "summary": "重置策略：清除全部自定义，回退系统默认",
      "approvalRequest": {
        "id": "<uuid>",
        "expiresAt": "<iso8601>",
        "retryInput": {
          "toolActionApproval": { "id": "<uuid>" }
        }
      }
    }
  }
}
```

### 规则

1. `code === "needs_confirmation"` 时 **不得**自动重试
2. 对话展示 `details.summary` + 已列出的影响清单，并提示回复「确认保存」或「取消」
3. 用户文字明确确认后，将 `approvalRequest.retryInput` **原样合并**进 tool 输入再次 `roll run`；回复取消则停止
4. approval **一次性**、默认 300s TTL；过期返回 `action_denied` + `approval_invalid_or_expired`
5. 回复含糊时只追问，不得写入；语义判断由 Agent 完成，不写关键词正则

### 与 roll ask 的区别

| 来源 | 含义 |
|------|------|
| `ask` 路由 `needs_confirmation` | LLM 路由置信度不足 |
| tool policy `needs_confirmation` | 副作用 tool 的人机批准 |

### roll chat 现状

`roll chat` 仍为 experimental 骨架。上层 Agent（Cursor / OpenClaw）应实现确认 UI；参见 monorepo `openclaw-roll-core-skill-template/references/errors.md`。
