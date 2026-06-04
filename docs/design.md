# Reply Policy Tuner Agent 设计文档

> 包名：@roll-agent/reply-policy-tuner-agent  
> 读者：需要理解架构与契约的开发者、编排方集成者。运营话术与操作步骤见 SKILL.md、docs/ops-guide.md、references/orchestration.md。

---

## 1. 定位与目标

本仓库是一个基于 Roll Agent SDK 的 stdio Agent，通过 MCP Tool 管理租户的**回复策略**：读取、补丁校验、话术预览、双路评估、有条件写入与重置。运行时采用按需拉起、标准输入输出传输。

| 目标 | 实现手段 |
|------|----------|
| 策略变更可验证 | 经 Reply Authority Service 完成校验、预览、评估后再允许写入 |
| 上层可机械分支 | submit_evaluate_policy_patch（提交双路评估）返回编排结构，由上层决定下一步，Agent 不自动跳转 RSI 阶段 |
| 写入不可绕过评估 | 本地评估门禁 + update_policy（局部更新并写入）默认需二次确认 |

**职责边界外**：向候选人发消息、解析 BOSS 页面、多 Agent 流程串联。招聘账号名由 browser-use-agent 提供；线上回复由 smart-reply-agent 等消费已发布策略。

---

## 2. 系统上下文

| 参与方 | 职责 |
|--------|------|
| 上层编排 | 选定租户与招聘账号、串联 browser-use、读取评估编排结果、在唯一写入点征求运营确认 |
| 本 Agent | 暴露 Tool、推导编排字段、持久化评估门禁与操作批准 |
| Reply Authority Service | 策略存储、校验、回放推理、Hard Gate / Fact / Judge |
| browser-use-agent | 提供 recruiterUsername |
| smart-reply-agent | 运行时消费策略，与管理面分离 |

数据流：编排方调用本 Agent 与 browser-use；本 Agent 访问 RAS；RAS 侧策略供运行时回复使用。

---

## 3. 模块划分

| 层次 | 职责 |
|------|------|
| 入口 | 注册全部 Tool 并启动监听 |
| 类型定义 | 策略、评估、管理端与 Tool 入出参的结构校验 |
| 服务层 | RAS HTTP 客户端；招聘账号绑定解析 |
| Tool 层 | 对外 MCP 能力 |
| 呈现层 | 运营可读摘要、评估 Markdown、策略/话术对比表；编排动作推导 |
| 门禁与策略 | 评估通过记录、发布拦截文案、Tool 级 log/deny/confirm、一次性批准、高危补丁识别 |
| 诊断 | 环境变量是否配置（指纹而非明文） |
| 存储清理 | 门禁与批准目录的过期文件概率清理 |

依赖关系：Tool 依赖服务层与呈现层、门禁模块；呈现层不直接访问 RAS。

构建与发布：TypeScript 编译声明后打包、混淆，产物为 dist 目录；npm 包附带 SKILL 与 references。

### 3.1 Tool 名称对照

下文凡出现 Tool 英文名，含义均以下表为准。

| Tool 名 | 中文含义 |
|---------|----------|
| diagnostic_status | 环境与 RAS 连通性诊断 |
| get_policy | 读取当前回复策略 |
| validate_patch | 校验策略补丁（不写入） |
| resolve_recruiter_binding | 解析 BOSS 招聘账号与租户绑定 |
| build_evaluate_cases | 拼装评估用例（含回放目标） |
| submit_evaluate_policy_patch | 提交策略补丁双路评估 |
| preview_policy_effect | 预览补丁对单条话术的影响 |
| format_policy_preview | 格式化运营可读的对比与评估展示 |
| update_policy | 局部更新并写入回复策略 |
| validate_policy | 校验完整策略草稿（不写入） |
| reset_policy | 重置租户策略为全局默认 |

---

## 4. Reply Authority Service 集成

所有业务请求携带 Bearer 令牌与请求 ID。失败时按场景（读、写、校验、预览、评估等）映射为中文说明；补丁校验与整稿校验在参数非法时返回「未通过」结构而非直接抛错。

| 能力 | HTTP 形态 | 对应 Tool（中文） |
|------|-----------|-------------------|
| 健康检查 | GET health | diagnostic_status（环境与 RAS 连通性诊断） |
| 授权上下文 | GET auth/context | diagnostic_status；resolve_recruiter_binding（解析招聘绑定） |
| 运营人员列表 | GET admin/tenants | diagnostic_status（管理员令牌） |
| 读取策略 | GET 租户回复策略 | get_policy（读取当前回复策略） |
| 局部更新 | PATCH 租户回复策略 | update_policy（局部更新并写入） |
| 删除租户覆盖 | DELETE 租户回复策略 | reset_policy（重置为全局默认） |
| 整稿校验 | POST validate | validate_policy（校验完整草稿） |
| 补丁校验 | POST validate-patch | validate_patch（校验策略补丁） |
| 话术预览 | POST preview | preview_policy_effect（预览话术影响） |
| 批量评估 | POST evaluate | submit_evaluate_policy_patch（提交双路评估） |
| 解析招聘绑定 | POST resolve-recruiter-binding | resolve_recruiter_binding；预览/评估流程内部也会调用 |

超时：一般接口默认 30 秒；评估接口默认 90 秒，可通过环境变量覆盖。

---

## 5. 回复策略领域模型

策略配置与 RAS 契约一致，主要模块如下：

| 模块 | 说明 |
|------|------|
| persona | 语气、回复长度、共情与称呼等人设 |
| stageGoals | 六个招聘阶段目标（其中私域阶段可选） |
| industryVoices | 行业话术模板及默认选用 |
| hardConstraints | 生成后拦截规则及严重程度 |
| factGate | 事实核查模式、可核实声明类型、缺失事实时的禁止项 |
| qualificationPolicy | 资格判定（如年龄相关策略） |
| outputGuards | 提问上限、审计禁用语等 |

策略来源分为：租户文件、全局文件、内置默认。每次读取带版本号；写入补丁须与当前基准版本一致。

读取策略时可只拉取单个模块；同时生成运营可读要点摘要，不向运营展示版本号。

---

## 6. 招聘账号绑定

通过 RAS「解析招聘绑定」接口，平台固定为 BOSS 直聘，按用户名解析租户与绑定关系。

**用户名解析顺序**（依次尝试直至成功）：Tool 传入的账号名 → 环境变量配置的预览账号 → 内置默认候选。

**resolve_recruiter_binding（解析 BOSS 招聘账号与租户绑定）两种用法**：

| 入参组合 | 行为 |
|----------|------|
| 仅提供招聘账号名 | 返回 RAS 解析出的租户 ID 与账号名 |
| 同时提供租户 ID 与账号名 | 校验二者与 RAS 结果一致 |

解析成功后校验当前令牌是否有权管理该租户：管理员令牌可管理全部租户；客户端令牌须在授权租户列表内，否则返回口语化权限错误。

preview_policy_effect（预览话术影响）若未传账号名，走同一套解析逻辑，并使用固定的预览会话标识。

---

## 7. RSI 阶段与 Tool 映射

递归改策（RSI）由上层编排驱动，本 Agent 只提供阶段能力。

| 阶段 | 主要 Tool（中文） | 说明 |
|------|-------------------|------|
| 解析 | diagnostic_status（环境与连通性诊断）、resolve_recruiter_binding（解析招聘绑定） | 租户、权限范围、管理员可见运营列表 |
| 查看 | get_policy（读取当前回复策略） | 记下基准版本供后续补丁使用 |
| 提议 | （上层生成补丁） | 局部 JSON 补丁 |
| 校验 | validate_patch（校验策略补丁） | 合法则返回字段 diff 与对比 Markdown |
| 预览 | preview_policy_effect（预览话术影响）、format_policy_preview（格式化展示） | 修改前后话术与策略对比 |
| 评估 | build_evaluate_cases（拼装用例）→ submit_evaluate_policy_patch（提交双路评估） | 写入门禁并返回编排结果 |
| 发布 | update_policy（局部更新并写入） | 须过评估门禁且默认需确认 |
| 重置 | reset_policy（重置为全局默认） | 不经过评估门禁，仅高危确认 |

另有 validate_policy（校验完整策略草稿），用于边缘场景。

**写入确认时序**：运营明确同意保存仅发生在评估结果展示之后；校验或预览阶段的认可不构成落库授权。

---

## 8. 评估流水线

### 8.1 用例构建（build_evaluate_cases · 拼装评估用例）

- 每次 1～5 条用例，分主样本与回归样本，至少一条主样本。
- 若未提供回归样本且总数未满上限，自动追加默认问候类回归用例。
- 输出包含完整评估目标（平台、租户、招聘绑定、会话与候选人标识）。

建议 2～3 条主样本加 1 条回归（共 3～4 条），以控制评估耗时与超时风险。

### 8.2 提交评估（submit_evaluate_policy_patch · 提交策略补丁双路评估）

- 请求侧 Judge 始终启用，不在 Tool 入参中提供关闭开关。
- 对 RAS 响应做结构校验；**对外 Tool 结果不包含逐条 case 明细**，仅包含汇总、是否建议发布、编排结构、评估摘要 Markdown 与警告。
- 成功后写入本地评估门禁记录（见第 9 节）。

### 8.3 编排动作推导

在 Agent 本地根据评估响应计算编排结构，上层必须以编排动作、是否禁止发布、指引文案分支，不能仅凭评估摘要 Markdown 做判断。

**强制可发布就绪**（与 Judge 无关）：Hard Gate 与 Fact 汇总均建议发布，且各用例草稿侧无 Fact 阻塞项。

**禁止发布**：未达强制就绪，或草稿引入门控违规，或 Hard/Fact 汇总任一项不建议发布。

**仅 Judge 告警**：强制就绪且未禁止发布，但 Judge 不建议发布。

| 编排动作 | 含义 |
|----------|------|
| 回退到提议 | 硬安全或事实未通过，须改补丁后重新校验与评估 |
| 带告警决策 | Hard 与 Fact 已过，Judge 或回归有质量提醒，运营可选择改补丁或确认后仍发布 |
| 可发布 | Hard、Fact、Judge 均通过，展示结果后待运营确认再写入 |

另含字段：是否强制可发布、是否仅 Judge 告警、是否仍需运营明确确认发布。硬阻断时指引中会说明禁止绕过事实门禁、补丁须与本次评估一致等。

评估摘要 Markdown 仅供展示。

---

## 9. 发布门禁（Evaluate Gate）

评估成功后，按「租户 + 基准版本 + 补丁摘要」在本地落一条记录；默认目录在用户主目录下的 roll-agent 专用子目录，可通过环境变量改路径。记录默认有效期 15 分钟。写入时以约五分之一概率清理过期文件。

记录保存：是否建议发布、Hard/Fact 分项、是否禁止发布、编排动作、评估时间、草稿版本等。

更新策略（update_policy）前校验记录：无记录、记录损坏、过期、租户/版本/补丁不一致、仍处禁止发布、Hard 或 Fact 未通过时，返回 publish_not_allowed 类错误，message 为运营可读中文，details 中的 reason 供编排排查：

| reason | 含义 |
|--------|------|
| missing_evaluate | 尚未完成评估 |
| corrupt_record | 记录损坏 |
| expired | 评估已过期 |
| mismatch | 与评估时不一致 |
| hard_block | 评估判定禁止发布 |
| not_recommended | Hard 或 Fact 未通过 |

Tool 层不单独拦截 Judge；在 Hard/Fact 通过且记录允许时，「带告警决策」分支仍可写入。

---

## 10. Tool 级策略与二次确认

通过环境变量 JSON 配置：批准 ID 有效期（默认 5 分钟）、评估门禁 TTL（默认 15 分钟）、各 Tool 的 log / deny / confirm。默认对 update_policy（局部更新并写入）与 reset_policy（重置为全局默认）要求 confirm。

confirm 流程：首次调用返回 needs_confirmation 及一次性批准 ID；编排方在用户确认后带批准 ID 重试。批准与「工具名 + 目标租户 + 操作摘要哈希」绑定，用过即删。更新与重置在 RAS 成功后再消费批准，避免先删后写失败。

重置策略不经过评估门禁。

**高危补丁**（影响确认文案）：清空全部保护规则、事实门禁改为开放模式、保护规则条数过少、清空某阶段禁止行为列表等。

---

## 11. Tool 契约摘要

| Tool 名 | 中文含义 | 输入要点 | 输出 / 副作用 |
|---------|----------|----------|----------------|
| diagnostic_status | 环境与 RAS 连通性诊断 | 无 | 环境配置指纹、RAS 健康、令牌角色与 scope 能力矩阵、管理员运营列表 |
| get_policy | 读取当前回复策略 | 租户、可选模块 | 版本号、策略 JSON、运营摘要 |
| validate_patch | 校验策略补丁（不写入） | 补丁、可选假设说明 | 是否合法、diff、策略对比 Markdown |
| resolve_recruiter_binding | 解析 BOSS 招聘账号与租户绑定 | 可选租户与账号名 | 解析结果 + 权限校验 |
| build_evaluate_cases | 拼装评估用例 | 至多 5 条用例、账号名 | 完整评估用例体 |
| submit_evaluate_policy_patch | 提交策略补丁双路评估 | 用例体 | 编排结构、评估摘要、写入门禁 |
| preview_policy_effect | 预览补丁对单条话术的影响 | 补丁、可选示例消息与账号名 | 话术与策略对比 Markdown |
| format_policy_preview | 格式化运营可读的对比与评估展示 | 预览/校验/评估片段 | 合并 Markdown（概览、对比、评估） |
| update_policy | 局部更新并写入回复策略 | 补丁、原因、可选批准 ID | 门禁 + 确认后写入 RAS |
| validate_policy | 校验完整策略草稿（不写入） | 完整策略对象 | 是否合法 |
| reset_policy | 重置租户策略为全局默认 | 基准版本、原因 | 确认后删除租户覆盖 |

策略与话术对比表格由呈现层统一生成，供 validate_patch、preview_policy_effect、format_policy_preview 复用。

---

## 12. 诊断与能力矩阵

diagnostic_status（环境与 RAS 连通性诊断）仅报告声明过的环境变量是否配置及 8 位指纹，不输出密钥明文。声明项包括 RAS 地址、令牌、超时、策略 JSON、预览账号 fallback 等。

由 scope 推导的能力：

| 能力 | 所需 scope |
|------|------------|
| 读策略 | reply-policy:read |
| 校验 | reply-policy:validate |
| 预览 | reply-policy:preview |
| 评估 | reply-policy:preview（与预览共用，实现上相同） |
| 写策略 | reply-policy:write |
| Judge | reply-policy:judge |

管理员令牌可拉取运营列表（租户 ID、展示名、是否有本地策略覆盖）；客户端令牌对列表探测返回无权限。

---

## 13. 环境与运行

| 变量 | 必填 | 说明 |
|------|------|------|
| REPLY_AUTHORITY_URL | 是 | RAS 基址 |
| REPLY_AUTHORITY_BEARER_TOKEN | 是 | 访问令牌 |
| REPLY_AUTHORITY_TIMEOUT_MS | 否 | 一般请求超时，默认 30 秒 |
| REPLY_AUTHORITY_EVALUATE_TIMEOUT_MS | 否 | 评估超时，默认 90 秒 |
| REPLY_POLICY_TUNER_POLICY_JSON | 否 | 批准 TTL、门禁 TTL、各 Tool 策略 |
| REPLY_POLICY_TUNER_EVALUATE_GATE_DIR | 否 | 评估门禁存储目录 |
| REPLY_POLICY_TUNER_APPROVAL_DIR | 否 | 批准记录目录 |
| REPLY_POLICY_TUNER_PREVIEW_RECRUITER_USERNAME | 否 | 绑定解析后备账号 |

进程入口为构建后的 dist 主文件，由 Roll 按包内启动配置拉起。

---

## 14. 测试

单元测试覆盖编排推导、门禁文案、策略摘要、对比表、高危补丁、Tool 策略等。可选联调测试在设置专用环境变量后对接真实 RAS。

---

## 15. 文档索引

| 文档 | 内容 |
|------|------|
| docs/design.md（本文） | 架构、RAS、门禁、Tool 契约 |
| SKILL.md | 编排门禁、运营话术、补丁影响面方法论 |
| references/orchestration.md | 上层步骤与反模式 |
| docs/ops-guide.md | 运营联调 |
| references/env.yaml | Roll 声明的环境变量子集 |

---

## 16. 实现约束

- Fact 硬阻断时，不得通过删除禁止项或放宽事实模式规避；应补充 RAS 侧门店证据或调整补丁与评估样本。
- 写入的补丁须与最近一次成功评估的补丁一致（同一摘要键）。
- submit_evaluate_policy_patch（提交双路评估）固定启用 Judge；令牌无 Judge 权限时由 RAS 拒绝，Agent 不擅自关闭。
- reset_policy（重置为全局默认）无评估前置；update_policy（局部更新并写入）同时具备评估门禁与默认 confirm 双层保护。
