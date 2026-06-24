# RSI Policy Optimization and Policy Format Evolution

## 背景

reply-policy-tuner-agent 当前主要负责固定策略格式下的策略值修改：读取策略、生成 patch、校验、预览、评估、发布门禁与人工确认。真正生成回复话术的是 RAS 根据已发布策略驱动模型完成，因此策略格式本身是 RAS、tuner、运营展示、评估链路之间的输入契约。

本文覆盖两层 RSI：

1. **第一层：策略值自优化**
   - 固定当前策略格式不变。
   - 基于真实会话、运营反馈、validate / preview / evaluate 记录、Judge 告警和发布后效果，自动提出候选 patch。
   - 候选 patch 必须复用现有 validate / preview / evaluate / update 门禁，不自动落库。

2. **第二层：策略格式演进**
   - 当现有字段无法表达稳定、高频的策略需求时，才考虑 schema 变更。
   - schema 变更不等同于让模型在线自由改格式，而应通过离线提案、版本化迁移、兼容验证、灰度发布完成。

两层必须分开：第一层是在既有表单里改内容，可以高频、小步、数据驱动；第二层是改表单结构本身，会影响 RAS 消费逻辑、tuner 展示、校验、评估和旧策略兼容，必须走工程版本化流程。

## 第一层 RSI 与 RAS 的职责边界

第一层不建议让 tuner agent 成为长期数据仓库。tuner 当前是 stdio on-demand 工具，更适合承担策略调优过程中的编排、展示和门禁职责；长期样本、候选 patch、发布效果和统计归因更适合放在 RAS 或独立 RSI backend。

推荐边界：

| 模块 | 职责 |
|---|---|
| tuner agent | 生成或接收 patch；调用 validate / preview / evaluate / update；展示 diff、话术对比、评估摘要；执行发布门禁；从 RAS 拉取优化建议并接入现有评估发布流程 |
| RAS / RSI backend | 持久化调优过程数据；关联用户语义反馈、patch、validate、preview、evaluate、update；沉淀失败样本；生成优化建议；追踪发布后效果 |
| 上层编排 | 处理用户确认点；选择候选 patch 是否进入评估；保证 evaluate 后独立确认再 update |

第一层理想链路：

```text
真实会话 / 运营语义反馈 / validate 记录 / preview 记录 / evaluate 失败 / Judge 告警
→ RAS 持久化并关联调优链路
→ RAS / RSI backend 归因问题并生成候选 patch
→ tuner 拉取候选 patch 和证据说明
→ tuner 复用 validate / preview / evaluate / update 门禁
→ RAS 记录发布结果和发布后效果
→ 形成下一轮优化样本
```

## RAS 对接确认清单

以下问题需要和 RAS 开发者确认，用于判断第一层 RSI 缺口在哪里，以及 tuner 是否需要新增上报或查询能力。

### 调优输入是否已存储

- 是否存储运营在调优对话中的原始语义反馈。
- 是否存储由 tuner / 上层 Agent 生成的 patch。
- 是否存储 patch 的生成原因或用户意图摘要。
- 是否存储 `tenantId`、操作人、时间、会话标识。
- 是否存储 `basePolicyVersion`、`draftPolicyVersion`。
- 是否存储 patch digest 或其他可稳定去重的标识。
- 是否能从一条用户反馈关联到后续 validate / preview / evaluate / update 记录。

### validate / preview / evaluate 是否已存储

- `validate_patch` 是否存储 validate 结果、warnings、diff。
- `preview_policy_effect` 是否存储 base / draft 回复、stage、confidence、diff。
- `submit_evaluate_policy_patch` 是否存储每个 case 的 base / draft 回复。
- 是否存储 Hard Gate 结果与 gate violations。
- 是否存储 Fact Verification 的 blocking / nonBlocking issues。
- 是否存储 Judge winner、recommendedForPublish、rationale、rubricVersion。
- 是否存储 `orchestration.action`、`publishBlocked`、`mandatoryPublishReady`。
- 是否能区分 primary case 和 regression case。

### update 与发布后效果是否已存储

- `update_policy` 成功后是否存储发布时间、发布人、patch、policyVersion。
- 是否存储 affected policy paths。
- 是否能把某次发布和后续真实回复效果关联。
- 是否能追踪低质回复率、人工接管率、事实阻断率、事实违规率、候选人反馈、关键转化指标。
- 是否支持按 tenant、policyVersion、patch digest 查询发布后效果。
- 是否支持回滚或标记某次发布导致回归。

### 样本与 regression case 是否支持沉淀

- 是否已有线上失败样本库。
- 是否能把失败样本标记为 regression case。
- 是否能为样本打标签，例如 tone、cta、fact、qualification、stage、length、safety。
- 是否能记录样本来源：线上会话、运营改写、evaluate 失败、Judge 告警、人工标注。
- 是否支持按 affected policy paths 选择相关样本。
- 是否有样本脱敏、权限控制和保留周期策略。

### 优化建议是否已有承载

- 是否已有 problem report 或 optimization suggestion 数据结构。
- 是否能输出 `problemType`、`affectedPolicyPaths`、evidence cases、confidence。
- 是否能区分“策略可优化问题”和“事实库 / 门店证据缺失问题”。
- 是否能生成一个或多个候选 patch。
- 是否能记录候选 patch 的 validate / preview / evaluate 结果。
- 是否能记录候选 patch 是否被运营采纳、是否发布、发布后效果如何。

## 第一层 RSI 后续方案

第一层应先基于 RAS 已有存储能力收敛实现范围，避免 tuner 重复持久化。

### Step 1：盘点 RAS 已存字段

按上面的确认清单梳理 RAS 当前已经存储的链路数据。重点不是只确认“存了 patch”，而是确认能否把以下对象串起来：

```text
用户语义反馈
→ patch
→ validate
→ preview
→ evaluate
→ update
→ 发布后效果
```

如果 RAS 已经能完整串联，tuner 侧不需要新增长期持久化。

### Step 2：补齐 RAS 缺失的数据关联能力

如果 RAS 只存储 patch 或 validate 结果，但没有存用户原话、生成原因、评估详情或发布后效果，应优先在 RAS 侧补齐。

建议最小新增对象：

- `PolicyFeedbackEvent`：用户语义反馈、线上失败、运营改写、Judge 告警等输入事件。
- `PolicyOptimizationProblem`：问题归因结果，包含 problem type、affected paths、证据和置信度。
- `PolicyPatchCandidate`：候选 patch，包含来源问题、风险等级、评估结果和采纳状态。
- `PolicyReleaseObservation`：发布记录和发布后效果观察。

### Step 3：tuner 新增优化建议入口

在 RAS 能生成候选建议后，tuner 侧只需要新增轻量入口：

- 查看当前 tenant 的策略优化建议。
- 展示建议原因、证据样本、影响字段和候选 patch。
- 让用户选择是否将候选 patch 进入评估。
- 一旦用户选择评估，继续走现有 validate / preview / evaluate / update 流程。

不建议 tuner 在第一阶段新增长期本地 store。若短期没有 RAS 存储，只能把本地 store 作为实验方案，并且必须脱敏、短 TTL、明确非生产长期方案。

## 核心原则

1. **策略值可在线优化，策略格式必须版本化演进**
   - 线上 RSI 可以自动提出策略 patch 候选，但 patch 必须符合当前 schema。
   - schema 变更只能通过人工评审、迁移和灰度流程发布。

2. **新增字段必须能被 RAS 稳定消费**
   - 字段语义要清晰，不能只对 tuner 可读。
   - RAS prompt / policy loader / validate / preview / evaluate 都要理解该字段。

3. **格式演进不能绕过安全门禁**
   - 新字段不能成为规避 `hardConstraints`、`factGate`、`outputGuards` 的旁路。
   - 涉及事实表达、资格判断、薪资福利、地点等高风险能力时，必须增加对应回归样本。

4. **兼容性优先**
   - 每次 schema 变更都要有默认值。
   - 老策略必须能迁移到新版本。
   - 新 RAS 应能在灰度期兼容旧策略。

## 第二层：什么时候允许改策略格式

只有满足以下条件时，才建议提出 schema 变更：

- 同一类策略表达需求反复出现，且现有字段无法准确表达。
- 运营需要频繁用自然语言绕过当前字段结构描述同一种需求。
- 该需求对回复质量或安全性有明确收益。
- 可以设计出稳定、可校验、可解释的字段语义。
- RAS 可以基于该字段稳定生成话术，而不是引入更高幻觉风险。
- 可以构造覆盖该字段的评估样本和回归样本。

不满足以上条件时，应优先通过第一层 RSI 优化现有策略值。

## 第二层推荐流程

```text
线上样本 / 运营修改 / evaluate 告警
→ 归因发现现有字段表达不足
→ 形成 schema change proposal
→ 设计字段语义、默认值和迁移规则
→ 更新 RAS 策略消费逻辑
→ 更新 tuner schema / diff / summary / labels
→ 增加 validate / preview / evaluate 覆盖
→ 离线回放历史样本
→ 小流量灰度
→ 发布新 schemaVersion
```

## Schema Change Proposal 模板

每个策略格式变更建议至少包含：

- **问题描述**：当前 schema 表达不了什么。
- **证据样本**：来自哪些真实会话、评估失败、Judge rationale 或运营修改记录。
- **候选字段**：字段名、类型、枚举值或对象结构。
- **字段语义**：RAS 应如何消费该字段。
- **默认值**：老策略迁移时使用什么值。
- **迁移规则**：如何从旧字段推导新字段，不能推导时如何降级。
- **安全影响**：是否影响事实门禁、硬约束、输出保护。
- **评估样本**：新增或调整哪些 primary / regression cases。
- **灰度方案**：哪些租户、什么指标、多久观察。
- **回滚方案**：如何回到旧 schema 或忽略新字段。

## 版本与迁移

建议为策略增加显式版本概念，例如：

```json
{
  "schemaVersion": "1.1.0",
  "stageGoals": {},
  "persona": {},
  "factGate": {}
}
```

版本策略：

- patch-level：字段文案、枚举说明、非行为性变更。
- minor-level：新增可选字段，提供默认值，旧策略可无损迁移。
- major-level：删除字段、改变字段语义、改变 RAS 解释方式。

迁移要求：

- 新版本发布前必须提供 migration。
- migration 需要单元测试覆盖典型策略和空缺字段。
- RAS 在灰度期应兼容旧版本策略。
- tuner 展示层不得把未知字段静默丢弃为“无变化”。

## RAS 与 Tuner 同步项

策略格式一旦变更，至少需要同步检查：

- `src/types/reply-policy.ts`：schema、类型、响应结构。
- `src/presentation/policy-summary.ts`：运营可读摘要。
- `src/presentation/policy-path-labels.ts`：字段路径标签。
- `src/presentation/comparison.ts`：策略 diff 展示。
- `src/dangerous-patch.ts`：高危变更识别。
- RAS policy loader：默认值、版本识别、迁移。
- RAS prompt builder：新字段如何影响回复生成。
- RAS validate / validate-patch：字段合法性和冲突检查。
- RAS preview / evaluate：新字段是否参与双路回放。
- 回归样本：覆盖新字段的正常行为和误用行为。

## 可考虑的下一代字段方向

以下只是候选方向，是否落地应以样本证据和评估收益为准。

### conversationPolicies

用于表达多轮对话节奏，例如：

- 首轮寒暄深度。
- 单轮最大追问数。
- 候选人冷淡时的推进策略。
- 候选人连续追问事实信息时的回答顺序。

适用场景：现有 `persona` 和 `stageGoals` 无法稳定表达“节奏控制”。

### channelPolicies

用于表达不同渠道的回复差异，例如：

- BOSS 直聊。
- 微信承接。
- 电话邀约前后。

适用场景：同一策略在不同渠道需要不同长度、CTA 和事实披露方式。

### riskPolicies

用于表达高风险事实类别的回复策略，例如：

- 薪资。
- 地点。
- 社保。
- 食宿。
- 年龄。
- 经验要求。

适用场景：仅靠 `factGate.forbiddenWhenMissingFacts` 无法表达“允许说什么、缺证据时怎么问、证据冲突时怎么降级”。

### experimentMetadata

用于记录策略实验信息，不直接影响话术，例如：

- 实验来源。
- 适用租户或人群。
- 预期优化目标。
- 观测指标。

适用场景：需要把 RSI 候选 patch 与发布后效果追踪关联起来。

## 评估与灰度

策略格式变更必须通过三类验证：

1. **结构验证**
   - schema parse 通过。
   - migration 后策略仍合法。
   - patch diff 可读。

2. **行为验证**
   - RAS 对新字段有稳定解释。
   - preview 能展示新旧话术差异。
   - evaluate 能覆盖新字段影响面。

3. **线上灰度**
   - 低质回复率不升高。
   - 事实阻断率不异常下降。
   - 人工接管率不异常升高。
   - 关键转化指标符合预期。

## 不做项

- 不允许模型在线自由新增、删除或重命名策略字段。
- 不允许为了通过评估而放宽 `factGate` 或删除硬约束。
- 不允许 experimental judge 直接决定 schema 变更。
- 不允许只更新 tuner schema，而不更新 RAS 消费逻辑。
- 不允许没有 migration 的破坏性 schema 变更。

## 推荐落地顺序

1. 先补齐第一层 RSI：反馈采集、问题归因、候选 patch、发布后追踪。
2. 基于第一层积累的样本，识别当前 schema 的表达缺口。
3. 对高频表达缺口提交 schema change proposal。
4. 先做可选字段和默认值，不做破坏性变更。
5. 通过离线回放和小流量灰度验证后，再升级策略格式版本。
