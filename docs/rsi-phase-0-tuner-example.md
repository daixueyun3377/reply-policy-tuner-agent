# RSI Phase 0 Example: reply-policy-tuner-agent

## 1. 目标

本文以 `reply-policy-tuner-agent（回复策略调优智能体）` 为例，说明接入 RSI 前的 Phase 0（概念对齐与数据盘点）需要产出什么。

Phase 0 不要求马上修改代码，也不要求马上生成自优化建议。它的目标是把下面这些事情定义清楚：

```text
要收集什么数据
从哪里收集
由谁上报
如何串联一次完整调优链路
哪些数据需要脱敏
哪些事件可以进入 RSI backend core（RSI 后端核心服务）
哪些候选优化必须回到 tuner 的现有评估和发布门禁
```

最终产出可以作为其他 Agent（智能体）接入 RSI 的参考模板。

## 2. tuner 当前调优主流程

当前 tuner 的标准策略修改流程：

```text
get_policy
→ validate_patch
→ preview_policy_effect
→ build_evaluate_cases
→ submit_evaluate_policy_patch
→ update_policy
```

各步骤含义：

| 步骤 | 作用 | 是否建议进入 RSI 事件链 |
|---|---|---|
| `get_policy` | 读取当前策略和 `policyVersion` | 可选，主要用于记录基准版本 |
| `validate_patch` | 校验策略补丁是否合法，返回 diff 和 warnings | 是 |
| `preview_policy_effect` | 生成修改前后话术对比 | 是 |
| `build_evaluate_cases` | 拼装评估用例，补充系统回归样本 | 是 |
| `submit_evaluate_policy_patch` | 提交 RAS 双路回放和 Judge 评估，返回 RSI 编排动作 | 是 |
| `update_policy` | 在评估通过和用户确认后写入策略 | 是 |

Phase 0 需要确认每一步的数据是否已经由 RAS 存储；如果 RAS 已经存储，优先由 RAS 转发事件给 RSI。只有 RAS 拿不到的数据，才考虑 tuner 或上层编排异步上报。

## 3. 每一步输入、输出与 RSI 事件设计

Phase 0 需要把 tuner 每一步的输入、输出、唯一标识字段和事件记录规则明确下来。下面是建议版本。

| 步骤 | 输入参数 | 输出结果 | 唯一标识字段 | 适合作为 RSI event 的字段 | 成功/失败是否记录 |
|---|---|---|---|---|---|
| `get_policy` | `tenantId`、可选 `section` | `tenantId`、`source`、`policyVersion`、`policy`、`warnings`、`operatorSummary` | `tenantId + policyVersion` | `tenantId`、`policyVersion`、`source`、`warnings`、可选 `section` | 成功可选记录；失败一般只做诊断，不作为优化事件 |
| `validate_patch` | `tenantId`、`basePolicyVersion`、`patch`、可选 `hypothesis` | `valid`、`tenantId`、`basePolicyVersion`、`draftPolicyVersion`、`source`、`warnings`、`diff`、`errors` | `tenantId + basePolicyVersion + patchDigest` | `patchDigest`、`patch`、`hypothesis`、`diff`、`warnings`、`valid`、`errors` | 成功和失败都要记录 |
| `preview_policy_effect` | `tenantId`、`basePolicyVersion`、`patch`、可选 `sampleMessage`、`conversationHistory`、`recruiterUsername` | `sampleMessage`、`currentReply`、`previewReply`、`stage`、`baseConfidence`、`draftConfidence`、`diff` | `tenantId + basePolicyVersion + patchDigest + sampleMessageDigest` | `sampleMessage`、`currentReply`、`previewReply`、`stage`、`confidence`、`diff`、`recruiterUsername` 脱敏值 | 成功和失败都要记录 |
| `build_evaluate_cases` | `tenantId`、`basePolicyVersion`、`patch`、`recruiterUsername`、`cases[]` | `tenantId`、`basePolicyVersion`、`patch`、`cases[]`，含补齐后的 regression cases | `tenantId + basePolicyVersion + patchDigest + caseId` | `caseId`、`role`、`tags`、`candidateMessage` 脱敏摘要、`conversationHistory` 是否存在、`target.tenantId` | 成功记录；失败记录原因 |
| `submit_evaluate_policy_patch` | `tenantId`、`basePolicyVersion`、`patch`、`cases[]` | `tenantId`、`basePolicyVersion`、`draftPolicyVersion`、`summary`、`recommendedForPublish`、`orchestration`、`evaluationSummaryMarkdown`、`warnings` | `tenantId + basePolicyVersion + patchDigest` | `summary`、`orchestration.action`、`publishBlocked`、`warnings`、case 结果、Hard / Fact / Judge 结果 | 成功、失败、超时、硬阻断都要记录 |
| `update_policy` | `tenantId`、`basePolicyVersion`、`patch`、`reason`、可选 `toolActionApproval` | `tenantId`、`source`、`policyVersion`、`policy`、`warnings` | `tenantId + basePolicyVersion + patchDigest + policyVersion` | `reason`、`policyVersion`、`warnings`、是否高危、是否确认、阻断原因 | 成功和失败都要记录 |

推荐总规则：

```text
patchDigest = canonical JSON stringify(patch) 后 sha256
一次完整调优链路 = tenantId + basePolicyVersion + patchDigest
样本级链路 = tenantId + basePolicyVersion + patchDigest + caseId
```

每一步对应的建议事件：

| 步骤 | 建议事件 |
|---|---|
| `get_policy` | `policy_snapshot_read`，可选 |
| `validate_patch` | `policy_patch_validated` / `policy_patch_validation_failed` |
| `preview_policy_effect` | `policy_preview_generated` / `policy_preview_failed` |
| `build_evaluate_cases` | `policy_evaluate_cases_built` / `policy_evaluate_cases_build_failed` |
| `submit_evaluate_policy_patch` | `policy_evaluation_completed` / `policy_evaluation_failed` / `policy_evaluation_timeout` |
| `update_policy` | `policy_update_released` / `policy_update_blocked` / `policy_update_failed` |

关键判断：

- `get_policy` 只是读取基准，不一定进入 RSI 优化事件，但可用于审计和版本追踪。
- `validate_patch` 开始才算一次候选优化链路成形，因为这时已经有 `patch`。
- `preview_policy_effect` 的回复内容是高价值样本，但必须脱敏。
- `submit_evaluate_policy_patch` 是最重要的 RSI 事件来源，因为它包含 Hard / Fact / Judge / orchestration。
- `update_policy` 是发布闭环的终点，必须记录成功、阻断或失败。
- 失败事件也要记录，否则 RSI 只能看到“成功样本”，会丢掉最有价值的优化信号。

## 4. tuner 需要提供的 Phase 0 信息

### 4.1 链路身份字段

用于把 validate / preview / evaluate / update 串成同一条候选优化链路。

| 字段 | 含义 | 来源 | 必填建议 |
|---|---|---|---|
| `tenantId` | 租户或运营人员 ID | tool input / RAS response | 必填 |
| `basePolicyVersion` | 修改前策略版本 | `get_policy` / tool input | 必填 |
| `draftPolicyVersion` | 草稿策略版本 | validate / preview / evaluate response | 建议 |
| `patchDigest` | 策略补丁摘要 | tuner / RAS 计算 | 必填 |
| `patch` | 策略补丁内容 | tool input | 必填，需权限控制 |
| `affectedPolicyPaths` | 受影响策略路径 | diff 推导 | 建议 |
| `recruiterUsername` | BOSS 招聘账号 | preview / evaluate input | 按需，可能敏感 |
| `caseId` | 评估样本 ID | build/evaluate cases | 样本事件必填 |
| `traceId` | 链路追踪 ID | 上层编排或 RSI 生成 | 建议 |
| `operatorId` | 操作人 ID | 上层系统 / auth context | 建议 |
| `createdAt` | 事件时间 | 事件上报方 | 必填 |

推荐链路聚合键：

```text
tenantId + basePolicyVersion + patchDigest
```

推荐事件幂等键：

```text
agentType + tenantId + basePolicyVersion + patchDigest + eventType
```

样本类事件可追加：

```text
+ caseId
```

## 5. tuner 事件目录

Phase 0 需要输出 tuner 的事件目录（Event Catalog）。下面是建议版本。

### 5.1 `policy_patch_validated`

表示策略补丁已完成 RAS 校验。

触发时机：

```text
validate_patch 返回成功或失败后
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "draftPolicyVersion": "draft-v43",
  "patchDigest": "sha256:xxx",
  "patch": {},
  "diff": [],
  "warnings": [],
  "ok": true,
  "errorCode": null,
  "errorMessage": null
}
```

需要确认：

- RAS 是否已经存储 validate 结果、diff、warnings。
- RAS 是否已经计算 patch digest。
- 失败时是否也会记录。

### 5.2 `policy_preview_generated`

表示策略补丁已生成修改前后话术对比。

触发时机：

```text
preview_policy_effect 返回成功或失败后
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "draftPolicyVersion": "draft-v43",
  "patchDigest": "sha256:xxx",
  "recruiterUsername": "masked-or-hashed",
  "currentReply": "修改前回复",
  "previewReply": "修改后回复",
  "stage": "trust_building",
  "baseConfidence": 0.8,
  "draftConfidence": 0.86,
  "diff": [],
  "ok": true
}
```

需要确认：

- 回复内容是否要脱敏后进入 RSI。
- `recruiterUsername` 是否允许明文存储；建议至少支持 hash 或脱敏。
- RAS 是否已经存储 base / draft 回复。

### 5.3 `policy_evaluate_cases_built`

表示本次策略补丁的评估样本已经拼装。

触发时机：

```text
build_evaluate_cases 返回后
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "patchDigest": "sha256:xxx",
  "cases": [
    {
      "caseId": "primary-001",
      "role": "primary",
      "tags": ["tone", "cta"],
      "candidateMessage": "候选人消息，需脱敏",
      "hasConversationHistory": true
    },
    {
      "caseId": "regression-fact-boundary-smoke-001",
      "role": "regression",
      "tags": ["regression", "system", "safety", "fact"]
    }
  ]
}
```

需要确认：

- `candidateMessage` 和 `conversationHistory` 是否入库。
- 是否只存脱敏摘要。
- 系统回归样本是否进入 RSI sample store（样本库）。

### 5.4 `policy_evaluation_completed`

表示 RAS 双路评估已完成。

触发时机：

```text
submit_evaluate_policy_patch 返回成功后
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "draftPolicyVersion": "draft-v43",
  "patchDigest": "sha256:xxx",
  "summary": {
    "hardRecommendedForPublish": true,
    "factRecommendedForPublish": true,
    "judgeRecommendedForPublish": false,
    "recommendedForPublish": false,
    "primaryCases": 2,
    "regressionCases": 1
  },
  "orchestration": {
    "action": "decide_with_warnings",
    "publishBlocked": false,
    "mandatoryPublishReady": true
  },
  "cases": [],
  "warnings": []
}
```

需要确认：

- RAS 是否已存 summary、cases、Hard Gate、Fact Verification、Judge rationale。
- tuner 本地推导的 `orchestration` 是否需要上报给 RSI。
- evaluate 超时降级重试信息是否需要记录。

### 5.5 `policy_evaluation_failed`

表示评估失败或硬阻断，适合进入 Problem（问题归因）生成流程。

触发时机：

```text
submit_evaluate_policy_patch 报错
或 orchestration.publishBlocked === true
或 orchestration.action === "rollback_to_propose"
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "patchDigest": "sha256:xxx",
  "failureType": "hard_gate | fact_blocking | timeout | ras_error | judge_warning",
  "blockingIssues": [],
  "gateViolations": [],
  "judgeRationale": "Judge 说明",
  "affectedPolicyPaths": ["persona.warmth"],
  "publishBlocked": true
}
```

需要确认：

- Fact blocking 是策略问题还是事实证据问题。
- 不允许把“事实证据缺失”默认归因为“放宽 factGate”。
- 哪些失败样本可沉淀为 regression case。

### 5.6 `policy_update_requested`

表示用户已在 evaluate 展示后明确要求保存。

触发时机：

```text
evaluate 完成并展示后，用户独立确认保存
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "patchDigest": "sha256:xxx",
  "reason": "用户确认后的写入原因",
  "confirmedBy": "operator-id",
  "confirmedAt": "2026-06-09T12:00:00Z"
}
```

需要确认：

- 用户确认由上层编排记录，还是 tuner 记录。
- 是否需要保存确认原文。
- `toolActionApproval` 不建议进入 RSI，最多记录是否已确认。

### 5.7 `policy_update_released`

表示策略已成功写入。

触发时机：

```text
update_policy 成功返回后
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "newPolicyVersion": "v43",
  "patchDigest": "sha256:xxx",
  "source": "tenant-file",
  "warnings": [],
  "releasedAt": "2026-06-09T12:00:00Z"
}
```

需要确认：

- RAS 是否已存 update 发布记录。
- 是否能关联发布后真实回复效果。
- 是否支持按 `patchDigest` / `policyVersion` 查询后续指标。

### 5.8 `policy_update_blocked`

表示策略写入被门禁阻止。

触发时机：

```text
update_policy 被 evaluate gate、tool confirmation 或 RAS conflict 阻止
```

建议 payload：

```json
{
  "tenantId": "tenant-a",
  "basePolicyVersion": "v42",
  "patchDigest": "sha256:xxx",
  "blockedReason": "missing_evaluate | expired_evaluate | mismatch | publish_blocked | needs_confirmation | version_conflict",
  "message": "阻断原因"
}
```

需要确认：

- 哪些阻断原因只用于审计。
- 哪些阻断原因需要生成 Problem（问题归因）。

## 6. RAS 已存字段对照表

Phase 0 需要和 RAS 开发者逐项确认。

| 链路 | 字段 | RAS 是否已存 | 是否需要转发 RSI | 备注 |
|---|---|---|---|---|
| validate | patch | 待确认 | 待确认 | 策略补丁 |
| validate | diff | 待确认 | 待确认 | 用于 affected paths |
| validate | warnings | 待确认 | 待确认 | 可进入问题归因 |
| preview | base reply | 待确认 | 待确认 | 需脱敏 |
| preview | draft reply | 待确认 | 待确认 | 需脱敏 |
| preview | stage / confidence | 待确认 | 待确认 | 评估质量参考 |
| evaluate | summary | 待确认 | 待确认 | Hard / Fact / Judge 汇总 |
| evaluate | case results | 待确认 | 待确认 | 样本级结果 |
| evaluate | fact issues | 待确认 | 待确认 | 区分事实证据问题 |
| evaluate | judge rationale | 待确认 | 待确认 | 可生成建议，但不能单独发布 |
| update | policyVersion | 待确认 | 待确认 | 发布后版本 |
| update | reason | 待确认 | 待确认 | 用户确认后的写入原因 |
| update | releasedAt | 待确认 | 待确认 | 发布时间 |
| observation | online reply metrics | 待确认 | 待确认 | 发布后效果 |

## 7. 只有 tuner / 上层编排可能知道的数据

以下数据 RAS 不一定拿得到，需要 Phase 0 确认是否由 tuner 或上层编排异步上报。

| 数据 | 用途 | 是否必须 |
|---|---|---|
| 用户原始自然语言需求 | 解释 patch 来源 | 建议 |
| 上层 Agent 生成 patch 的 reasoning 摘要 | 后续归因和复盘 | 可选 |
| preview 后用户选择“评估”还是“继续改” | 理解候选是否被采纳 | 建议 |
| evaluate 后用户是否确认保存 | 发布审计 | 建议 |
| 用户确认保存的原文 | 审计证据 | 可选，需脱敏 |
| `orchestration.action` 展示后的用户选择 | 判断回滚、警告发布、正常发布 | 建议 |

## 8. 样本和回归用例清单

当前系统内置回归样本：

| caseId | role | tags | 用途 |
|---|---|---|---|
| `regression-fact-boundary-smoke-001` | regression | regression, system, safety, fact, smoke, location, compensation, benefits, qualification | 事实边界和安全 smoke 回归 |
| `regression-greeting-001` | regression | regression, system, greeting | 初次问候回归 |

Phase 0 需要确认：

- 这两个系统样本是否作为 RSI sample store 的初始样本。
- 是否允许把线上失败样本沉淀为 regression case。
- 沉淀规则是什么：人工确认、自动标记、还是先进入候选样本池。
- 样本是否需要脱敏。
- 样本是否要记录 `affectedPolicyPaths`。

## 9. 发布门禁规则

RSI 生成的 Candidate（候选优化）不能直接发布，必须回到 tuner 当前门禁。

发布硬条件：

```text
同一 tenantId
同一 basePolicyVersion
同一 patch / patchDigest
submit_evaluate_policy_patch 已成功
orchestration.publishBlocked === false
summary.hardRecommendedForPublish === true
summary.factRecommendedForPublish === true
用户在 evaluate 展示后独立确认保存
update_policy 通过 tool confirmation
```

禁止：

- evaluate 失败后直接 update。
- preview 后把“可以评估”当成“确认保存”。
- 用新 patch 复用旧 evaluate 记录。
- Fact blocking 时建议放宽 `factGate` 绕过事实问题。
- RSI candidate 自动写入策略。

## 10. 高危策略路径

Phase 0 需要提供高危路径清单，供 RSI candidate 风险标注使用。

建议初始高危路径：

| 策略路径 | 风险 |
|---|---|
| `factGate.mode` | 放宽事实门禁可能增加幻觉 |
| `factGate.forbiddenWhenMissingFacts` | 清空或删除可能允许无证据承诺 |
| `factGate.verifiableClaimTypes` | 清空可能降低事实校验覆盖 |
| `hardConstraints.rules` | 删除硬约束可能绕过安全边界 |
| `outputGuards.blockFirstTurnSpecificFacts` | 放宽首轮事实保护可能增加无证据具体承诺 |
| `outputGuards.maxQuestionsByMode` | 过度放宽可能影响话术质量 |
| `qualificationPolicy` | 资格判断错误可能影响合规和转化 |

## 11. 脱敏和权限要求

Phase 0 必须确认以下规则：

| 数据 | 风险 | 建议 |
|---|---|---|
| `candidateMessage` | 可能包含候选人个人信息 | 脱敏或摘要化 |
| `conversationHistory` | 可能包含隐私、联系方式、薪资期望 | 默认不全文入库，必要时脱敏 |
| `currentReply` / `previewReply` | 可能包含岗位、门店、联系方式 | 脱敏后入库 |
| `recruiterUsername` | 运营账号信息 | hash 或权限隔离 |
| `patch` | 租户策略资产 | tenant 隔离，限制跨租户访问 |
| Judge rationale | 可能引用原始话术 | 检查是否需要脱敏 |

权限要求：

- tenant 级隔离。
- 只有授权用户能看本 tenant 的样本、候选和发布记录。
- RSI report 不跨 tenant 泄漏样本。
- 支持样本删除或匿名化。

## 12. Phase 0 最终产出物

tuner 侧建议交付以下文档或配置。

### 12.1 Event Catalog（事件目录）

包含：

- eventType。
- 触发时机。
- payload schema。
- 幂等键。
- 脱敏规则。
- 是否由 RAS 转发。
- 是否失败也记录。

### 12.2 Payload Schema（载荷结构）

包含每类事件的字段定义，例如：

```text
policy_patch_validated
policy_preview_generated
policy_evaluate_cases_built
policy_evaluation_completed
policy_evaluation_failed
policy_update_requested
policy_update_released
policy_update_blocked
```

### 12.3 Trace / Idempotency 规则

建议：

```text
traceId:
  由上层编排或 RSI core 生成，贯穿一次用户调优会话

patchDigest:
  canonical JSON stringify(patch) 后 sha256

idempotencyKey:
  agentType + tenantId + basePolicyVersion + patchDigest + eventType
```

### 12.4 RAS 字段对照表

确认：

- RAS 已经存什么。
- RAS 能否转发什么。
- 哪些字段需要 tuner / 上层编排补充。

### 12.5 Regression Case 接入清单

确认：

- 初始系统回归样本。
- 线上失败样本沉淀规则。
- 标签规则。
- 脱敏规则。

### 12.6 高危策略路径清单

用于 RSI candidate 风险标注和审批门禁。

### 12.7 脱敏和权限要求

用于指导 RSI backend core 的数据入库和查询权限。

## 13. 策略格式演进信号

tuner 的 RSI 不只服务“策略值自优化”，也要服务“策略格式演进”。两者的区别见 [rsi-policy-format-evolution.md](./rsi-policy-format-evolution.md)：

| 类型 | 优化什么 | 产物 | 是否能直接 `update_policy` |
|---|---|---|---|
| 策略值自优化 | 当前 `ReplyPolicyConfig` schema 里的字段值 | `policy_patch_candidate` | 可以，但必须走 validate / preview / evaluate / 用户确认 |
| 策略格式演进 | `ReplyPolicyConfig` schema 本身 | `schema_change_candidate` / `schema_change_proposal` | 不可以，必须走工程评审、迁移、灰度 |

Phase 0 除了采集 patch、preview、evaluate、update 事件，还需要定义哪些信号可以暴露 schema 层问题。

### 13.1 哪些信号可能说明需要策略格式演进

| 信号 | 说明 | 示例 |
|---|---|---|
| 同类运营需求反复出现 | 运营反复描述同一种策略诉求，但现有字段无法稳定表达 | “首轮别问太多”“先承接再轻问背景” |
| 字段语义过载 | 一个字段被迫承担多个含义 | `stageGoals.*.ctaStrategy` 同时表达推进、追问、转微信策略 |
| 多字段 workaround | Agent 经常要组合多个字段表达一个简单概念 | 同时改 `persona.length`、`persona.questionStyle`、`outputGuards.maxQuestionsByMode` 才能控制追问数量 |
| patch 合法但行为不稳定 | validate 通过，但 preview/evaluate 多次表现不一致 | 策略写了“更亲切”，但回复仍忽冷忽热 |
| RAS 消费缺口 | 策略字段有值，但 RAS prompt builder 消费不稳定或语义不清 | 新旧话术没有体现某个字段的变化 |
| evaluate 盲区 | 现有评估不能覆盖某类字段影响 | 多轮节奏、渠道差异、风险事实表达没有专门样本 |
| 事实问题被误当策略问题 | 经常试图通过改策略绕过事实证据缺失 | 地点、薪资、社保信息缺证据却想放宽 `factGate` |

### 13.2 schema-level problem types

建议 RSI 针对策略格式演进单独定义问题类型：

| problemType | 中文含义 | 说明 |
|---|---|---|
| `schema_gap` | 格式缺口 | 当前 schema 没有字段表达某个稳定需求 |
| `field_overload` | 字段过载 | 一个字段承担了多个业务含义 |
| `field_ambiguity` | 字段歧义 | 字段语义不清，RAS 或 Agent 消费不稳定 |
| `missing_dimension` | 缺少策略维度 | 缺少渠道、对话节奏、风险事实类别等维度 |
| `evaluation_blind_spot` | 评估盲区 | 当前 evaluate case 不覆盖某类 schema 行为 |
| `ras_consumption_gap` | RAS 消费缺口 | 字段存在，但 RAS prompt builder 没有稳定使用 |
| `migration_needed` | 需要迁移 | 历史字段结构已经难以支撑新需求 |

### 13.3 schema_change_candidate payload

策略格式演进候选不生成普通 policy patch，而是生成 schema change candidate（策略格式变更候选）。

建议结构：

```json
{
  "candidateType": "schema_change",
  "target": "reply_policy_schema",
  "problemType": "schema_gap",
  "title": "新增多轮对话节奏策略",
  "evidence": {
    "feedbackCount": 18,
    "failedEvaluateCases": ["case-001", "case-009"],
    "repeatedUserIntents": ["首轮别问太多", "先承接再轻问背景"]
  },
  "currentWorkaround": {
    "paths": [
      "persona.length",
      "persona.questionStyle",
      "stageGoals.trust_building.ctaStrategy"
    ],
    "problem": "字段语义过载，效果不稳定"
  },
  "proposedFields": [
    {
      "path": "conversationPolicies.firstTurnQuestionLimit",
      "type": "number",
      "defaultValue": 1,
      "description": "首轮最多追问问题数"
    }
  ],
  "rasConsumptionPlan": "RAS prompt builder 根据该字段限制首轮追问数量",
  "migrationPlan": "老策略默认 firstTurnQuestionLimit=1",
  "evaluationPlan": "新增首轮问候、候选人冷淡、多问题追问回归样本",
  "risk": "可能降低信息收集速度，需要观察转化和人工接管率"
}
```

### 13.4 schema change 不进入普通策略发布门禁

`schema_change_candidate` 不能进入 `update_policy`。它必须走工程流程：

```text
RSI 收集调优数据
→ optimizer 发现 schema-level problem
→ 生成 schema_change_candidate
→ 人工 / 工程评审
→ 更新 ReplyPolicyConfigSchema
→ 更新 RAS policy loader / prompt builder
→ 更新 validate / preview / evaluate
→ 增加 migration
→ 增加 regression cases
→ 小流量灰度
→ 发布新 schemaVersion
```

禁止：

- 让模型在线新增、删除、重命名策略字段。
- 通过 `update_policy` 写入当前 schema 不认识的新字段。
- 只改 tuner schema，不改 RAS 消费逻辑。
- 只改 RAS prompt，不改 validate / preview / evaluate。
- 没有 migration 就做破坏性格式变更。

### 13.5 Phase 0 需要额外采集的 schema 演进字段

| 字段 | 用途 |
|---|---|
| `userIntentSummary` | 归纳用户原始需求，发现高频重复意图 |
| `generatedPatchPaths` | 记录 Agent 为表达该需求改了哪些字段 |
| `workaroundPaths` | 标记哪些字段是临时绕法 |
| `unstableBehaviorCases` | 记录 patch 合法但 preview/evaluate 不稳定的样本 |
| `rasConsumptionNotes` | 记录疑似 RAS 消费不稳定的字段 |
| `evaluationGapTags` | 标记当前评估覆盖不到的行为 |
| `schemaProblemType` | 标记是否属于 schema-level problem |

这些字段不一定都由 tuner 直接上报。如果 RAS 或上层编排已经能记录，应优先由事实源系统上报。

## 14. 可复用给其他 Agent 的模板

其他 Agent（智能体）接入 RSI Phase 0 时，也可以按以下结构产出：

```text
1. 当前业务主流程
2. 链路身份字段
3. 事件目录
4. RAS / 业务后端已存字段对照表
5. 只有 Agent / 上层编排知道的数据
6. 样本和回归用例清单
7. 发布门禁规则
8. 高危变更路径
9. 脱敏和权限要求
10. 最终产出物
```
