# reply-policy-feedback-collector 设计

`reply-policy-feedback-collector`（回复策略反馈采集器）是 reply-policy RSI（Recursive Self-Improvement，递归式自我改进）闭环里的感知层。它负责接收线上真实反馈事件，沉淀结构化 Failure Case（失败样本），并触发 RAS（Reply Authority Service，回复权威服务）异步生成 Improvement Proposal（优化建议）。

它不负责修改回复策略，也不绕过 `reply-policy-tuner-agent` 的 validate / preview / evaluate / update 发布门禁。

---

## 1. 背景

当前 `reply-policy-tuner-agent` 通过 stdio（标准输入输出）接入，适合 request-response（请求-响应）式工具调用：

- 读取策略
- 校验 Patch（补丁）
- 预览话术
- 提交 evaluate（评估）
- 在门禁通过并获得确认后写入策略

但它不适合直接接收线上失败信号，原因是：

| 特点 | 影响 |
|------|------|
| on-demand（按需启动） | 用户或上层编排调用时才运行，不适合常驻监听 |
| stdio（标准输入输出） | 适合单次工具调用，不适合事件流接入 |
| 无长期事件入口 | 无法稳定接收人工改写、人工接管、候选人负反馈 |
| 本地状态短期有效 | 适合 evaluate gate（评估门禁），不适合长期样本库 |

因此需要一个独立的常驻组件：`reply-policy-feedback-collector`。

---

## 2. 定位与边界

一句话定位：

> 收集 Agent（智能体）回复后的真实反馈事件，判断是否构成策略失败样本，并写入 RAS，供后续生成策略优化建议。

### 范围内

| 能力 | 说明 |
|------|------|
| Event Ingestion（事件接入） | 接收业务系统、运营工作台、smart-reply-agent 推送的反馈事件 |
| Normalization（标准化） | 将不同来源事件转成统一结构 |
| Deduplication（去重） | 避免同一轮对话重复入库 |
| Failure Classification（失败分类） | 判断失败类型，例如事实错误、缺少行动引导 |
| Confidence Scoring（置信度评分） | 区分确定失败与 suspected failure（疑似失败） |
| Privacy Filtering（隐私过滤） | 入库前脱敏手机号、微信号、身份证等敏感信息 |
| RAS Writer（RAS 写入器） | 写入原始事件和结构化失败样本 |
| Proposal Trigger（建议生成触发） | 达到阈值后触发 RAS 异步生成优化建议 |

### 范围外

| 不做什么 | 原因 |
|----------|------|
| 不直接修改 reply-policy（回复策略） | 策略写入必须继续走 `reply-policy-tuner-agent` 门禁 |
| 不直接生成最终 Patch（补丁）并发布 | Proposal（优化建议）需要用户或评审模型审核 |
| 不影响候选人当前回复 | 采集与归因应异步执行，避免影响线上对话 |
| 不替代 RAS 样本库 | 长期数据、聚合和建议生成应放在 RAS |

---

## 3. 总体架构

```text
线上聊天系统 / 运营工作台 / smart-reply-agent
        ↓
reply-policy-feedback-collector
        ↓
RAS 失败样本库 / Proposal 生成任务
        ↓
reply-policy-tuner-agent
        ↓
validate_patch / preview_policy_effect / submit_evaluate_policy_patch / update_policy
```

组件职责：

| 组件 | 职责 |
|------|------|
| 线上聊天系统 / 运营工作台 | 产生人工改写、人工接管、候选人负反馈等事件 |
| smart-reply-agent | 产生 Agent 原始回复、上下文、工具调用结果 |
| reply-policy-feedback-collector | 接收事件、分类、脱敏、去重、写入 RAS |
| RAS | 存储失败样本、聚合问题、异步生成 Proposal（优化建议） |
| reply-policy-tuner-agent | 读取 Proposal，转 Patch，继续走评估与发布门禁 |

---

## 4. 输入事件类型

MVP（Minimum Viable Product，最小可行版本）优先支持三类高置信事件。

| eventType | 中文解释 | 判断方式 | 可信度 |
|-----------|----------|----------|--------|
| `human_rewrite` | 人工改写 | Agent 生成建议回复后，运营实际发送内容发生明显变化 | 高 |
| `takeover_with_reason` | 带原因的人工接管 | 运营点击接管并选择原因 | 中高 |
| `explicit_negative_feedback` | 明确负反馈 | 候选人明确纠错、质疑、不满或要求人工 | 中 |

后续可扩展：

| eventType | 中文解释 | 说明 |
|-----------|----------|------|
| `manual_review` | 人工评审 | 运营或质检主动标记某条回复有问题 |
| `tool_failure` | 工具失败 | 该查岗位、门店、薪资、资格条件时工具失败或结果异常 |
| `conversion_drop` | 转化下降 | 只适合作为指标信号，前期不直接转强失败样本 |
| `no_response` | 候选人无回复 | 归因较弱，前期只做统计，不直接生成 Patch |

### 人工改写判断

上游需要记录两段文本：

```text
agentReply = Agent 原始建议回复
finalReply = 运营实际发送回复
```

建议规则：

| 条件 | 处理 |
|------|------|
| 只改标点、称呼、少量语气词 | 标记为 `minor_edit`（轻微编辑），不入强失败样本 |
| 大幅改写内容、动作或事实表达 | 标记为 `major_rewrite`（明显改写），可入失败样本 |
| 删除薪资、地点、承诺性表述 | 高置信风险样本 |
| 增加留资、邀约、资格判断等关键动作 | 高置信策略样本 |

### 人工接管判断

人工接管不一定代表 Agent 错误，因此需要接管原因。

| takeoverReason | 中文解释 | 是否进入失败样本 |
|----------------|----------|------------------|
| `risk_takeover` | 风险接管 | 是 |
| `business_takeover` | 业务接管 | 视情况 |
| `preference_takeover` | 运营偏好接管 | 默认不入强失败样本 |
| `unknown` | 未知原因 | 只标记为 suspected failure（疑似失败） |

### 候选人负反馈判断

| 类型 | 例子 | 处理 |
|------|------|------|
| 明确纠错 | “不是这个地址”“你说的不对” | 高置信失败样本 |
| 明确不满 | “别发模板”“说重点”“看不懂” | 中高置信失败样本 |
| 要求人工 | “有没有人工”“换个人说” | 中高置信失败样本 |
| 弱负反馈 | “哦”“算了”“不用了” | 只做统计 |

---

## 5. 失败类型设计

第一版 Failure Type（失败类型）控制在 8 个以内，避免分类过细导致样本稀疏。

| failureType | 中文解释 | 可能关联策略路径 |
|-------------|----------|------------------|
| `fact_error` | 事实错误 | `factGate`、外部业务证据源 |
| `cta_missing` | 缺少行动引导 | `stageGoals.*.ctaStrategy` |
| `too_verbose` | 过于啰嗦 | `persona.length`、`outputGuards` |
| `too_many_questions` | 问题太多 | `outputGuards.maxQuestionsByMode` |
| `tone_mismatch` | 语气不合适 | `persona`、`industryVoices` |
| `qualification_miss` | 资格判断缺失 | `qualificationPolicy`、`stageGoals.qualify_candidate` |
| `policy_violation` | 策略违规 | `hardConstraints`、`stageGoals.*.disallowedActions` |
| `unclear_answer` | 表达不清 | `stageGoals`、`persona` |

固定失败类型的作用不是替代 `factGate`（事实门禁），而是把失败样本转成可归因、可统计、可生成 Proposal 的优化任务。

---

## 6. 数据结构

### 6.1 上游反馈事件

```json
{
  "eventId": "evt_001",
  "tenantId": "tenant_001",
  "conversationId": "conv_001",
  "messageId": "msg_123",
  "eventType": "human_rewrite",
  "candidateMessage": "这个岗位还招吗？",
  "conversationHistory": ["你好，想了解一下岗位"],
  "agentReply": "在招的，可以看看。",
  "finalReply": "在招的，你在哪个区？我帮你看下附近门店和班次。",
  "operatorReason": "cta_missing",
  "metadata": {
    "platform": "zhipin",
    "operatorId": "op_001"
  },
  "occurredAt": "2026-06-10T10:00:00+08:00"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `eventId` | 上游事件 ID，用于幂等和审计 |
| `tenantId` | 租户 ID |
| `conversationId` | 会话 ID |
| `messageId` | 关联消息 ID |
| `eventType` | 事件类型 |
| `candidateMessage` | 候选人当前消息 |
| `conversationHistory` | 对话历史，建议控制长度 |
| `agentReply` | Agent 原始回复 |
| `finalReply` | 运营最终发送回复，人工改写场景必填 |
| `operatorReason` | 运营选择的原因，可直接映射 failureType |
| `metadata` | 平台、操作者、渠道等扩展信息 |
| `occurredAt` | 事件发生时间 |

### 6.2 结构化失败样本

```json
{
  "eventId": "evt_001",
  "source": "human_rewrite",
  "failureType": "cta_missing",
  "severity": "medium",
  "confidence": 0.92,
  "candidateMessage": "这个岗位还招吗？",
  "conversationHistory": ["你好，想了解一下岗位"],
  "agentReply": "在招的，可以看看。",
  "expectedBehavior": "应确认岗位在招，并引导候选人提供区域或经验信息",
  "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
  "tags": ["job_consultation", "cta", "conversion"],
  "occurredAt": "2026-06-10T10:00:00+08:00"
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `source` | 样本来源，例如 `human_rewrite` |
| `failureType` | 固定失败类型 |
| `severity` | `high` / `medium` / `low` |
| `confidence` | 置信度，0 到 1 |
| `expectedBehavior` | 期望行为，用于生成 Proposal 和评估样本 |
| `relatedPolicyPaths` | 可能需要修改的策略路径 |
| `tags` | 场景标签，用于筛选和聚合 |

---

## 7. 处理流程

```text
1. 接收事件
2. 校验 tenantId / conversationId / messageId / eventType
3. 进行 Privacy Filtering（隐私过滤）
4. 写入 RAS 原始 failure event（失败事件）
5. 根据 eventType 和显式原因做 Failure Classification（失败分类）
6. 计算 Confidence Score（置信度分数）
7. 映射 relatedPolicyPaths（相关策略路径）
8. Deduplication（去重）
9. 写入 RAS failure case（失败样本）
10. 达到阈值后触发 RAS proposal generation（建议生成）
```

### 处理原则

| 原则 | 说明 |
|------|------|
| Explicit First（显式优先） | 运营选择原因优先于模型猜测 |
| Async First（异步优先） | 采集、分类、建议生成不阻塞线上回复 |
| Confidence Aware（置信度感知） | 低置信样本只做统计，不直接驱动 Patch |
| Audit Ready（可审计） | 每个失败样本都能追溯到原始事件 |
| No Auto Publish（不自动发布） | collector 不直接写策略 |

---

## 8. RAS 需要提供的接口

MVP 至少需要 6 个接口：

| 接口 | 使用方 | 作用 |
|------|--------|------|
| `POST /tenants/:tenantId/reply-policy/failure-events` | collector | 写入原始反馈事件 |
| `POST /tenants/:tenantId/reply-policy/failure-cases` | collector | 写入结构化失败样本 |
| `POST /tenants/:tenantId/reply-policy/success-cases` | collector | 写入高置信成功样本，作为回归保护 |
| `POST /tenants/:tenantId/reply-policy/improvement-proposals:generate` | collector / RAS 定时任务 | 触发异步生成优化建议 |
| `GET /tenants/:tenantId/reply-policy/improvement-proposals` | tuner | 查询优化建议列表 |
| `GET /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId` | tuner | 查询优化建议详情 |

### 8.1 写入原始失败事件

```http
POST /tenants/:tenantId/reply-policy/failure-events
```

请求体：

```json
{
  "eventId": "evt_001",
  "source": "human_rewrite",
  "conversationId": "conv_001",
  "messageId": "msg_123",
  "candidateMessage": "这个岗位还招吗？",
  "conversationHistory": ["你好，想了解一下岗位"],
  "agentReply": "在招的，可以看看。",
  "finalReply": "在招的，你在哪个区？我帮你看下附近门店和班次。",
  "operatorReason": "cta_missing",
  "metadata": {
    "platform": "zhipin",
    "operatorId": "op_001"
  },
  "occurredAt": "2026-06-10T10:00:00+08:00"
}
```

响应体：

```json
{
  "eventId": "evt_001",
  "stored": true,
  "duplicate": false
}
```

要求：

- `eventId` 应支持幂等写入。
- RAS 应保留原始事件，供后续审计和重新分类。
- 敏感信息建议由 collector 先脱敏，RAS 可再做二次校验。

### 8.2 写入结构化失败样本

```http
POST /tenants/:tenantId/reply-policy/failure-cases
```

请求体：

```json
{
  "eventId": "evt_001",
  "source": "human_rewrite",
  "failureType": "cta_missing",
  "severity": "medium",
  "confidence": 0.92,
  "candidateMessage": "这个岗位还招吗？",
  "conversationHistory": ["你好，想了解一下岗位"],
  "agentReply": "在招的，可以看看。",
  "expectedBehavior": "应确认岗位在招，并引导候选人提供区域或经验信息",
  "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
  "tags": ["job_consultation", "cta", "conversion"],
  "occurredAt": "2026-06-10T10:00:00+08:00"
}
```

响应体：

```json
{
  "failureCaseId": "fc_001",
  "stored": true,
  "duplicate": false
}
```

要求：

- 支持按 `eventId`、`conversationId`、`messageId` 去重。
- 支持 `confidence` 和 `severity` 过滤。
- 支持后续被 Proposal 引用为 evidence（证据）。

### 8.2.1 写入结构化成功样本

```http
POST /tenants/:tenantId/reply-policy/success-cases
```

请求体：

```json
{
  "eventId": "evt_success_001",
  "source": "operator_send_without_rewrite",
  "confidence": 0.9,
  "candidateMessage": "这个岗位还招吗？",
  "conversationHistory": ["你好，想了解一下岗位"],
  "agentReply": "在招的，你在哪个区？我帮你看下附近门店和班次。",
  "successSignals": ["operator_no_rewrite", "candidate_positive_reply"],
  "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
  "tags": ["job_consultation", "cta", "success"],
  "occurredAt": "2026-06-10T10:00:00+08:00"
}
```

响应体：

```json
{
  "successCaseId": "sc_001",
  "stored": true,
  "duplicate": false
}
```

要求：

- Success Case 用于回归保护，不直接生成 Proposal。
- 支持按 `eventId`、`conversationId`、`messageId` 去重。
- 支持按 `confidence`、`stage`、`relatedPolicyPaths` 过滤进入 Evaluation Dataset。

### 8.3 触发优化建议生成

```http
POST /tenants/:tenantId/reply-policy/improvement-proposals:generate
```

请求体：

```json
{
  "trigger": "failure_case_threshold",
  "failureTypes": ["cta_missing"],
  "minCases": 5,
  "policyVersion": "v123",
  "timeWindow": {
    "from": "2026-06-01T00:00:00+08:00",
    "to": "2026-06-10T23:59:59+08:00"
  }
}
```

响应体：

```json
{
  "jobId": "job_001",
  "status": "queued"
}
```

要求：

- 必须异步执行，避免 collector 等待模型生成完成。
- 同一租户、同一 failureType、同一 policyVersion 应有节流或合并机制。
- 生成结果应落到 RAS Proposal 表，供 tuner 查询。

### 8.4 查询优化建议列表

```http
GET /tenants/:tenantId/reply-policy/improvement-proposals?status=pending
```

响应体：

```json
{
  "items": [
    {
      "proposalId": "prop_001",
      "status": "pending",
      "failureType": "cta_missing",
      "title": "增强岗位咨询阶段的行动引导",
      "summary": "近 7 天发现 12 条岗位咨询后缺少下一步引导的样本。",
      "evidenceCount": 12,
      "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
      "createdAt": "2026-06-10T10:10:00+08:00"
    }
  ]
}
```

要求：

- 给 `reply-policy-tuner-agent` 读取。
- 列表接口不返回完整证据内容，避免响应过大。
- 支持按 `status`、`failureType`、`policyVersion`、`createdAt` 过滤。

### 8.5 查询优化建议详情

```http
GET /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId
```

响应体：

```json
{
  "proposalId": "prop_001",
  "status": "pending",
  "failureType": "cta_missing",
  "title": "增强岗位咨询阶段的行动引导",
  "rationale": "多个样本中 Agent 只回答是否在招，没有继续引导候选人提供区域、经验或求职意向。",
  "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
  "evidence": [
    {
      "failureCaseId": "fc_001",
      "candidateMessage": "这个岗位还招吗？",
      "agentReply": "在招的，可以看看。",
      "expectedBehavior": "应确认岗位在招，并引导候选人提供区域或经验信息"
    }
  ],
  "suggestedPatch": {
    "stageGoals": {
      "job_consultation": {
        "ctaStrategy": "回答岗位是否在招后，优先引导候选人补充所在区域、经验或可到岗时间，以便推荐附近门店和班次。"
      }
    }
  }
}
```

要求：

- `suggestedPatch` 只是候选 Patch，不能直接写入。
- tuner 必须继续执行 `validate_patch`、`preview_policy_effect`、`build_evaluate_cases`、`submit_evaluate_policy_patch`、`update_policy`。
- evidence（证据）应限制数量，完整样本通过单独查询接口扩展。

---

## 9. 后续增强接口

| 接口 | 用途 |
|------|------|
| `GET /tenants/:tenantId/reply-policy/failure-cases` | 查询失败样本 |
| `PATCH /tenants/:tenantId/reply-policy/failure-cases/:failureCaseId` | 人工修正失败类型、严重程度、期望行为 |
| `GET /tenants/:tenantId/reply-policy/evaluation-datasets` | 查询评估数据集，包含失败样本、成功样本和回归样本 |
| `GET /tenants/:tenantId/reply-policy/improvement-proposal-jobs/:jobId` | 查询异步生成任务状态 |
| `POST /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId/decision` | 记录采纳、忽略、修改原因 |
| `PATCH /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId/status` | 更新 Proposal 生命周期状态 |
| `POST /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId/evaluate-cases` | 将证据样本转成 evaluate cases（评估用例） |
| `POST /tenants/:tenantId/reply-policy/improvement-proposals/:proposalId/publication` | 记录 Proposal 对应的发布版本、评估结果和回滚候选 |

---

## 10. 权限建议

| Scope（权限范围） | 说明 |
|-------------------|------|
| `reply-policy:feedback:write` | 写入失败事件和失败样本 |
| `reply-policy:feedback:read` | 查询失败样本 |
| `reply-policy:proposal:generate` | 触发优化建议生成 |
| `reply-policy:proposal:read` | 查询优化建议 |
| `reply-policy:proposal:write` | 记录建议决策 |

MVP 最少需要：

```text
reply-policy:feedback:write
reply-policy:proposal:generate
reply-policy:proposal:read
```

---

## 11. 与 reply-policy-tuner-agent 的衔接

新增 collector 后，tuner 的职责保持轻量：

```text
list_policy_improvement_proposals
  → get_policy_improvement_proposal
  → create_policy_patch_from_proposal
  → validate_patch
  → preview_policy_effect
  → build_evaluate_cases
  → submit_evaluate_policy_patch
  → update_policy
```

tuner 不需要接收事件流，也不需要保存长期失败样本。它只需要从 RAS 读取 Proposal，并把候选 Patch 接入现有安全发布链路。

对用户来说，流程应表现为简化：

```text
以前：用户自己描述问题 → 上层 Agent 生成 patch → 评估发布
以后：系统给出待处理 Proposal → 用户选择采纳 / 修改 / 忽略 → 评估发布
```

用户不应该感知 collector 的异步采集过程，只看到可审计、带证据的优化建议。

---

## 12. 三方协作改造边界

为了让每个 tenantId 对应的运营或运营团队都能持续优化自己的回复策略，需要把 collector、RAS、tuner、roll-core（整体调度 Agent）的边界拆清楚。核心原则是：collector 负责发现问题，RAS 负责沉淀问题和生成建议，tuner 负责安全改策略，roll-core 负责把用户确认和多 Agent 调度串起来。

### 12.1 reply-policy-tuner-agent 应该改什么

`reply-policy-tuner-agent` 继续保持 stdio（标准输入输出）工具型 Agent 定位，不接收线上异步事件，不保存长期失败样本，不直接做后台任务。

建议新增的能力：

| Tool | 中文解释 | 作用 |
|------|----------|------|
| `list_policy_improvement_proposals` | 列出策略优化建议 | 从 RAS 查询某个 tenantId 下待处理 Proposal（优化建议） |
| `get_policy_improvement_proposal` | 查看策略优化建议详情 | 展示失败类型、证据样本、建议原因、建议补丁 |
| `create_policy_patch_from_proposal` | 从建议生成补丁 | 将 RAS 的 `suggestedPatch` 转成当前 tuner 可评估的 Patch（补丁） |
| `record_proposal_decision` | 记录建议决策 | 记录用户采纳、忽略、修改、暂缓的原因 |

这些能力只放在现有发布链路之前：

```text
Proposal（优化建议）
  → create_policy_patch_from_proposal
  → validate_patch
  → preview_policy_effect
  → build_evaluate_cases
  → submit_evaluate_policy_patch
  → update_policy
```

tuner 必须继续遵守现有约束：

- 不跳过 `validate_patch`（补丁校验）。
- 不跳过 `preview_policy_effect`（话术预览）。
- 不跳过 `submit_evaluate_policy_patch`（评估门禁）。
- 不在用户明确确认保存前调用 `update_policy`（写入策略）。
- 不把 Proposal 当成已发布策略。
- 不接收 `human_rewrite`、`takeover_with_reason`、`explicit_negative_feedback` 这类线上事件流。

### 12.2 RAS 需要改什么

RAS 是长期状态和模型异步任务的承载方，需要新增 feedback（反馈）、failure case（失败样本）、proposal（优化建议）相关能力。

建议新增的数据能力：

| 能力 | 中文解释 | 说明 |
|------|----------|------|
| Failure Event Store | 失败事件库 | 保存 collector 写入的原始反馈事件，支持审计和重放 |
| Failure Case Store | 失败样本库 | 保存脱敏、分类、带置信度的结构化失败样本 |
| Success Case Store | 成功样本库 | 保存运营零改写发送、候选人正向回应等高置信成功样本 |
| Evaluation Dataset | 评估数据集 | 组合失败样本、成功样本、系统回归样本，用于证明候选策略是否真的变好 |
| Proposal Store | 优化建议库 | 保存按 tenantId / policyVersion / failureType 聚合生成的建议 |
| Evidence Link | 证据关联 | 保存 Proposal 与 Failure Case 的关联关系 |
| Proposal Job | 建议生成任务 | 异步生成、重试、查询建议生成状态 |
| Proposal State Machine | 建议状态机 | 管理 Proposal 从生成、待审、采纳、发布到回滚的生命周期 |
| Proposal Decision | 建议决策记录 | 保存用户采纳、忽略、修改、暂缓的反馈 |
| Policy Path Risk Tags | 策略字段风险标签 | 标记不同 policy path 的风险等级，供阶段 4/5 自动化门禁使用 |

建议新增的核心接口见第 8 节，RAS 侧还需要保证：

- 所有数据按 `tenantId` 隔离。
- Proposal 绑定生成时的 `policyVersion`，避免旧策略下的建议误用于新策略。
- `suggestedPatch` 只是候选补丁，不直接写入策略。
- Proposal 必须保留 evidence（证据），让用户知道为什么要改。
- 支持按 `failureType`、`severity`、`confidence`、`createdAt` 聚合。
- 支持阈值触发，例如同一 `failureType` 在 7 天内累计 5 条高置信样本才生成 Proposal。
- 支持 Proposal 过期或关闭，避免长期堆积失效建议。
- 支持成功样本作为回归保护，避免只修失败样本导致成功场景退化。
- 支持 Proposal 生命周期状态，避免忽略、暂缓、已发布建议反复打扰用户。
- 支持按字段风险等级强制门禁，而不是完全依赖模型判断风险。

RAS 生成 Proposal 时，应输出至少这些字段：

```json
{
  "proposalId": "prop_001",
  "tenantId": "tenant_001",
  "policyVersion": "v123",
  "failureType": "cta_missing",
  "title": "增强岗位咨询阶段的行动引导",
  "rationale": "多个样本中 Agent 只回答是否在招，没有继续引导候选人提供区域、经验或求职意向。",
  "evidenceCount": 12,
  "relatedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"],
  "suggestedPatch": {
    "stageGoals": {
      "job_consultation": {
        "ctaStrategy": "回答岗位是否在招后，优先引导候选人补充所在区域、经验或可到岗时间，以便推荐附近门店和班次。"
      }
    }
  }
}
```

### 12.3 roll-core（整体调度 Agent）应该改什么

roll-core（整体调度 Agent）负责把多个 Agent 和用户确认串成一个完整流程。它不需要自己生成策略，也不需要保存失败样本，但需要理解 Proposal 到发布的编排过程。

建议新增的编排能力：

| 能力 | 中文解释 | 说明 |
|------|----------|------|
| Proposal Routing | 建议路由 | 当用户问“有什么可优化”时，调用 tuner 查询 Proposal |
| Tenant Context | 租户上下文 | 在多 tenantId 场景下，让用户确认要优化哪个运营或运营团队 |
| Proposal Decision Flow | 建议决策流程 | 引导用户选择采纳、修改、忽略、暂缓 |
| Patch Evaluation Flow | 补丁评估流程 | 将 Proposal 转 Patch 后继续调 tuner 的 validate / preview / evaluate |
| Human Confirmation | 人工确认 | preview 后确认是否评估，evaluate 后确认是否写入 |
| Error Recovery | 异常恢复 | evaluate 超时、Fact 阻断、Judge 告警时按 orchestration 分支处理 |

推荐调度流程：

```text
1. 用户：查看当前有哪些策略优化建议
2. roll-core → tuner.list_policy_improvement_proposals({ tenantId })
3. 用户选择某条 Proposal
4. roll-core → tuner.get_policy_improvement_proposal({ tenantId, proposalId })
5. roll-core 展示 evidence（证据）、rationale（原因）、suggestedPatch（建议补丁）
6. 用户选择采纳 / 修改 / 忽略 / 暂缓
7. 若采纳或修改：
   roll-core → tuner.create_policy_patch_from_proposal(...)
   roll-core → tuner.validate_patch(...)
   roll-core → tuner.preview_policy_effect(...)
   用户确认评估
   roll-core → tuner.build_evaluate_cases(...)
   roll-core → tuner.submit_evaluate_policy_patch(...)
   用户确认写入
   roll-core → tuner.update_policy(...)
8. roll-core → tuner.record_proposal_decision(...)
```

roll-core 必须遵守现有编排约束：

- 用户选择“采纳建议”只代表同意进入预览和评估，不代表同意写入。
- preview（预览）之后必须停顿，让用户确认是否 evaluate（评估）。
- evaluate（评估）之后必须再次停顿，让用户确认是否 update（写入）。
- `orchestration.action == rollback_to_propose` 时不得写入。
- `decide_with_warnings` 只允许在 Hard / Fact 通过后由用户明确确认写入。
- evaluate 超时或失败时不得建议跳过评估直接保存。

### 12.4 互相如何相辅相成

四个组件形成闭环：

```text
collector：发现真实问题
  ↓
RAS：沉淀样本、聚合问题、生成建议
  ↓
tuner：把建议变成可校验、可评估、可确认发布的策略 Patch
  ↓
roll-core：把用户选择、确认、异常分支和多 Agent 调用串起来
  ↓
线上效果继续产生反馈，进入下一轮 collector
```

它们共同达成的目标：

| 目标 | 说明 |
|------|------|
| Evidence-driven Optimization（证据驱动优化） | 每个策略建议都有真实失败样本支撑 |
| Tenant-level Customization（租户级定制） | 每个 tenantId 可以形成自己的回复策略演进路径 |
| Safe Policy Update（安全策略更新） | 所有写入继续走 tuner 的校验、预览、评估、确认门禁 |
| Continuous Improvement（持续改进） | 线上反馈持续沉淀，周期性推动新 Proposal |
| Operational Clarity（运营可理解） | 用户看到的是“为什么建议改、改哪里、有什么证据、评估是否通过” |

最终产品形态不是让 Agent 随机改 prompt（提示词），而是让每个运营或运营团队基于自己的真实会话反馈，持续、安全、可审计地优化 reply-policy（回复策略）。

---

## 13. Evaluation Layer（评估层）

Evaluation Layer（评估层）是一等概念，可以先由 RAS + tuner 共同实现，不一定独立部署。但设计上必须单独定义，否则“持续变好”没有可验证口径。

### 13.1 什么叫变好

阶段 1 必须先定义 Evaluation Contract（评估契约）。每个 Proposal 进入发布链路前，至少回答：

| 问题 | 口径 |
|------|------|
| 修了什么 | 候选策略在目标 Failure Case（失败样本）上是否改善 |
| 有没有弄坏别的 | 候选策略在 Success Case（成功样本）和 regression cases（回归用例）上是否退化 |
| 是否安全 | Hard Gate、Fact Verification（事实核查）、合规约束是否通过 |
| 是否值得发 | 改善幅度是否足够，风险是否可接受 |

### 13.2 评估数据来源

只收集失败样本不够。阶段 1 就需要同时沉淀成功样本，用于回归保护。

| 数据集 | 中文解释 | 来源 | 用途 |
|--------|----------|------|------|
| Failure Cases | 失败样本 | 人工改写、带原因接管、明确负反馈、evaluate 失败 | 验证候选 Patch 是否修复目标问题 |
| Success Cases | 成功样本 | 运营零改写直接发送、候选人正向回应、无投诉且推进到下一步 | 防止策略改动破坏原本有效话术 |
| System Regression Cases | 系统回归样本 | RAS / tuner 内置事实边界、安全边界、常见场景 | 防止突破底线规则 |
| Holdout Cases | 留出样本 | 未参与 Proposal 生成的近期样本 | 防止过拟合公开样本 |

collector 负责采集成功/失败信号，RAS 负责沉淀和分层，tuner 负责在 evaluate 时使用这些样本。

### 13.3 主指标和护栏指标

建议把指标分为 primary metric（主指标）和 guardrail metrics（护栏指标）。

| 指标 | 中文解释 | 类型 |
|------|----------|------|
| `fix_rate` | 失败样本修复率 | 主指标 |
| `regression_rate` | 成功样本 / 回归样本退化率 | 护栏指标 |
| `semantic_alignment_to_human_rewrite` | 与人工改写的语义一致度 | 主指标 |
| `policy_violation_count` | 策略违规数量 | 护栏指标 |
| `fact_blocking_issue_count` | 事实阻塞问题数量 | 护栏指标 |
| `reply_length_delta` | 回复长度变化 | 观察指标 |
| `question_count_delta` | 提问数量变化 | 观察指标 |

最低发布原则：

```text
fix_rate 有改善，
regression_rate 不显著上升，
policy_violation_count = 0，
fact_blocking_issue_count = 0。
```

### 13.4 baseline comparison（基线对比）

评估不能只看候选策略分数，必须在同一批 case 下比较：

```text
current policy（当前策略） vs draft policy（候选策略）
```

tuner 当前已有 base / draft evaluate 模型，应继续作为发布前核心门禁。RAS 生成 Proposal 时应附带目标样本和回归样本建议，roll-core 负责确保 evaluate 结果展示给用户后再确认写入。

---

## 14. RAS Proposal 生成机制

RAS 的核心难点不是“存样本”，而是从零散反馈中识别系统性策略问题。`human_rewrite`（人工改写）不等于策略错了，必须经过归因过滤、聚类和阈值判断。

### 14.1 归因过滤

改写、接管、负反馈进入 Proposal 前，需要判断是否真的属于策略问题。

| 信号 | 必须保留的信息 | 归因要求 |
|------|----------------|----------|
| `human_rewrite` | `agentReply`、`finalReply`、diff、`rewriteReason` | 只有重复出现且能映射到 policy path 时，才升级为 Proposal 候选 |
| `takeover_with_reason` | 接管原因、接管后人工回复 | 区分风险接管、业务接管、运营偏好 |
| `explicit_negative_feedback` | 候选人原文、上下文、被质疑的 Agent 回复 | 区分事实错误、表达不清、候选人误解 |

建议 RAS 输出 `attribution`：

| attribution | 中文解释 | 后续动作 |
|-------------|----------|----------|
| `policy_value_issue` | 策略值问题 | 可生成 Proposal |
| `model_generation_issue` | 模型生成问题 | 不直接改策略，进入模型表现分析 |
| `missing_context` | 上下文缺失 | 优先改上下文注入或工具链 |
| `missing_business_data` | 业务数据缺失 | 转数据补齐任务 |
| `tool_failure` | 工具失败 | 转工具链修复 |
| `operator_preference` | 运营个人偏好 | 可记录为偏好，不一定改团队策略 |
| `non_policy_issue` | 非策略问题 | 关闭或人工处理 |

### 14.2 聚类维度

“同类问题”不能只按 failureType 判断。建议至少使用这些维度：

| 维度 | 说明 |
|------|------|
| `tenantId` | 运营或运营团队维度 |
| `failureType` | 失败类型 |
| `stage` | 招聘回复阶段，例如岗位咨询、面试邀约 |
| `relatedPolicyPaths` | 可能影响的策略字段 |
| semantic similarity（语义相似度） | 候选人问题、Agent 回复、人工改写意图是否相近 |
| evidence source | 样本来源，例如人工改写、接管、负反馈 |
| risk level | 涉及事实、薪资、合规、品牌边界时提高风险等级 |

Proposal 应该来自一个稳定 cluster（聚类），而不是单条样本。

### 14.3 阈值与置信度

阈值不能只用绝对数。大 tenant 用绝对阈值会过敏，小 tenant 用绝对阈值可能永远触发不了。

建议同时使用：

| 阈值 | 说明 |
|------|------|
| `minEvidenceCount` | 最小样本数，例如 5 条 |
| `minTrafficShare` | 同场景流量占比，例如岗位咨询中 3% 以上触发 |
| `minConfidence` | 平均置信度，例如 0.8 以上 |
| `minTimeSpan` | 时间跨度，例如至少覆盖 2 天，避免单日噪声 |
| `maxRegressionRisk` | 预估影响面不能过大 |

Proposal 必须展示：

```json
{
  "evidenceCount": 12,
  "trafficShare": 0.06,
  "timeSpan": "7d",
  "averageConfidence": 0.86,
  "estimatedAffectedStages": ["job_consultation"],
  "estimatedAffectedPolicyPaths": ["stageGoals.job_consultation.ctaStrategy"]
}
```

### 14.4 小租户冷启动与跨租户共性问题

小 tenant 样本少，单租户聚类可能长期触发不了 Proposal。可以引入跨租户共性问题，但发布仍必须按 tenantId 独立评估。

建议策略：

| 场景 | 处理方式 |
|------|----------|
| 小 tenant 样本不足 | 参考跨租户共性 cluster，生成候选观察项 |
| 多 tenant 出现相同 failureType | 生成 global pattern（全局模式），但不直接写入任何租户 |
| 租户采纳全局建议 | 仍按该 tenantId 的 policyVersion、样本和门禁独立评估 |

---

## 15. 生命周期、异常分支与字段级门禁

### 15.1 Proposal 状态机

Proposal 需要完整生命周期，避免“暂缓后反复提醒”或“忽略后同类问题无限重提”。

建议状态：

| 状态 | 中文解释 | 说明 |
|------|----------|------|
| `generated` | 已生成 | RAS 异步生成完成 |
| `pending_review` | 待审核 | 可展示给用户 |
| `accepted` | 已采纳 | 用户同意进入 Patch / evaluate |
| `modified` | 已修改 | 用户基于建议改了 Patch |
| `ignored` | 已忽略 | 用户认为不需要处理 |
| `deferred` | 已暂缓 | 暂时不处理，需设置再次提醒条件 |
| `evaluated` | 已评估 | 已完成 validate / preview / evaluate |
| `published` | 已发布 | 对应 Patch 已写入策略 |
| `rolled_back` | 已回滚 | 发布后被回滚 |
| `closed` | 已关闭 | 过期、证据不足或不再适用 |

建议规则：

```text
ignored：同 cluster 没有新增显著证据时不重复提醒。
deferred：到期或新增证据超过阈值时再提醒。
published：绑定发布版本和 evaluate 结果。
rolled_back：记录回滚原因，避免立即再次生成相同建议。
```

### 15.2 发布追踪和回滚

阶段 1 即使人工确认发布，也要保留追踪和回滚最小能力。

RAS 应记录：

| 字段 | 说明 |
|------|------|
| `proposalId` | 来源优化建议 |
| `basePolicyVersion` | 发布前策略版本 |
| `publishedPolicyVersion` | 发布后策略版本 |
| `patchDigest` | Patch 摘要 |
| `evidenceCaseIds` | 关联证据样本 |
| `evaluationSummary` | 评估摘要 |
| `publishedBy` | 发布人 |
| `publishedAt` | 发布时间 |
| `rollbackCandidate` | 是否可生成回滚候选 |

tuner 不直接回滚线上策略，仍通过 Proposal / Patch / evaluate / update 门禁执行回滚候选。

### 15.3 roll-core 异常分支

roll-core 负责流程调度，至少要处理这些异常：

| 异常 | 处理方式 |
|------|----------|
| Proposal 的 `policyVersion` 过期 | 重新拉取当前策略，让 RAS 重新生成或重新校验 Patch |
| `validate_patch` 失败 | 展示失败原因，回到修改 Proposal / Patch |
| `preview_policy_effect` 失败 | 停止发布链路，提示缺少账号、上下文或 RAS 服务异常 |
| `submit_evaluate_policy_patch` 超时 | 不允许跳过评估，按 tuner 现有降级与失败规则处理 |
| Hard / Fact 阻断 | 不允许写入，回到 Propose |
| Judge 告警 | 展示 warning，由用户决定修订或继续发布 |
| 并发修改同一策略 | 以最新 `policyVersion` 为准，旧 Proposal 进入 stale（已过期）状态 |
| `update_policy` 需要确认 | 等用户明确确认后带 approval 重试 |

### 15.4 字段级风险标签

阶段 4/5 做自动灰度时，不能依赖模型临时判断风险。风险要绑定到 policy path。

建议 RAS 或 tuner 维护 `policyPathRiskTags`：

| policy path | 风险等级 | 说明 |
|-------------|----------|------|
| `factGate.*` | high | 影响事实核查和兜底 |
| `hardConstraints.*` | high | 影响安全和合规边界 |
| `stageGoals.*.disallowedActions` | high | 影响禁止动作 |
| `qualificationPolicy.*` | medium | 影响候选人资格判断 |
| `stageGoals.*.ctaStrategy` | medium | 影响行动引导 |
| `persona.length` | low | 影响回复长短 |
| `persona.tone` | low | 影响语气风格 |
| `industryVoices.*.styleKeywords` | low | 影响行业表达风格 |

自动化原则：

```text
high：长期人工确认，不自动发布。
medium：可模型评审 + 人工确认，后期可小范围灰度。
low：满足评估和线上监控条件后，后期可进入半自动或自动灰度。
```

---

## 16. RSI 风险治理

RSI（Recursive Self-Improvement，递归式自我改进）的风险治理不能只写原则，必须落到 collector、RAS、tuner、roll-core 四个组件的职责上。下面的矩阵用于指导后续拆分开发任务。

### 16.1 组件责任矩阵

| RSI 问题 | collector | RAS | tuner | roll-core |
|----------|-----------|-----|-------|-----------|
| 优化目标 | 采集改写率、接管率、负反馈率、事实纠错等信号 | Proposal 必须声明 `targetMetric`（目标指标）和 `expectedImpact`（预期影响） | 展示目标，不自行定义业务目标 | 向用户解释优化目标，并确认是否值得采纳 |
| 反馈来源 | 接收 `human_rewrite`、`takeover_with_reason`、`explicit_negative_feedback` | 保存原始 Failure Event（失败事件）和结构化 Failure Case（失败样本） | 不接收事件，只读取 Proposal（优化建议） | 当用户询问优化点时，触发查询 Proposal |
| 样本沉淀 | 脱敏、分类、去重后写入失败样本 | 将高价值样本转成可复用 evaluate cases（评估用例） | 使用 RAS 提供的 evidence / cases 做评估输入 | 选择哪些证据展示给用户，避免信息过载 |
| 问题归因 | 基于显式原因和规则做初步 `failureType`（失败类型）分类 | 聚合同类问题，映射 `relatedPolicyPaths`（相关策略路径） | 不重新归因，只校验候选 Patch 是否可用 | 展示归因结果，让用户确认是否符合业务判断 |
| 候选生成 | 不生成 Patch（补丁） | 生成 Proposal 和 `suggestedPatch`（建议补丁） | 将 Proposal 转成可 validate / evaluate 的 Patch | 组织用户采纳、修改、忽略、暂缓 |
| 结构校验 | 不参与发布校验 | 可在生成前做候选字段白名单检查 | 执行 `validate_patch`、危险 Patch 检测、preview / evaluate 门禁 | 校验失败时引导回到修改或关闭 Proposal |
| 效果评估 | 不参与同步评估 | 提供 evidence、evaluate cases、历史样本 | 执行 base/draft comparison（基线对比）和 submit evaluate | 控制 preview 后确认评估、evaluate 后确认写入 |
| 发布控制 | 不参与写入 | 绑定 Proposal 的 `policyVersion`，记录 Proposal 状态 | 执行 evaluate gate（评估门禁）和 `update_policy` 确认 | 确保用户明确确认后才调用写入 |
| 线上监控 | 持续采集发布后的反馈事件 | 按发布版本聚合效果，发现变差时生成 rollback candidate（回滚候选）或新 Proposal | 可展示 Proposal 评估和发布结果 | 引导用户查看线上效果、选择回滚或再优化 |
| reward hacking（奖励黑客） | 提供真实线上反馈作为约束 | 多维指标、隐藏样本、线上效果一起判断，不只看 Judge 分数 | 不因 Judge 单项通过直接写入，仍走 Hard / Fact / 用户确认 | 展示多维结果，避免用户只看单一分数 |
| policy drift（策略漂移） | 无直接发布职责 | 跟踪租户策略长期偏移和 Proposal 累积方向 | 保留 `hardConstraints`、`factGate` 等 invariant rules（不变量规则）门禁 | 高风险变化要求用户明确确认 |
| 过拟合 | 低置信样本只做统计，不直接驱动 Patch | 最小样本数、holdout（留出样本）、回归样本共同约束 | 限制 Patch 范围，跑 regression cases（回归用例） | 不允许单条样本直接推动发布 |
| 过分散 | 合并重复事件，避免噪声膨胀 | Proposal clustering（建议聚类）、复杂度预算、过期关闭 | 拒绝过大或碎片化 Patch | 引导用户合并相似建议，减少频繁小改 |

### 16.2 优化目标治理

每个 Proposal 不能只说“回复更好”，必须说明优化目标。不同 tenantId 对应不同运营或运营团队，优化目标可以因团队而异，但必须可审计。

| 组件 | 处理方式 |
|------|----------|
| collector | 采集与目标相关的原始信号，例如人工改写率、人工接管率、候选人负反馈率、事实纠错率、转化相关事件 |
| RAS | 生成 Proposal 时写入 `targetMetric`、`baselineValue`、`expectedImpact`、`measurementWindow` |
| tuner | 展示这些目标字段，并在 Patch 进入评估前保持它们与 Proposal 绑定 |
| roll-core | 向用户说明本次建议要改善什么，避免用户把“看起来更自然”误认为一定值得发布 |

示例字段：

```json
{
  "targetMetric": "human_rewrite_rate",
  "baselineValue": 0.28,
  "expectedImpact": "降低岗位咨询阶段的人工改写率",
  "measurementWindow": "7d"
}
```

### 16.3 反馈与样本治理

反馈信号要分强弱。强信号可以进入 Failure Case，弱信号只做指标观察，避免噪声驱动策略变化。

| 组件 | 处理方式 |
|------|----------|
| collector | 只把人工改写、带原因接管、明确负反馈作为 MVP 强信号；候选人沉默、转化下降先只做指标 |
| RAS | 保存原始 Failure Event，同时保存结构化 Failure Case；支持按 `confidence`、`severity` 过滤 |
| tuner | 不直接读取原始事件，只读取 RAS 聚合后的 Proposal 和 evidence |
| roll-core | 给用户展示少量代表性证据，不把所有样本直接堆给用户 |

低置信样本处理规则：

```text
confidence < 0.6 → 只做统计
0.6 <= confidence < 0.8 → 可进入人工复核池
confidence >= 0.8 → 可参与 Proposal 聚合
```

### 16.4 归因与候选生成治理

RSI 不能把所有失败都错误归因到 reply-policy。某些问题可能来自知识库缺数据、工具调用失败、候选人意图识别错误或运营个人偏好。

| 组件 | 处理方式 |
|------|----------|
| collector | 只做初步 `failureType` 分类，并保留原始证据 |
| RAS | 聚合多条样本后判断是否真的适合生成策略 Proposal；必要时标记为 `non_policy_issue`（非策略问题） |
| tuner | 只消费 RAS 给出的 `suggestedPatch`，并通过现有校验和评估验证 |
| roll-core | 当 Proposal 标记为非策略问题时，引导用户处理数据源、工具或运营流程，而不是强行改策略 |

建议 RAS 支持这些归因结果：

| attribution | 中文解释 | 后续动作 |
|-------------|----------|----------|
| `policy_value_issue` | 策略值问题 | 可生成 suggestedPatch |
| `missing_business_data` | 业务数据缺失 | 不生成策略 Patch，转数据补齐任务 |
| `tool_failure` | 工具失败 | 转工具链修复或监控 |
| `operator_preference` | 运营偏好 | 可作为租户偏好记录，不一定改公共策略 |
| `non_policy_issue` | 非策略问题 | 关闭或转人工处理 |

### 16.5 校验、评估与发布治理

候选 Patch 不能因为来自 RAS 就被信任。tuner 是发布前的安全边界。

| 组件 | 处理方式 |
|------|----------|
| collector | 不参与发布链路 |
| RAS | Proposal 绑定 `policyVersion`，并保留 `suggestedPatch`、evidence、生成理由 |
| tuner | 执行 `validate_patch`、`preview_policy_effect`、`submit_evaluate_policy_patch`、`update_policy` 门禁 |
| roll-core | 强制执行 preview 后确认评估、evaluate 后确认写入的两段确认 |

发布前必须满足：

```text
1. Proposal 的 policyVersion 与当前 basePolicyVersion 匹配，或已重新生成。
2. Patch 通过 validate_patch。
3. 用户看过 preview_policy_effect。
4. 用户确认进入 evaluate。
5. submit_evaluate_policy_patch 的 Hard / Fact 门禁通过。
6. 用户在 evaluate 结果之后明确确认写入。
7. update_policy 使用的 patch 与最近一次 evaluate 的 patch 完全一致。
```

baseline comparison（基线对比）要求：

```text
同一批 cases 下比较 current policy（当前策略）与 draft policy（候选策略）。
不能只看候选策略单独分数。
```

### 16.6 线上监控、回滚与持续迭代

策略发布不是 RSI 闭环结束，而是下一轮观察的开始。

| 组件 | 处理方式 |
|------|----------|
| collector | 发布后继续采集人工改写、接管、负反馈等事件，并带上 policyVersion |
| RAS | 按 policyVersion 聚合发布前后指标，判断是否改善或变差 |
| tuner | 可读取历史 Proposal / 发布结果，辅助展示回滚依据 |
| roll-core | 当 RAS 标记变差时，引导用户查看 rollback candidate（回滚候选）或生成新 Proposal |

建议监控指标：

| 指标 | 中文解释 |
|------|----------|
| `human_rewrite_rate` | 人工改写率 |
| `human_takeover_rate` | 人工接管率 |
| `negative_feedback_rate` | 候选人负反馈率 |
| `fact_error_rate` | 事实错误率 |
| `followup_confusion_rate` | 候选人追问不清率 |
| `conversion_signal_rate` | 转化信号率 |

回滚候选不应由 collector 直接执行。RAS 只生成 rollback candidate，tuner 仍然走评估和确认，roll-core 负责让用户做最终决策。

### 16.7 reward hacking、policy drift、过拟合与过分散治理

这些风险需要由四个组件共同兜底。

#### reward hacking（奖励黑客）

风险：系统为了拿高 Judge 分数，生成更长、更客套、更迎合评分规则的回复，但真实效率下降。

| 组件 | 处理方式 |
|------|----------|
| collector | 提供真实线上反馈，避免只依赖离线 Judge |
| RAS | Proposal 评估不能只看 Judge 分数，必须同时看事实错误、改写率、接管率、负反馈 |
| tuner | Judge 通过不等于自动写入，仍然需要 Hard / Fact / 用户确认 |
| roll-core | 展示多维评估结果，不把单一分数包装成“必然更好” |

#### policy drift（策略漂移）

风险：每次小改都看似合理，但长期逐渐偏离品牌、合规和业务边界。

| 组件 | 处理方式 |
|------|----------|
| collector | 不直接参与策略写入 |
| RAS | 跟踪 tenantId 的长期策略变化方向，发现异常偏移时降低 Proposal 优先级或要求人工复核 |
| tuner | 保留 `hardConstraints`、`factGate`、dangerous patch 检测等 invariant rules |
| roll-core | 对高风险字段变化做更明确的用户确认 |

#### 过拟合

风险：策略只修好少数失败样本，但整体表现下降。

| 组件 | 处理方式 |
|------|----------|
| collector | 低置信、单条、弱信号样本不直接进入强优化链路 |
| RAS | 设置最小样本数、holdout（留出样本）、回归集和效果幅度要求 |
| tuner | 限制单次 Patch 大小，必须跑 regression cases |
| roll-core | 不允许用户基于单条样本直接跳过评估发布 |

建议规则：

```text
同一 tenantId + failureType + stage 的高置信样本少于 5 条时，
RAS 不自动生成策略 Patch，只生成观察项或人工复核任务。
```

#### 过分散

风险：每个小问题都生成一个小规则，导致策略碎片化、维护困难、租户策略复杂度失控。

| 组件 | 处理方式 |
|------|----------|
| collector | 合并重复事件，避免同一会话重复入库 |
| RAS | 对相似 Failure Case 做 Proposal clustering，设置策略复杂度预算 |
| tuner | 对过大、过散、字段过多的 Patch 给出警告或拒绝评估 |
| roll-core | 引导用户合并相似 Proposal，不鼓励频繁小改 |

建议复杂度约束：

```text
单个 Proposal 默认只改 1 到 2 个 policy paths。
同一 tenantId 每个周期合并相似 Proposal 后再进入评估。
长期未采纳或证据不足的 Proposal 自动关闭。
```

---

## 17. MVP 范围

第一阶段建议只做：

1. 支持 `human_rewrite`（人工改写）事件。
2. 支持 `takeover_with_reason`（带原因的人工接管）事件。
3. 支持 `explicit_negative_feedback`（明确负反馈）事件。
4. 支持高置信 Success Case（成功样本）沉淀，例如运营零改写直接发送、候选人正向回应。
5. 写入 RAS 原始事件、结构化 Failure Case 和 Success Case。
6. 定义 Evaluation Contract（评估契约）：失败样本修复、成功样本不退化、系统回归不破坏。
7. 当同一 `failureType` 在时间窗口内达到数量、比例和置信度阈值时，触发异步 Proposal 生成。
8. Proposal 附带证据样本数、时间跨度、流量占比、影响面预估。
9. tuner 只读取 Proposal 并接入现有 validate / preview / evaluate / update 流程。
10. 记录 Proposal 生命周期、发布版本、评估结果和 rollback candidate（回滚候选）。

暂不做：

- 候选人沉默自动归因。
- 转化下降直接驱动 Patch。
- collector 直接生成并发布 Patch。
- 低置信样本自动进入回归集。
- 单条人工改写直接生成 Proposal。

---

## 18. 关键结论

`reply-policy-feedback-collector` 负责发现并沉淀问题，RAS 负责存储样本和生成建议，`reply-policy-tuner-agent` 负责安全改策略，roll-core 负责整体调度和用户确认。

```text
collector = 感知层
RAS = 样本库 + 建议生成
tuner = 策略评估与发布门禁
roll-core = 用户确认 + 多 Agent 编排
```

这个拆分可以保留 stdio tuner 的简单性，同时补齐 reply-policy RSI 闭环中最关键的真实反馈入口。
