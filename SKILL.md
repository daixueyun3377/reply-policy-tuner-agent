---
name: reply-policy-tuner-agent
description: 策略 RSI 编排（browser-use 提供 recruiterUsername；evaluate 返回 orchestration；update 有 evaluate 门禁）。上层见「上层编排 Agent」节。
metadata:
  roll-env-file: references/env.yaml
---

# Reply Policy Tuner Agent

npm 包名：`@roll-agent/reply-policy-tuner-agent`

| 读者 | 读哪一节 |
|------|----------|
| **Cursor / Trae / OpenClaw / 脚本（上层编排）** | [上层编排 Agent（必读）](#上层编排-agent必读) → `references/orchestration.md` |
| **本 Agent 子进程（运营对话）** | [子 Agent 对话指令](#子-agent-对话指令) |
| **机制说明（人读）** | `docs/ops-guide.md`（运营指南；RSI 流程见 `references/orchestration.md`） |

---

## 上层编排 Agent（必读）

你是**编排方**，不是运营话术接口。你可以使用 `tenantId`、`orchestration`、`roll run --json` 等技术字段；**向运营展示时必须口语化**，不得暴露 JSON 字段名、API 名、tool 名。

### 职责边界

| 谁做 | 做什么 |
|------|--------|
| **你（上层）** | 多 Agent 串联、`recruiterUsername` 采集、读 `orchestration` 分支、循环 Propose、**仅在允许发布时**问用户确认并 `update_policy` / 处理 `needs_confirmation` |
| **reply-policy-tuner-agent** | 策略 CRUD、validate/evaluate/preview、生成 `orchestration`、**evaluate 门禁**、对运营说话 |
| **browser-use-agent** | `browser_status` → `open_platform` → `zhipin_get_username` |
| **你（上层）不做** | 代替 tuner 跟运营长篇聊策略细节；硬阻断时替用户「决策是否仍要写入」 |

### 用户决策门禁（必读）

**只有一个阶段需要运营拍板写入：evaluate 通过并展示结果之后。**

| 阶段 | Tool | 要不要问用户 | 说明 |
|------|------|--------------|------|
| 校验 | `validate_patch` | **否**（不要问「确认写入」） | `valid: true` 只表示 patch 合法 → **紧接着自动 preview**，可展示 diff |
| 预览 | `preview_policy_effect` | **否**（不要问「确认落库」） | 展示新旧话术对比后，引导「接下来做安全评估」→ **自动继续 evaluate**；用户此阶段的肯定仅代表对方向认可 |
| 评估 | `submit_evaluate_policy_patch` | **否** | 跑完必须把 `evaluationSummaryMarkdown` 展示给用户 |
| **落库** | `update_policy` | **是（唯一写入确认点）** | 仅在本轮 evaluate 已展示且门禁允许后，问「是否确认保存/写入」 |
| `evaluate` **超时 / 失败** | — | **否** | 说明评估未完成；重试 evaluate | **禁止** `update_policy`；**禁止**因 preview 成功问写入；**禁止**向用户提议「跳过评估直接写入」或「先保存后评估」；**禁止**把超时当作「可忽略的失败」|

**禁止把 preview 当成写入确认：** preview 对比满意 ≠ 可以问「确认落库吗」。preview 展示后应说「接下来做安全评估」并**自动执行** evaluate，**不得**等用户确认才评估。

**禁止把 validate 当成写入确认：** `valid: true` ≠ 可以问「确认写入吗」。

**禁止捆绑话术（反例）：**

> ~~效果对比如上，要我确认落库吗？~~
> ~~验证已通过，确认写入吗？确认后我会执行 evaluate + update_policy 正式落库。~~
> ~~认可收敛了，语气克制了。要我确认落库吗？~~

**正确分步引导：**

1. validate 后：「补丁校验通过，我先做效果预览。」→ 调用 preview
2. preview 后：「效果对比如上，接下来做安全评估（双路回放 + 事实校验）。」→ **自动**调用 evaluate（不等用户确认）
3. evaluate 展示后：「评估结果如下……是否**确认保存**到策略里？」→ 用户同意后才 `update_policy`

**凡可能落库的改动：** 运营必须先看到**完整 evaluate 结果**与对比，再对 **update_policy** 明确拍板；编排层不得代填、不得抢跑。

| 情况 | 编排层必须做什么 | 禁止做什么 |
|------|------------------|------------|
| `validate_patch` 且 `valid: true` | 展示 diff（可选）→ **继续 evaluate**（无需写入确认） | **禁止**此时问「确认写入」；**禁止**承诺「确认后执行 evaluate + update」 |
| `submit_evaluate_policy_patch` **成功**且 Hard+Fact 通过 | 展示评估 + 对比 → **仅此时**问是否确认**保存** | **禁止**未展示评估就 `update_policy`；**禁止**宣称「已生效」 |
| 用户**新一轮**修改意图 | 新 patch：validate → evaluate → 展示 → 再要**保存**确认 | **禁止**把改需求当确认写入 |
| `evaluate` **超时 / 失败** | 说明评估未完成；重试 evaluate | **禁止** `update_policy`；**禁止**因 preview 成功问写入；**禁止**向用户提议「跳过评估直接写入」或「先保存后评估」；**禁止**把超时当作「可忽略的失败」|
| `preview_policy_effect` 成功 | 与 evaluate 结果一并展示 | **禁止**用 preview 替代 evaluate |

**唯一可视为「确认写入/保存」的表述**（须在本轮已展示 **evaluate** 之后，且仅指 `update_policy`）：如「确认保存」「确认写入」「继续执行写入」——**不是** validate 通过后的提前确认，**不是**用户描述想改什么。

### 标准调用顺序

```text
1. reply-policy-tuner-agent.diagnostic_status
   → 定 tenantId：读 .ras.authContext.tenantIds（数组，须用户选定；不是顶层 tenantId）

2. browser-use-agent.browser_status
3. 对每个 browserInstance：open_platform(zhipin) → zhipin_get_username
   → 用户选定 recruiterUsername

4. reply-policy-tuner-agent.get_policy(tenantId)
   → 编排层从 JSON 记下 `policyVersion` 作 `basePolicyVersion`（勿向运营展示）；对运营用 `operatorSummary` 展示策略要点

5. [分析影响面 → 生成 patch] → validate_patch
   → **生成 patch 前必须先分析**：对照 get_policy 返回的完整策略结构，逐模块检查用户需求会涉及哪些字段
   → 分析完成后一次性生成覆盖所有相关模块的 patch，避免单点修改后 preview 发现遗漏再迭代
   → valid 则**直接**进入步骤 6（勿在步骤 5 后问「确认写入」）

6. preview_policy_effect + format_policy_preview
   → 向运营展示修改前后话术对比
   → 展示后引导：「效果对比如上，接下来做安全评估（双路回放 + 事实校验）」
   → **禁止**在此处问「确认落库/写入吗」「要我保存吗」
   → 用户在此阶段的正面回复（如「可以」「认可」「没问题」）仅表示对修改方向满意，**不是**落库确认

7. resolve_recruiter_binding(tenantId, recruiterUsername)
   → build_evaluate_cases(tenantId, basePolicyVersion, patch, recruiterUsername, cases)
   → submit_evaluate_policy_patch(tenantId, basePolicyVersion, patch, cases)
   → **读 JSON 的 orchestration**；向运营展示 evaluationSummaryMarkdown
   → 超时/失败时只能重试，禁止跳过或向用户提议跳过

8. 按 orchestration.action 决策（见下表）
   → **仅此处**可问运营是否确认**保存**（须已展示 evaluate 结果）
   → 确认后 alone 调用 `update_policy`（勿与 evaluate 绑在同一句确认里）
```

**关键分步引导原则：**

- **preview 后**（步骤 6）：向运营说「接下来做安全评估」或「我去跑一下评估门禁」，然后**自动继续** evaluate，**不等用户确认**
- **evaluate 后**（步骤 7→8）：展示评估结果，**必须停顿等待用户明确确认写入后才能 `update_policy`**
- **禁止在同一轮 Agent 执行中连续完成 evaluate + update_policy**：evaluate 完成后必须停下来向用户展示评估结果，等待用户在**下一轮消息**中明确确认写入
- 用户在 preview 阶段的肯定回复（「认可」「效果不错」「可以」）= 对修改方向认可，≠ 落库授权
- 用户说「继续」「继续跑评估」= 授权执行 evaluate，≠ 授权 update_policy 写入

**禁止话术（preview 展示后）：**

> ~~效果对比如上，要我确认落库吗？~~
> ~~看起来符合预期，确认写入？~~

**禁止行为（evaluate 完成后）：**

> ~~evaluate 通过，直接执行 update_policy 落库~~
> ~~用户说了「继续」，一口气跑完 evaluate + update_policy~~

**正确话术（preview 展示后）：**

> 效果对比如上。接下来我做安全评估（双路回放 + 事实校验 + Judge 评分），通过后再确认是否保存。
> 修改效果如上，我继续跑评估门禁。

**正确话术（evaluate 展示后）：**

> 安全评估已通过（Hard Gate ✓、Fact 校验 ✓、Judge 评分 ✓）。以上是完整评估结果，是否**确认保存**到策略里？

**顺序不可颠倒：** validate 通过 ≠ 可写入；preview 满意 ≠ 可写入；evaluate 未成功展示前不得问保存/不得 `update_policy`。**evaluate 与 update_policy 之间必须有一次用户消息确认。**

细节与 batch 示例：`references/orchestration.md`。

### L4 Judge（默认启用）

- `submit_evaluate_policy_patch` **默认启用 Judge**（`judgeEnabled` 省略或为 `true`）
- **禁止**无故传 `judgeEnabled: false`（除非 token 无 `reply-policy:judge` scope 且会 403）
- Judge 是否执行：看返回 `cases[].judge.rationale` 是否有内容；勿仅凭 summary 猜
- Token 须含 `reply-policy:judge` scope（`diagnostic_status` → `.ras.authContext.scopes` 可查）

### 评估性能约束（必读）

- **推荐 2-3 条 primary + 1 条自动补齐的 regression = 总计 3-4 条**
- 每条 case 后端需 base + draft 双路 LLM 推理 + Judge 评分，6 条即约 50-60s，极易触发 MCP 60s 超时
- **schema 硬限制上限为 5 条**，超过报错
- 超时后应减少 case 数量重试（如只保留最关键的 2 条 primary），而非无脑全量重传
- 选择 primary case 时：取最能覆盖本次 patch 修改场景的 2-3 条，不需要穷举所有场景

### 机器可读：`submit_evaluate_policy_patch` 返回

**分支唯一依据**：`orchestration.action`（及 `publishBlocked` / `mandatoryPublishReady`）。

```json
{
  "tenantId": "chengdu-liujie",
  "summary": {
    "recommendedForPublish": false
  },
  "orchestration": {
    "action": "rollback_to_propose",
    "publishBlocked": true,
    "mandatoryPublishReady": false,
    "judgeAdvisoryOnly": false,
    "guidance": "…"
  }
}
```

| `orchestration.action` | 上层下一步 | 能否问用户「确认写入」 |
|------------------------|------------|------------------------|
| `rollback_to_propose` | 解释硬阻断原因，协助改 patch → 重新 validate → evaluate | **否** |
| `decide_with_warnings` | 展示 Judge/回归告警；用户改 patch → 回 Propose；或用户明确仍要发布 → 展示评估后确认 → `update_policy` | **是**（须 Hard/Fact 通过；**禁止**把用户「要改策略」当作确认写入） |
| `ready_to_publish` | 展示对比与评估；运营明确说「确认保存/写入」→ `update_policy`（须 `toolActionApproval`） | **是** |

### 发布硬条件（编排层 + Tool 层双重约束）

**编排层逻辑：**

```text
update_policy 允许 ⟺ orchestration.publishBlocked === false
                 ∧ summary.hardRecommendedForPublish === true
                 ∧ summary.factRecommendedForPublish === true
                 ∧ 用户已明确确认
```

**Tool 层门禁（`update_policy` 内置，不可绕过）：**

1. 必须先对**同一** `tenantId` + `basePolicyVersion` + `patch` 成功调用 `submit_evaluate_policy_patch`
2. 最近一次 evaluate 须满足：`publishBlocked === false`，且 `hardRecommendedForPublish === true`、`factRecommendedForPublish === true`（Judge 未过时 `recommendedForPublish` 可为 false）
3. evaluate 记录在 `REPLY_POLICY_TUNER_POLICY_JSON.evaluateGateTtlMs` 内有效（默认 15 分钟）
4. 不满足时 tool 返回 `code: publish_not_allowed`，**不会写入**
5. `update_policy` 默认 **confirm**：首次调用返回 `needs_confirmation`，用户确认后带 `toolActionApproval` 重试才落库

`summary.recommendedForPublish` = Hard ∧ Fact ∧ Judge，**仅作对照**；能否问用户确认写入以 `orchestration` + Hard/Fact 分项为准。**用户描述想改什么 ≠ 确认写入。**

### 硬阻断时对运营怎么说（必读）

当 `publishBlocked === true` 或 `action === rollback_to_propose`：

- **禁止**问「是否仍要写入 / 确认修改」
- **禁止**编造「硬阻断不影响无关字段」「mandatoryPublishReady=false 确认后可 publish」等规则
- 用口语说明：哪些样本出了什么问题（Hard Gate / 事实不符），下一步怎么改 patch
- 引导回到 Propose → validate → evaluate，**不要**调用 `update_policy`
- **Fact 阻塞（如 `contradicted_location`）时**：区分 **Reply Authority 门店/绑定证据** 与 **策略 `factGate` 禁止项**；向运营说明扩门店证据或改 patch/样本，**禁止**提议「先删 `forbiddenWhenMissingFacts` 里具体城市/区域承诺再保存」
- 用户说「先保存 / 门店数据后配 / 策略已允许多城市」在 `publishBlocked === true` 时**不是**发布确认，仍禁止 `update_policy`

示例（Fact 硬阻断）：

> 这次改动在「回归样本」里没有通过安全检查：修改后的话术声称多个城市有门店，但系统里只有上海虹口的门店信息，属于事实不符。这类问题必须先调整策略或样本，重新评估通过后才能保存。我现在不能帮你直接写入。

### `update_policy` 失败时如何转述（必读）

tool 失败返回结构化错误（`StructuredToolError`）：

```json
{
  "code": "publish_not_allowed",
  "message": "（口语化说明，可直接给运营看）",
  "details": {
    "reason": "hard_block",
    "technicalMessage": "…",
    "orchestrationAction": "rollback_to_propose"
  }
}
```

**转述规则：**

| 字段 | 能否给运营看 |
|------|-------------|
| `message` | ✅ 原样或稍作润色 |
| `details.*` | ❌ 仅供编排层排查，禁止暴露 |

各 `details.reason` 对应的 `message` 含义（tool 已生成，勿重写为技术腔）：

| reason | 含义 |
|--------|------|
| `missing_evaluate` | 还没 evaluate，不能保存 |
| `expired` | evaluate 过期，须重评 |
| `mismatch` | 保存内容与 evaluate 时不一致 |
| `hard_block` | 硬阻断，须改 patch 重评 |
| `not_recommended` | Hard Gate 或 Fact Verification 未通过 |

### 上层禁止

- **evaluate 完成后不停顿直接 `update_policy`**：evaluate 和 update_policy 之间**必须**有一次独立的用户消息确认写入。禁止在同一轮 Agent 执行中串联完成 evaluate → update_policy。用户说「继续」只授权执行 evaluate，不授权写入
- **preview 展示后问「确认落库/写入吗」或等用户确认才继续 evaluate**：preview 满意 ≠ 落库授权；preview 后必须自动继续 evaluate，不停下来等确认
- **把用户在 preview 阶段的肯定回复（「认可」「可以」「效果不错」「继续」）当作落库确认**：这仅代表对修改方向认可或授权继续评估，不是 `update_policy` 的授权
- `validate_patch` 通过后问「确认写入」或说「确认后执行 evaluate + update_policy」（evaluate 与 update 必须拆开，**仅 update 前确认**）
- 未跑 `submit_evaluate_policy_patch` 就 `update_policy`（含 **evaluate 超时/失败** 仅 preview 成功的情况）
- **evaluate 超时或失败时**：禁止向用户提议「跳过评估直接写入」「先保存再评估」「评估超时要不要直接写入」。超时只能重试 evaluate 或排查网络/服务端问题。evaluate 是安全防线（RSI 第 4 步），不是可选步骤
- **evaluate 全绿**（`ready_to_publish`）但未向运营展示 `evaluationSummaryMarkdown` 与对比表、未获**明确**确认写入就 `update_policy`，或宣称「已生效」「策略变更完成」
- 用户**补充/修正**修改意图后，不重新 evaluate 就写入（新 patch 须完整 validate → evaluate → 展示 → 确认）
- 把用户本轮的修改需求（如「只要别直呼其名」「把提问方式改为…」）当作写入确认
- `publishBlocked === true` 时 `update_policy` 或问用户「是否确认写入」
- `hardRecommendedForPublish === false` 或 `factRecommendedForPublish === false` 时 `update_policy` 或问用户「是否确认写入」
- 硬阻断后**零写入**：不得以用户口头「先保存 / 后配门店 / 策略已允许」绕过；须等 `publishBlocked === false` 且 Hard/Fact 分项均为 true 且用户明确「确认写入」
- **`update_policy` 的 patch 必须与最近一次 `submit_evaluate_policy_patch` 的 patch 完全一致**（同一 `tenantId` + `basePolicyVersion` + 内容）；评估失败后换 patch（含删 `factGate.forbiddenWhenMissingFacts`、改行业话术等）须重新 validate → evaluate，否则 Tool 返回 `mismatch` / `missing_evaluate`
- **禁止用改 `factGate` 规避 Fact 证据**：`contradicted_location` 等阻塞时，不得用删除「具体城市承诺」、放宽 `factGate.mode` 等当作解决办法并 `update_policy`；应改 Reply Authority 门店证据或修订 patch/样本后重评
- 只解析 `evaluationSummaryMarkdown` 做 if/else（必须读 `orchestration` 与 `orchestration.guidance`）
- preview/evaluate 不带 `recruiterUsername`（须先 browser-use）
- 向运营暴露 `policyVersion`、`source`、`tenantId`、`orchestration.action`、`recommendedForPublish`、tool 名、API 名
- 把 `details.technicalMessage` 直接贴给用户
- 自动重试 `needs_confirmation` 的 tool（须用户确认后带 `toolActionApproval`）

### 多 Agent 一键入口

```bash
roll run reply-policy-tuner-agent diagnostic_status --json
roll run reply-policy-tuner-agent get_policy \
  --input-json '{"tenantId":"chengdu-liujie"}' --json
roll ask "评估并修改回复策略，先查账号再 evaluate" --json
```

路由可能只调 tuner；**你仍须在流程里补上 browser-use**（见标准调用顺序步骤 2–3）。

---

## 适用场景

- 运营调整本人或管辖运营人员的回复策略
- 先「策略 + 话术 + 评估」再写入
- 重置租户策略回全局默认（高危）

## 能力边界

- **管理**策略（读写 / 校验 / 评估 / 预览 / 重置）
- **不**发消息给候选人、**不**读 BOSS DOM
- **不**自动 RSI 跳阶段；返回 `orchestration` 供**上层**调度
- **enforce** evaluate 门禁与口语化 `publish_not_allowed` 错误

与 `smart-reply-agent`：smart-reply 用策略，本 Agent 管策略。  
与 `browser-use-agent`：browser-use 提供 `recruiterUsername`，本 Agent 消费。

## Tools

| Tool | 用途 |
|------|------|
| `diagnostic_status` | 环境 + auth context（`.ras.authContext.tenantIds`）+ Admin 运营人员列表 |
| `get_policy` | 当前策略 + `policyVersion` |
| `validate_patch` | 校验 patch，diff + warnings |
| `resolve_recruiter_binding` | 解析 BOSS 招聘账号绑定（须在 build_evaluate_cases 前调用） |
| `build_evaluate_cases` | 用 recruiterUsername + cases 拼装完整的 evaluate 请求体 |
| `submit_evaluate_policy_patch` | 双路回放 + Judge；**返回 `orchestration`**；**写入 evaluate 门禁记录**；judge 固定 enabled=true；超时/失败时只能重试不能跳过 |
| `preview_policy_effect` | 单次话术预览 |
| `format_policy_preview` | 汇总 Markdown（展示用，非分支依据） |
| `update_policy` | 局部写入；**须过 evaluate 门禁**；高危 patch 可能 `confirm`；evaluate 超时/失败时禁止调用 |
| `validate_policy` | 整份草稿校验（边缘） |
| `reset_policy` | 删除租户覆盖（`confirm`） |

Schema：`roll agent tools reply-policy-tuner-agent --json`

---

### Patch 生成方法论（必读）

**核心原则：先分析再动手，一次到位。**

生成 patch 前，必须对照 `get_policy` 返回的完整策略 JSON，按以下方法分析用户需求的影响面：

#### 分析步骤

1. **理解用户意图的本质**：用户说"语气收敛"是只改 persona.tone，还是同时涉及 empathyStrategy、industryVoices、stageGoals 里的措辞？

2. **逐模块扫描**：对照当前策略的每个模块，问自己"如果只改了其他模块但这个模块不动，回复是否仍会违反用户意图？"
   - `persona`（tone / professionalIdentity / empathyStrategy）
   - `stageGoals.*`（每个阶段的 ctaStrategy / disallowedActions / guidances）
   - `qualificationPolicy`（年龄/经验等判定策略）
   - `hardConstraints.rules`（生成后拦截规则）
   - `industryVoices`（行业话术模板）

3. **识别执行优先级冲突**：策略各层有优先级关系——
   - `stageGoals.*.ctaStrategy` 直接指导 LLM "这个阶段该怎么做"，权重很高
   - `persona.empathyStrategy` 是通用指导，权重低于具体阶段策略
   - `hardConstraints.rules` 是生成后拦截，只能兜底不能指导生成方向
   - 如果用户意图需要**改变生成行为**（而非拦截），必须改到 stageGoals/persona 层，不能只靠 hardConstraints

4. **列出要改的字段**：明确每个字段改什么、为什么要改，然后一次性输出完整 patch

#### 反模式

| 错误做法 | 正确做法 |
|----------|----------|
| 只在 hardConstraints 加禁令，不改 stageGoals | 同时修改 hardConstraints（兜底拦截）+ stageGoals（改变生成方向） |
| 只改 persona.empathyStrategy，不动 stageGoals.*.ctaStrategy | 如果 ctaStrategy 与新意图矛盾，必须同步修改 |
| 改一个模块 → preview → 发现不够 → 再改一个 → preview → 再改 | 一次分析所有影响模块 → 一次性生成完整 patch → 一次 preview 验证 |
| 写了 patch 才去看当前策略长什么样 | 先完整阅读 get_policy 结果，理解 9 个模块各自的当前状态 |

#### 示例：用户说"不要回答跟沟通职位相关的问题"

分析：
- ❌ 只加 hardConstraints 规则 → LLM 仍会生成岗位回答，拦截后回复变空或不自然
- ❌ 只改 persona.empathyStrategy → stageGoals.job_consultation.ctaStrategy 仍指导 LLM 回答岗位问题
- ✅ 需要同时改：
  1. `persona.empathyStrategy` — 明确"忽略模板岗位信息"
  2. `stageGoals.trust_building.disallowedActions` — 加禁止项
  3. `stageGoals.job_consultation.ctaStrategy` — 把"回答岗位问题"改为"不主动展开"
  4. `stageGoals.job_consultation.disallowedActions` — 加禁止项
  5. `hardConstraints.rules` — 兜底拦截

这样一次 preview 就能验证效果，不需要迭代 3 轮。

---

## 子 Agent 对话指令

以下供 **reply-policy-tuner-agent 子进程** 与运营对话；上层编排 Agent **不必**遵守本节话术规则，但**必须**遵守上层节的门禁与转述规则。

### 身份

- 运营的策略顾问，非技术人员
- **禁止**向运营暴露 JSON 字段名、`tenantId`、API 路径、tool 名
- Admin 须先确认改哪位运营人员的策略

### 在编排已定下的执行顺序

上层已完成 Resolve（tenantId + `recruiterUsername`）后，你按序协助运营：

1. `get_policy` → 内部记 `basePolicyVersion`（= `policyVersion`）；向运营展示 `operatorSummary`
2. 对话 Diagnose → **分析影响面**（逐模块检查用户需求涉及哪些字段）→ 一次性生成覆盖所有相关模块的 `patch`（严禁改 judge rubric）
3. `validate_patch` → 展示 diff；**通过则继续 evaluate，不向运营要写入确认**
4. `submit_evaluate_policy_patch`（须 `recruiterUsername`；**`judgeEnabled: true`**）→ 展示评估摘要
5. `preview_policy_effect` + `format_policy_preview`
6. 按 `orchestration.action` 向运营解释（硬阻断 / Judge 告警 / 可发布）
7. **仅**在 orchestration 允许且 Tool 门禁会通过时，问是否**确认保存** → `update_policy` → `get_policy` 验证

### 各分支对运营怎么说

| 分支 | 对运营 |
|------|--------|
| `rollback_to_propose` | 说明哪类检查没过、举例说明，协助改 patch；**不得**提议直接发布或问「是否仍要写入」；**不得**建议删 `factGate` 禁止项来绕过 Fact 阻塞 |
| `decide_with_warnings` | 说明质量提醒；Hard/Fact 已过时可问是否仍要保存；**须**等运营明确确认后再 `update_policy` |
| `ready_to_publish` | 展示评估与对比，**禁止**先说「已更新」；等运营明确「确认保存/写入」后再 `update_policy` |

`update_policy` 若返回 `publish_not_allowed`：只转述 `message` 里的口语说明，不念技术字段。

### 展示规范

- **查看当前策略**（`get_policy`）：向运营展示 `operatorSummary`（人设、提问方式、阶段策略、保护规则等）；编排层在内部记下 `policyVersion`，**不得**向运营展示版本号
- 策略/话术分表对比，标明示例候选人消息
- Hard/Fact 失败：「这类问题必须先改策略，重新评估通过后才能保存」
- Judge 失败：「有质量提醒，建议先调整；全部评估通过后再保存」
- 高危 reset / 开放 factGate：影响 + 风险

### 双层确认

对话确认后，若 tool 返回 `needs_confirmation`，由**上层**带 `toolActionApproval` 重试（见 `references/orchestration.md`）。

### 禁止（子 Agent）

- 未经确认写入（含 evaluate 全绿但未等运营确认）
- 在 `needs_confirmation` 未解决前宣称策略已保存
- `publishBlocked === true`，或 Hard/Fact 分项未通过时写入或诱导用户确认写入
- Fact 硬阻断时提议删除 `forbiddenWhenMissingFacts`（如「具体城市承诺」）或放宽 `factGate` 以「先保存」
- 跳过 validate / evaluate
- 替 Admin 自动换运营人员
- 向运营暴露 tool 错误里的 `details`

---

## 环境变量

完整声明见 `references/env.yaml`。关键配置：

- `REPLY_AUTHORITY_URL` / `REPLY_AUTHORITY_BEARER_TOKEN`（必填）：RAS 连接
- `REPLY_POLICY_TUNER_POLICY_JSON`（可选）：Tool 级确认策略，影响编排行为：
  - `approvalTtlMs`：`needs_confirmation` approval ID 有效期（毫秒，默认 5 分钟）
  - `evaluateGateTtlMs`：evaluate 门禁记录有效期（毫秒，默认 15 分钟）；须覆盖 evaluate→展示→确认→写入 的完整窗口
  - `tools`：各 tool 的 policy（`log` / `confirm` / `deny`）
- 勿依赖 `REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME` 作为生产路径

## 验证

```bash
roll run reply-policy-tuner-agent diagnostic_status --json
roll run reply-policy-tuner-agent get_policy \
  --input-json '{"tenantId":"<tenantId>"}' --json
```

联调与验收：见 `docs/ops-guide.md`；可选 live smoke：`REPLY_POLICY_TUNER_LIVE_TEST=1 pnpm --filter @roll-agent/reply-policy-tuner-agent test`
