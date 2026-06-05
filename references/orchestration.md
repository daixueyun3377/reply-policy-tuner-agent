# 编排层指南

> 入口摘要见同包 `SKILL.md` → **「上层编排 Agent（必读）」**；本文是完整步骤、batch 与 `needs_confirmation` 说明。

上层 Agent（Cursor / OpenClaw / 自定义脚本）在调用 `reply-policy-tuner-agent` 时，除 tool 本身外还需承担三类编排职责：

1. **招聘账号识别** — 通过 `browser-use-agent` 从 BOSS 页面 DOM 读取 `recruiterUsername`，供 preview / evaluate 使用
2. **RSI 评估分支** — 根据 `submit_evaluate_policy_patch` 返回的 `orchestration` 调度回 Propose / Decide+warning / Publish
3. **高危确认** — 处理 `reset_policy` / 高危 `update_policy` 返回的 `needs_confirmation`

---

## RSI Evaluate 编排分支（必读）

`submit_evaluate_policy_patch` 在服务端完成 L1 Hard Gate、L3 Fact Verification、可选 L4 Frozen Rubric Judge 后，tuner **本地推导** `orchestration` 供上层调度（tool 不会自动跳阶段）。

### 字段说明

| 字段 | 含义 |
|------|------|
| `orchestration.action` | `rollback_to_propose` \| `decide_with_warnings` \| `ready_to_publish` |
| `orchestration.publishBlocked` | Hard/Fact 硬阻断为 true 时**禁止** `update_policy` |
| `orchestration.mandatoryPublishReady` | Hard+Fact 通过（与 Judge 无关） |
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
  → 用户选 A) 修订 patch → 回 Propose
  → 用户选 B) 明确仍要发布 → 用户确认后 update_policy（Hard/Fact 已过，Tool 门禁允许）

ELSE IF orchestration.action == "ready_to_publish"
  → 展示建议发布 + 对比表 + 评估结果
  → 用户明确确认保存（「确认写入」等，≠ 本轮修改需求本身）
  → update_policy → 首次 needs_confirmation → 用户点确认 → 带 toolActionApproval 重试落库
```

### 伪代码

```javascript
const ev = await submit_evaluate_policy_patch({ ... });

switch (ev.orchestration.action) {
  case "rollback_to_propose":
    await loopProposeValidateEvaluate(); // 直到 publishBlocked 为 false
    break;
  case "decide_with_warnings":
    if (await userConfirmsDespiteWarnings()) {
      await update_policy({ ... });
    } else {
      await loopProposeValidateEvaluate();
    }
    break;
  case "ready_to_publish":
    if (await userConfirms()) {
      await update_policy({ ... });
    }
    break;
}

// update_policy 前置（编排层 + Tool 门禁）：
// !ev.orchestration.publishBlocked
// && ev.summary.hardRecommendedForPublish === true
// && ev.summary.factRecommendedForPublish === true
// && 同一 tenantId/basePolicyVersion/patch 的 evaluate 记录在 TTL 内
// Judge 告警：recommendedForPublish 可为 false，用户确认后即可写入
```

### 三层安全与发布关系

| 层 | 失败时 | 能否在用户确认后仍发布 |
|----|--------|------------------------|
| L1 Hard Gate | `rollback_to_propose` | **否** |
| L3 Fact Verification（blockingIssues） | `rollback_to_propose` | **否** |
| L3 nonBlockingIssues | 展示 warning，可继续迭代 patch | 视 Hard+Fact 而定 |
| L4 Judge（enabled） | `decide_with_warnings` | **是**（Hard+Fact 已通过；用户确认后可写入） |

Judge 默认启用（`judgeEnabled` 省略或为 `true`）；显式传 `judgeEnabled=false` 时 L4 不调用，`judgeRecommendedForPublish` 视为通过。须 token 具备 `reply-policy:judge` scope。

### validate / preview / evaluate / update 分工（必读）

```text
validate_patch (valid: true)
  → 不向用户要确认，自动继续 preview

preview_policy_effect + format_policy_preview
  → 展示策略修改内容 + 新旧话术对比
  → 停顿，引导用户选择「按这个做评估」还是「继续改策略」
  → 用户选「评估」→ 执行 submit_evaluate_policy_patch
  → 用户选「继续改」→ 回到 propose 重新生成 patch

submit_evaluate_policy_patch
  → 展示 evaluationSummaryMarkdown
  → 仅此后问「是否确认保存？」（仅指 update_policy）
  → 用户明确同意后 update_policy
```

**禁止话术：**「验证已通过，确认写入吗？确认后我会执行 evaluate + update_policy」——会把 evaluate 与落库绑成一次确认，运营无法在看到评估结果后再决策。

### 编排反模式（禁止）

| 反模式 | 正确做法 |
|--------|----------|
| **evaluate 完成后同一轮直接 `update_policy`**（不停顿、不等用户新消息确认） | evaluate 展示结果后**必须停顿**，等用户在**下一轮消息**中明确说「确认保存」才能 `update_policy`。用户说「继续」只授权 evaluate，不授权写入 |
| preview 展示后直接自动跑 evaluate，不停顿等用户确认 | preview 展示策略修改 + 话术对比后**必须停顿**，引导用户选「按这个评估」还是「继续改」；用户确认评估后才跑 evaluate |
| 用户在 preview 后说「评估 / 可以」就一口气执行 evaluate + update_policy | preview 后的确认仅授权 evaluate；evaluate 完成后必须展示结果并重新等落库确认 |
| `validate_patch` 通过后问「确认写入」或「确认后 evaluate + update」 | 说「校验通过，接下来做回放评估」并执行 evaluate；**保存确认只在 evaluate 展示之后** |
| evaluate 超时/失败，仅 preview 成功，仍问「继续写入吗」或 `update_policy` | 说明评估未完成；tool 已自动降级重试，仍失败时不得写入 |
| evaluate 超时后向用户提议「跳过评估直接写入」或问「要不要先保存等会再试」 | evaluate 是 RSI 安全防线，不可跳过。tool 默认 2p+1r；超过 3 条首次前裁切；超时降为 1p+1r 重试一次；两次都超时时如实告知用户服务繁忙、稍后重试。**零容忍跳过** |
| `ready_to_publish` / 评估全过，未展示评估摘要与对比就直接 `update_policy` 或说「已生效」 | 先展示 `evaluationSummaryMarkdown` + `format_policy_preview` → 等运营明确「确认写入」 |
| 用户第二轮改需求（如「其他不要变」），跳过 evaluate 直接写入 | 新 patch → validate → evaluate → 展示 → 确认 → `update_policy` |
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

### 两个选择维度

| 维度 | 来源 | 谁选 |
|------|------|------|
| **tenantId**（改谁的策略） | `diagnostic_status` / Admin 管辖列表 | 修改人（Admin 场景须明确） |
| **recruiterUsername**（用哪个 BOSS 账号做 preview） | 各 `browserInstance` 的 `zhipin_get_username` | 修改人 |

两者不一定 1:1。选定 username 后，tuner 内部会调 `resolve-recruiter-binding` 校验其是否属于当前 `tenantId`；不匹配则 preview / evaluate 失败。

### 推荐流程

```text
1. diagnostic_status（reply-policy-tuner）
   → 确认 token 范围；Admin 时列出可选 tenantId

2. browser_status（browser-use）
   → 读取 roll.config.yaml 声明的 instances[]

3. 对每个 browserInstance（多开 Chrome / 多 profile）：
   open_platform({ browserInstance, platform: "zhipin" })   # lazy start，实例未启动时必需
   zhipin_get_username({ browserInstance })

4. 汇总选择列表，交给修改人确认：
   boss-a → 张三
   boss-b → 李四
   boss-c → 读取失败（未登录或未打开 BOSS）

5. 用户选定 tenantId + recruiterUsername 后，本轮迭代固定传递：
   preview_policy_effect({ tenantId, ..., recruiterUsername })
   submit_evaluate_policy_patch({ tenantId, ..., recruiterUsername })
```

`validate_patch` / `get_policy` / `update_policy` **不需要** `recruiterUsername`。

### 多实例批量示例

使用 `roll run --batch-json` 减少 CLI 启动开销；batch 不创建隐式数据流，编排层须自行解析 stdout 并构造下一步输入。

```json
[
  {
    "agent": "browser-use-agent",
    "tool": "browser_status",
    "input": {},
    "label": "status"
  },
  {
    "agent": "browser-use-agent",
    "tool": "open_platform",
    "input": { "browserInstance": "boss-a", "platform": "zhipin" },
    "label": "boss-a-open"
  },
  {
    "agent": "browser-use-agent",
    "tool": "zhipin_get_username",
    "input": { "browserInstance": "boss-a" },
    "label": "boss-a-user"
  },
  {
    "agent": "browser-use-agent",
    "tool": "open_platform",
    "input": { "browserInstance": "boss-b", "platform": "zhipin" },
    "label": "boss-b-open"
  },
  {
    "agent": "browser-use-agent",
    "tool": "zhipin_get_username",
    "input": { "browserInstance": "boss-b" },
    "label": "boss-b-user"
  }
]
```

### 展示给修改人的模板

```text
请选择要用于预览/评估的 BOSS 招聘账号：

1. boss-a — 张三
2. boss-b — 李四
3. boss-c — 读取失败（未登录或未打开 BOSS）

同时为哪位运营人员修改策略？（Admin 场景）
- demo-tenant-a
- ...
```

### 注意事项

1. **多实例必须显式传 `browserInstance`** — 配置多个 `browser.instances` 时，每次 browser-use 调用都要带路由键；不要依赖 `browser.defaultInstance`。
2. **`browser_status` 不会启动 Chrome** — 首次读 username 前对目标实例调用 `open_platform`。
3. **同一轮迭代固定 username** — preview 与 evaluate 必须使用同一个 `recruiterUsername`。
4. **browser-use 仅在识别账号时需要在线** — 纯读策略 / validate 不依赖 browser-use；preview / evaluate 前确保 `browser-use-agent` 服务可用。

### 选定后的 tuner 调用示例

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

`reset_policy` 与高危 `update_policy` 在 Tool policy=`confirm` 时，首次 `roll run --json` 会返回结构化错误（非 throw 到 CLI 外层时见 `result.code`）。

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
2. UI 展示 `details.summary` + 对话层已列出的影响清单
3. 用户点击确认后，将 `approvalRequest.retryInput` **原样合并**进 tool 输入再次 `roll run`
4. approval **一次性**、默认 300s TTL；过期返回 `action_denied` + `approval_invalid_or_expired`

### 与 roll ask 的区别

| 来源 | 含义 |
|------|------|
| `ask` 路由 `needs_confirmation` | LLM 路由置信度不足 |
| tool policy `needs_confirmation` | 副作用 tool 的人机批准 |

### roll chat 现状

`roll chat` 仍为 experimental 骨架。上层 Agent（Cursor / OpenClaw）应实现确认 UI；参见 monorepo `openclaw-roll-core-skill-template/references/errors.md`。
