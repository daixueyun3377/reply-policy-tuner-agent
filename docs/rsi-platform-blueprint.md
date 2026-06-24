# RSI Platform Blueprint

## 1. Executive Summary

RSI（Recursive Self-Improvement，自我优化闭环）在这里不是“让模型自己随意改系统”，而是一套受控的产品优化平台：

```text
真实使用数据
→ 发现问题
→ 归因问题
→ 生成候选优化
→ 评估候选优化
→ 人工或规则确认发布
→ 观察发布后效果
→ 进入下一轮优化
```

当前已有三个独立 Agent（智能体）都需要 RSI：

| Agent（智能体） | 当前能力 | RSI 要优化的对象 |
|---|---|---|
| reply-policy-tuner-agent（回复策略调优智能体） | 修改回复策略，走 RAS validate / preview / evaluate / update（校验 / 预览 / 评估 / 写入）门禁 | 回复策略 JSON、评估样本、策略字段配置 |
| 企业微信生成回复话术 Agent | 根据上下文生成企业微信回复话术 | Prompt（提示词）、模板、话术策略、风格规则、事实表达策略 |
| NL2SQL Agent | 把自然语言问题转换成 SQL | Prompt（提示词）、Few-shot（少样本示例）、Schema Hint（数据结构提示）、Guardrail（安全护栏）、澄清策略 |

推荐建设方式：

```text
公共 RSI 后端核心服务（Backend Core）
  负责事件、样本、问题、候选优化、评估、发布、观察、审计

通用 RSI 优化服务（Optimizer Service）
  负责聚类、归因、候选生成、样本选择、效果分析

业务适配器（Adapter）
  负责把通用优化结果映射成各 Agent 可评估、可发布的业务候选

业务 Agent（智能体）
  负责执行各自的评估与发布门禁
```

一句话定位：

> RSI 平台公共化，优化语义插件化，发布门禁仍归业务 Agent（智能体）。

## 2. RSI 整体样子与终极目标

### 2.1 RSI 是什么

RSI 是一个跨 Agent（智能体）的持续优化系统。它把原本零散的“用户反馈、人工改写、评估失败、线上效果变化”变成可追踪、可归因、可评估、可发布的优化闭环。

它不是单一模型，也不是单个 Agent（智能体）。它是一套平台能力：

- 统一采集业务事件。
- 统一沉淀失败样本和回归样本。
- 统一管理候选优化生命周期。
- 统一追踪发布后效果。
- 通过业务适配器（Adapter）生成不同 Agent（智能体）的候选优化。
- 通过各 Agent（智能体）原有门禁完成评估和发布。

### 2.2 终极目标

终极目标是让产品具备持续学习能力：

```text
用户用得越多
→ 系统越知道哪里不好
→ 越能提出可验证的优化
→ 越能减少人工重复调参
→ 越能提升回复质量、SQL 正确率和业务转化
```

具体目标：

1. **从人工调参变成数据驱动调优**
   - 不再只依赖运营或开发者主观发现问题。
   - 系统能自动发现高频失败模式和优化机会。

2. **从单次修复变成长期优化资产**
   - 每次失败样本可以沉淀为回归样本（Regression Case）。
   - 每次人工改写可以成为优化证据。
   - 每次发布都能关联后续效果。

3. **从单 Agent（智能体）优化变成跨产品优化平台**
   - 三个 Agent（智能体）共用 RSI 生命周期和数据基础设施。
   - 各自保留业务特定优化逻辑和发布门禁。

4. **从不可解释的“模型变好”变成可审计的优化链路**
   - 每个候选优化都有来源、证据、评估、发布和观察记录。
   - 出现回归时能追溯到具体 candidate、版本和样本。

### 2.3 如何提升产品竞争力

RSI 对产品竞争力的提升主要体现在五个方面。

#### 质量提升

- 回复话术越来越贴近业务场景。
- NL2SQL 的可执行率和结果正确率提升。
- 企业微信回复减少生硬、错误、过早 CTA 等问题。
- 高频失败场景自动进入回归样本，避免重复犯错。

#### 交付效率提升

- 运营不用每次从零描述策略问题。
- 开发者不用手动整理大量失败样本。
- 系统自动生成候选优化，人工只需审核和发布。
- 同一套 RSI 平台可以复用到多个 Agent（智能体）。

#### 安全与合规提升

- 候选优化不能绕过各 Agent（智能体）的评估与发布门禁。
- 高风险优化有更严格评估和人工确认。
- 样本脱敏、租户隔离、审计链路统一管理。

#### 数据资产沉淀

- 真实会话、人工改写、评估失败、发布效果都成为可复用资产。
- 回归样本库不断增长。
- 优化建议不再依赖临时上下文，而是基于历史证据链。

#### 护城河形成

- 产品越被使用，优化数据越丰富。
- 优化数据越丰富，Agent（智能体）表现越贴近业务。
- 表现越贴近业务，客户迁移成本越高。

## 3. 架构设计

### 3.1 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                    业务 Agent（Business Agents）               │
│  回复策略调优 Agent   企业微信回复 Agent   NL2SQL Agent        │
└───────────────┬────────────────┬────────────────┬────────────┘
                │                │                │
                ▼                ▼                ▼
┌──────────────────────────────────────────────────────────────┐
│                    事件接入（Event Ingestion）                 │
│            REST API / Webhook / RAS 转发 / SDK                 │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│              RSI 后端核心服务（RSI Backend Core）              │
│  事件  样本  问题归因  候选优化  评估记录                     │
│  发布记录  发布后观察  权限  审计  幂等                       │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                 RSI 优化服务（RSI Optimizer Service）          │
│  聚类  归因  候选生成  样本选择                               │
│  发布后分析  报告生成                                         │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                   业务适配器（Business Adapters）              │
│  回复策略适配器   企业微信回复适配器   NL2SQL 适配器           │
└───────────────┬────────────────┬────────────────┬────────────┘
                │                │                │
                ▼                ▼                ▼
┌──────────────────────────────────────────────────────────────┐
│              评估与发布门禁（Evaluation and Publish Gates）    │
│  RAS 评估/写入   话术质量评估   SQL 执行评估                  │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 核心模块

#### RSI 后端核心服务（RSI Backend Core）

负责事实和生命周期，不负责直接做业务发布。

核心对象：

| 对象 | 作用 |
|---|---|
| Event（事件） | 原始事件，如用户反馈、人工改写、评估失败、发布成功 |
| Sample（样本） | 可复用样本，如失败会话、SQL Case（SQL 用例）、话术改写样本 |
| Problem（问题归因） | 问题归因结果，如语气偏冷、SQL 漏时间条件 |
| Candidate（候选优化） | 候选优化，如 Policy Patch（策略补丁）、Prompt Patch（提示词补丁）、Few-shot（少样本示例） |
| Evaluation（评估记录） | 候选优化的评估结果 |
| Release（发布记录） | 发布记录 |
| Observation（发布后观察） | 发布后效果观察 |

公共字段建议：

```json
{
  "agentType": "reply-policy-tuner | wechat-reply | nl2sql",
  "tenantId": "tenant-a",
  "subjectType": "reply_policy | wechat_prompt | nl2sql_config",
  "subjectId": "default",
  "subjectVersion": "v42",
  "traceId": "trace-xxx",
  "eventId": "event-xxx",
  "idempotencyKey": "tenant:subject:stage:digest",
  "createdAt": "2026-06-09T12:00:00Z"
}
```

#### RSI 优化服务（RSI Optimizer Service）

负责通用智能优化能力：

- 失败样本聚类。
- 问题归因草稿。
- 候选优化草稿。
- 评估样本选择。
- 发布后效果分析。
- 周报 / 月报 / 优化建议报告。

optimizer 不直接发布任何业务变更。它只产生候选建议。

#### 业务适配器（Business Adapters）

业务适配器（Adapter）负责业务语义，避免跨业务污染。

| Adapter | 负责内容 |
|---|---|
| Reply-policy adapter（回复策略适配器） | 将问题映射到 `affectedPolicyPaths`（受影响策略路径），生成 Policy Patch Candidate（策略补丁候选），选择 RAS Evaluate Cases（RAS 评估用例） |
| Wechat-reply adapter（企业微信回复适配器） | 将人工改写和反馈映射到 Prompt / Template / Strategy Candidate（提示词 / 模板 / 策略候选） |
| NL2SQL adapter（NL2SQL 适配器） | 将 SQL 错误映射到 Few-shot（少样本示例）、Schema Hint（数据结构提示）、Prompt Rule（提示词规则）、Guardrail Candidate（安全护栏候选） |

#### 业务 Agent（Business Agents）

Agent（智能体）继续负责业务门禁：

- reply-policy-tuner 继续走 RAS validate / preview / evaluate / update。
- wechat-reply-agent（企业微信回复智能体）走话术质量评估、事实校验、人工确认或灰度发布。
- nl2sql-agent（NL2SQL 智能体）走 SQL 安全检查、执行正确性评估、结果一致性评估。

### 3.3 RAS 与 RSI 的关系

reply-policy 场景中，RAS 是策略和评估主链路。优先推荐：

```text
tuner agent（调优智能体） → RAS
RAS → RSI backend
```

而不是：

```text
tuner agent（调优智能体） → RAS
tuner agent（调优智能体） → RSI backend（RSI 后端）async fire-and-forget（异步上报，不阻塞主流程）
```

原因：

- RAS 更接近策略、评估和发布事实源。
- tuner 是 on-demand stdio agent（按需启动的标准输入输出智能体），不适合做长期数据仓库。
- RAS 可以保证 validate / preview / evaluate / update 的链路一致性。

如果 RAS 暂时不能改造，可以短期使用 tuner 异步上报 RSI backend，但要求：

- 上报失败不阻塞主流程。
- 必须有幂等键。
- 必须脱敏。
- 必须能和 RAS 的版本、patch digest 对齐。

### 3.4 推荐技术栈

#### 后端语言

RAS 已明确使用 Node 开发，因此 RSI backend core 建议使用 TypeScript / Node，并优先沿用 RAS 当前框架、鉴权、日志、配置和部署方式。

推荐选择：

| 模块 | 推荐技术栈 | 说明 |
|---|---|---|
| RSI backend core（RSI 后端核心服务） | TypeScript + Node.js + NestJS 或 Fastify | 若 RAS 已使用 NestJS / Fastify / Express，优先沿用现有框架 |
| RSI worker（RSI 异步任务进程） | TypeScript + BullMQ / Redis Stream | 第一阶段用 Node worker（Node 任务进程）即可，便于复用类型、SDK 和业务 Adapter（适配器） |
| 复杂 optimizer worker（复杂优化任务进程） | Python 可选 | 后续如需要重度 Embedding（向量化）、聚类或 ML Pipeline（机器学习流水线），再单独拆 Python worker（Python 任务进程） |

原则：

- core 要稳定，优先与 RAS 工程体系一致，包括鉴权、租户隔离、日志、trace、错误格式和部署。
- optimizer（优化器）要灵活，第一期可用 TypeScript worker（TypeScript 任务进程）；后续复杂算法再拆 Python worker（Python 任务进程）。
- 不因为 tuner agent 是 TypeScript 就让 tuner 承担长期持久化，RSI backend 仍应作为独立 Node 后端服务。

#### 数据库

推荐 PostgreSQL：

- 结构化字段用于查询和权限。
- JSONB（PostgreSQL 的 JSON 存储类型）存不同 Agent（智能体）的业务 Payload（业务载荷）。
- 可选 pgvector（PostgreSQL 向量检索扩展）存 Embedding（向量）。

核心表：

```text
rsi_events
rsi_samples
rsi_problems
rsi_candidates
rsi_evaluations
rsi_releases
rsi_observations
rsi_audit_logs
```

#### 队列与任务

第一期推荐 Redis + BullMQ（基于 Redis 的 Node.js 任务队列）；如果团队更偏底层流式消费，也可以用 Redis Stream（Redis 流）。已有 Kafka（分布式消息队列）时可复用 Kafka。

用途：

- 异步处理事件。
- 运行 optimizer job。
- 批量聚类和报告生成。
- 避免 RSI 分析阻塞主业务流程。

#### 向量检索

第一期可选，后续需要样本相似检索时引入：

- pgvector（PostgreSQL 向量检索扩展）：轻量，和 PostgreSQL 一体。
- Milvus / Qdrant：当样本量和检索需求明显增长后再考虑。

#### LLM 与评估工具

用途：

- 归因草稿。
- 候选 Patch（补丁）/ Prompt（提示词）/ Few-shot（少样本示例）草稿。
- 话术质量评估。
- 报告生成。

约束：

- LLM 输出不能直接发布。
- LLM 结果必须结构化校验。
- 高风险候选必须经过业务门禁。

#### 观测与治理

需要：

- 日志：traceId（链路追踪 ID）、eventId（事件 ID）、candidateId（候选优化 ID）。
- 指标：事件量、候选生成量、评估通过率、发布后正负效果。
- 审计：谁发布了什么，基于什么证据。
- 权限：tenant 隔离、样本访问控制、脱敏策略。

### 3.5 架构形态

第一期不建议拆复杂微服务。建议：

```text
一个 RSI backend 服务
一个 RSI worker（RSI 异步任务进程）
一个 PostgreSQL
一个 Redis + BullMQ
```

代码内部模块化：

```text
modules/
  events/
  samples/
  problems/
  candidates/
  evaluations/
  releases/
  observations/
  adapters/
    reply-policy/
    wechat-reply/
    nl2sql/
  optimizer/
  governance/
```

后续当吞吐、团队边界、算法迭代复杂度上来后，再拆：

- optimizer service 独立部署。
- adapter worker（适配器任务进程）独立部署。
- report service 独立部署。

## 4. 自我优化什么内容

### 4.1 通用自我优化能力

公共 optimizer 可以做：

1. **失败样本聚类**
   - 把相似失败归为同一类。
   - 发现高频问题。

2. **问题归因**
   - 判断问题是策略问题、Prompt（提示词）问题、事实证据问题、Schema Linking（数据结构关联）问题，还是评估样本问题。

3. **候选优化生成**
   - 生成候选 Patch（补丁）、Prompt Rule（提示词规则）、模板、Few-shot（少样本示例）、Schema Hint（数据结构提示）。

4. **评估样本选择**
   - 根据候选优化影响面选择 primary cases。
   - 自动补 Regression Cases（回归样本）。

5. **发布后效果分析**
   - 比较发布前后指标。
   - 发现收益、回归或无效优化。

6. **优化报告**
   - 高频问题。
   - 通过率低的候选类型。
   - 容易引入回归的字段或 Prompt（提示词）。
   - 建议优先处理的问题。

### 4.2 reply-policy-tuner 优化内容

优化对象：

- `persona`：语气、长度、共情方式、称呼方式。
- `stageGoals`：阶段目标、CTA 策略、禁用动作。
- `industryVoices`：行业术语、风格关键词、禁用话术。
- `factGate`：事实门禁模式、缺事实时处理方式。
- `qualificationPolicy`：资格判断和失败策略。
- `outputGuards`：问题数量、首轮具体事实保护、审计短语。
- Regression Cases（回归样本）：从失败样本沉淀评估样本。

候选优化：

```json
{
  "candidateType": "policy_patch",
  "payload": {
    "patch": {
      "persona": {
        "warmth": "更亲切，先承接候选人意图"
      }
    },
    "affectedPolicyPaths": ["persona.warmth"],
    "evidenceCaseIds": ["case-001", "case-009"]
  }
}
```

发布门禁：

```text
validate_patch
→ preview_policy_effect
→ submit_evaluate_policy_patch
→ 用户确认
→ update_policy
```

### 4.3 企业微信回复 Agent（智能体）优化内容

优化对象：

- 话术生成 Prompt（提示词）。
- 回复模板。
- 首轮承接策略。
- 追问策略。
- CTA 时机。
- 事实表达策略。
- 风格偏好。
- 人工改写样本。

常见问题：

- 太生硬。
- 过早邀约。
- 问题太多。
- 没有承接候选人情绪。
- 事实信息表达不稳。
- 不符合企业微信语境。

候选优化：

```json
{
  "candidateType": "prompt_patch",
  "payload": {
    "instruction": "首轮不要直接邀约，先承接候选人意图，再轻量追问一个背景问题。",
    "evidenceRewriteIds": ["rewrite-102", "rewrite-118"]
  }
}
```

评估方式：

- 人工改写距离。
- 话术质量 Judge。
- 事实校验。
- 用户反馈。
- 人工接管率。
- 转化指标。

### 4.4 NL2SQL Agent（智能体）优化内容

优化对象：

- SQL 生成 Prompt（提示词）。
- Few-shot（少样本示例）。
- Schema Hint（数据结构提示）。
- Metric Definition（指标定义）。
- Join Rule（关联规则）。
- 时间范围推断规则。
- 安全 Guardrail（安全护栏）。
- 澄清问题策略。

常见问题：

- 漏时间条件。
- 指标口径错误。
- join 错误。
- 表或字段映射错误。
- 生成危险 SQL。
- 问题含糊但没有追问。
- SQL 可执行但结果不对。

候选优化：

```json
{
  "candidateType": "few_shot_case",
  "payload": {
    "question": "本月新增客户数是多少？",
    "sql": "select count(*) from customers where created_at >= date_trunc('month', current_date)",
    "problemType": "missing_time_filter"
  }
}
```

评估方式：

- SQL 是否可执行。
- 结果是否与 Expected Result（预期结果）一致。
- 是否只读安全。
- 是否符合指标口径。
- 是否需要澄清。
- Regression Suite（回归测试套件）是否通过。

### 4.5 候选优化（Candidate）生命周期

统一生命周期：

```text
proposed（已提出）
→ ready_for_evaluation（待评估）
→ evaluating（评估中）
→ evaluated_passed / evaluated_failed（评估通过 / 评估失败）
→ accepted / rejected（已接受 / 已拒绝）
→ released（已发布）
→ observed_positive / observed_negative / rollback_suggested（观察为正向 / 观察为负向 / 建议回滚）
```

关键原则：

- Candidate（候选优化）是建议，不是发布。
- Candidate（候选优化）必须能追溯证据。
- Candidate（候选优化）必须经过对应 Agent（智能体）的评估。
- Release（发布记录）必须记录版本、操作者、发布时间和回滚方式。

## 5. 风险与防护

### 5.1 风险总表

| 风险 | 说明 | 防护策略 |
|---|---|---|
| 过拟合 | 候选优化只对触发样本有效，泛化差 | 训练/评估样本分离、固定回归集、灰度、发布后观察 |
| 数据污染 | 错误反馈或低质量人工改写进入优化链路 | 样本来源标记、置信度、人工审核、异常样本过滤 |
| 奖励黑客 | Optimizer（优化器）学会迎合 Judge（评审模型），而不是真实质量 | Frozen Judge（冻结评审模型）、线上指标、多目标评估、人工抽检 |
| 安全旁路 | 候选优化放宽事实门禁、SQL Guardrail（SQL 安全护栏）或硬约束 | 高危字段检测、强门禁、禁止自动发布 |
| 分布漂移 | 历史样本不代表当前业务 | 时间衰减、近期样本加权、周期性重评 |
| 局部优化伤害全局 | 某类样本变好，其他场景变差 | 跨场景 Regression（回归测试）、影响面分析、小步发布 |
| 归因错误 | 把事实库缺失误判为策略问题 | 区分 Policy Issue（策略问题）与 Data / Evidence Issue（数据 / 证据问题） |
| 重复优化 | 同类问题反复生成相似 Candidate（候选优化） | Cluster（问题簇）合并、Candidate（候选优化）去重、Patch Digest（补丁摘要） |
| 指标误归因 | 发布后指标变化不是 Candidate（候选优化）导致 | 灰度、对照组、置信度、分层分析 |
| 隐私泄露 | 样本中包含用户、候选人、企业敏感信息 | 脱敏、租户隔离、权限、保留周期 |
| 成本失控 | 大量 LLM（大语言模型）分析、评估、Embedding（向量化）消耗过高 | 分层采样、批处理、缓存、预算控制 |
| 状态不一致 | RAS、RSI、Agent（智能体）事件对不上 | traceId（链路追踪 ID）、eventId（事件 ID）、幂等键、版本号 |
| 自动化过度 | 系统绕过人工和门禁直接发布 | Candidate-only（只生成候选、不自动发布）原则，发布回业务 Agent（智能体） |
| Schema 膨胀 | 每个问题都新增字段 | 第一层优先，第二层走 Schema Proposal（格式变更提案） |
| 跨业务污染 | NL2SQL 的优化逻辑影响 reply-policy | 公共 Lifecycle（生命周期），业务 Adapter（适配器）分离 |
| 回滚困难 | 发布后变差但找不到来源 | Release（发布记录）、Affected Paths（受影响路径）、Rollback Plan（回滚方案） |

### 5.2 防过拟合机制

必须组合使用：

1. **样本隔离**
   - 用一批样本生成 Candidate（候选优化）。
   - 用另一批样本评估 Candidate（候选优化）。

2. **固定回归集**
   - 每个 Agent（智能体）都要维护 Frozen Regression Suite（冻结回归测试套件）。
   - 候选优化必须不能破坏核心历史场景。

3. **影响面评估**
   - 候选 Patch（补丁）改了哪些字段。
   - 影响哪些场景。
   - 对应选择哪些 Regression Cases（回归样本）。

4. **小步优化**
   - 一次 Candidate（候选优化）尽量只改少量对象。
   - 避免多个不相关优化混在一起。

5. **灰度发布**
   - 不直接全量。
   - 先按 tenant、场景或流量比例灰度。

6. **发布后观察**
   - 看真实指标，而不是只看离线评估。
   - 效果变差时自动标记 Candidate（候选优化）风险。

### 5.3 防奖励黑客

措施：

- Frozen Judge（冻结评审模型）和 Experimental Judge（实验评审模型）分离。
- Judge（评审模型）不能是唯一指标。
- 关键发布需要真实指标或人工抽检。
- Judge Rubric（评审规则）变更也要版本化。
- Optimizer（优化器）不能直接修改 Judge（评审模型）以提升通过率。

### 5.4 防安全旁路

reply-policy：

- 不允许通过删除 `factGate.forbiddenWhenMissingFacts` 解决事实阻断。
- 不允许弱化 `hardConstraints` 来通过 evaluate。
- 高危 Patch（补丁）必须强提示和人工确认。

nl2sql：

- 不允许放宽只读 SQL Guardrail（SQL 安全护栏）。
- 不允许生成 DDL（数据定义语句）/ DML（数据操作语句）/ Destructive SQL（破坏性 SQL）。
- 不允许绕过权限查询未授权表。

wechat-reply：

- 不允许为了转化率编造事实。
- 不允许绕过事实校验承诺薪资、地点、福利。
- 不允许生成不合规或过度营销话术。

### 5.5 隐私与权限

必须设计：

- Tenant（租户）级隔离。
- 样本脱敏。
- 敏感字段屏蔽。
- 样本保留周期。
- 访问审计。
- 最小权限 API Token（接口令牌）。
- 支持删除或匿名化样本。

### 5.6 一致性与幂等

每个事件必须有：

- `eventId`（事件 ID）
- `traceId`（链路追踪 ID）
- `idempotencyKey`（幂等键）
- `agentType`（Agent 类型）
- `tenantId`（租户 ID）
- `subjectType`（优化对象类型）
- `subjectVersion`（优化对象版本）
- `source`（事件来源）
- `createdAt`（创建时间）

幂等键建议：

```text
tenantId + agentType + subjectType + subjectVersion + eventType + contentDigest
```

## 6. 任务拆分与路线图

### Phase 0：概念对齐与数据盘点

目标：确认三类 Agent（智能体）的 RSI 范围、数据来源、发布门禁和 RAS 当前存储能力。

任务：

- 明确三个 Agent（智能体）的 `agentType`（Agent 类型）、`subjectType`（优化对象类型）、候选优化类型。
- 和 RAS 开发者确认 validate / preview / evaluate / update 是否已存储。
- 盘点企业微信回复和 NL2SQL 的事件来源。
- 确定隐私、权限、租户隔离要求。
- 确定第一期是否由 RAS 转发事件，还是由 Agent（智能体）异步上报。

验收：

- 输出数据盘点表。
- 输出三类 Agent（智能体）的接入边界。
- 输出 MVP 事件清单。

### Phase 1：RSI backend core MVP

目标：建立公共事实链路和候选优化生命周期。

任务：

- 建表：Events（事件）、Samples（样本）、Problems（问题归因）、Candidates（候选优化）、Evaluations（评估记录）、Releases（发布记录）、Observations（发布后观察）。
- 实现 REST API。
- 实现幂等写入。
- 实现基础查询。
- 实现 Tenant（租户）权限和审计。
- 实现 Worker（异步任务进程）任务队列。

验收：

- 能写入和查询事件。
- 能创建 Candidate（候选优化）。
- 能记录 Evaluation（评估记录）、Release（发布记录）、Observation（发布后观察）。
- 重复上报不会产生重复数据。

### Phase 2：接入 reply-policy-tuner / RAS

目标：用 reply-policy 打通第一条 RSI 闭环。

任务：

- RAS 或 tuner 上报 Validate Event（校验事件）。
- 上报 Preview Event（预览事件）。
- 上报 Evaluate Event（评估事件）。
- 上报 Update / Release Event（写入 / 发布事件）。
- 记录 Affected Policy Paths（受影响策略路径）。
- 支持从 Evaluate（评估）失败生成 Problem（问题归因）。
- 支持生成 Policy Patch Candidate（策略补丁候选）。
- tuner 新增或规划“查看优化建议”入口。

验收：

```text
Evaluate（评估）失败
→ RSI 记录 Problem（问题归因）
→ 生成 Candidate Patch（候选补丁）
→ tuner 拉取 Candidate（候选优化）
→ 走 validate / preview / evaluate
→ 用户确认 Update（写入）
→ RSI 记录 Release（发布记录）
```

### Phase 3：优化服务 v1（Optimizer Service v1）

目标：实现第一版通用智能优化能力。

任务：

- 实现规则型归因。
- 接入 LLM（大语言模型）生成 Problem Report（问题报告）草稿。
- 实现失败样本聚类。
- 实现 Candidate（候选优化）生成草稿。
- 实现 Regression Case（回归样本）推荐。
- 实现发布后效果分析报告。

验收：

- 能从一批失败样本生成 Problem Clusters（问题簇）。
- 能输出结构化 Problem Report（问题报告）。
- 能生成候选优化，但不会自动发布。
- 能生成周报或优化建议报告。

### Phase 4：接入 NL2SQL Agent（智能体）

目标：复用 RSI 平台优化 NL2SQL。

任务：

- 上报自然语言问题、生成 SQL、执行结果、错误类型。
- 沉淀 SQL Failure Samples（SQL 失败样本）。
- 定义 NL2SQL Problem Types（NL2SQL 问题类型）。
- 生成 Few-shot（少样本示例）/ Schema Hint（数据结构提示）/ Prompt Rule Candidate（提示词规则候选）。
- 接入 SQL Regression Suite（SQL 回归测试套件）。

验收：

- SQL 失败样本能进入 RSI。
- 高频 SQL 错误能被归因。
- 能生成 Few-shot（少样本示例）或 Schema Hint Candidate（数据结构提示候选）。
- Candidate（候选优化）能通过 NL2SQL 自己的执行评估。

### Phase 5：接入企业微信回复 Agent（智能体）

目标：复用 RSI 平台优化企业微信回复话术。

任务：

- 上报模型回复、人工改写、用户反馈、人工接管。
- 定义 Wechat-reply Problem Types（企业微信回复问题类型）。
- 生成 Prompt / Template / Strategy Candidate（提示词 / 模板 / 策略候选）。
- 接入话术质量评估和事实校验。
- 设计人工评分和抽检流程。

验收：

- 人工改写样本能进入 RSI。
- 高频话术问题能聚类。
- 能生成 Prompt / Template Candidate（提示词 / 模板候选）。
- Candidate（候选优化）能通过质量评估和人工确认。

### Phase 6：治理、灰度与平台化

目标：从 MVP 进入可运营平台。

任务：

- Dashboard（仪表盘）：问题趋势、Candidate（候选优化）状态、发布效果。
- 灰度能力：按 Tenant（租户）/ 场景 / 流量。
- 回滚能力：按 Release（发布记录）追溯。
- 成本治理：LLM 调用预算、缓存、批处理。
- 安全治理：高危候选识别、权限审批。
- 报告：周报、月报、重点优化建议。

验收：

- 团队可以用 Dashboard（仪表盘）跟踪 RSI 效果。
- 高风险 Candidate（候选优化）有明确审批。
- 发布后负向效果能触发回滚建议。

## 7. 推荐优先级

建议优先顺序：

1. **先做公共 RSI 后端核心服务（Backend Core）**
   - 没有事实链路，后面的智能优化都会变成临时 Prompt（提示词）。

2. **先接 reply-policy-tuner**
   - 它已有 validate / preview / evaluate / update，是最容易闭环的样板。

3. **再做优化器 v1（Optimizer v1）**
   - 先规则 + LLM 辅助，不追求全自动。

4. **再接 NL2SQL**
   - 评估客观，适合沉淀 Regression（回归样本）。

5. **最后接企业微信回复**
   - 话术主观性强，评估体系要更谨慎。

6. **最后再增强自动化**
   - 在证据链、门禁、灰度、回滚都成熟前，不做自动发布。

## 8. 决策建议

建议团队先确认以下决策：

1. RSI Backend Core（RSI 后端核心服务）是否跟 RAS 同技术栈。
2. 第一条链路是否由 RAS 转发 reply-policy 事件。
3. 第一阶段是否只做 Candidate（候选优化），不做自动发布。
4. 样本是否必须脱敏后入库。
5. PostgreSQL + JSONB 是否作为第一期数据存储。
6. 是否引入 Redis + BullMQ 作为第一期任务队列。
7. reply-policy 是否作为第一个试点。
8. 三个 Agent（智能体）的 Adapter（适配器）是否由各自业务 Owner（负责人）维护。

推荐答案：

```text
RSI Backend Core（RSI 后端核心服务）使用 TypeScript / Node，并优先沿用 RAS 当前框架
RAS 优先转发 reply-policy 事件
第一阶段只做 Candidate（候选优化）
样本必须脱敏和租户隔离
PostgreSQL + JSONB 起步
Redis + BullMQ 起步
reply-policy 作为第一个试点
Adapter（适配器）由业务 Owner（负责人）维护
```

## 9. 一句话总结

RSI 的价值不是让系统“自动乱改”，而是让每一次用户反馈、人工改写、评估失败和发布效果都进入同一条可审计的优化链路。公共平台负责证据和生命周期，通用 Optimizer（优化器）负责发现和建议，业务 Adapter（适配器）负责语义映射，业务 Agent（智能体）负责评估和发布门禁。
