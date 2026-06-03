import type { PolicyDiffEntry } from "../types/reply-policy.ts";
import { formatDiffValue, policyPathToLabel } from "./policy-path-labels.ts";

/**
 * 生成运营侧「策略对比」Markdown 表格（修改前 vs 修改后）。
 */
export function formatPolicyComparisonTable(
  rows: ReadonlyArray<{ readonly label: string; readonly before: string; readonly after: string }>,
): string {
  if (rows.length === 0) {
    return "（无可展示的策略差异）";
  }

  const header = "| 项目 | 修改前 | 修改后 |\n| --- | --- | --- |";
  const body = rows.map((row) => `| ${row.label} | ${row.before} | ${row.after} |`).join("\n");
  return `${header}\n${body}`;
}

/**
 * 从 API diff 生成策略对比行。
 */
export function buildPolicyComparisonRowsFromDiff(
  diff: ReadonlyArray<PolicyDiffEntry>,
): Array<{ label: string; before: string; after: string }> {
  return diff.map((entry) => ({
    label: policyPathToLabel(entry.path),
    before: formatDiffValue(entry.before),
    after: formatDiffValue(entry.after),
  }));
}

/**
 * 生成运营侧「话术对比」Markdown 表格。
 */
export function formatReplyComparisonTable(input: {
  readonly sampleMessage: string;
  readonly currentReply: string;
  readonly previewReply: string;
  readonly stage?: string;
}): string {
  const stageLine =
    input.stage !== undefined && input.stage.length > 0
      ? `\n\n> 识别阶段：${input.stage}`
      : "";

  return [
    `示例候选人消息：「${input.sampleMessage}」${stageLine}`,
    "",
    "| | 内容 |",
    "| --- | --- |",
    `| 修改前 | ${escapeTableCell(input.currentReply)} |`,
    `| 修改后 | ${escapeTableCell(input.previewReply)} |`,
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br/>");
}

/**
 * 从 patch 顶层键生成运营可读的策略对比行（仅展示 patch 触及的模块摘要；before 为占位符）。
 */
export function buildPolicyComparisonRowsFromPatch(patch: Record<string, unknown>): Array<{
  label: string;
  before: string;
  after: string;
}> {
  const rows: Array<{ label: string; before: string; after: string }> = [];

  const persona = patch["persona"];
  if (typeof persona === "object" && persona !== null) {
    for (const [key, value] of Object.entries(persona as Record<string, unknown>)) {
      if (typeof value === "string") {
        rows.push({
          label: personaFieldLabel(key),
          before: "（当前值，见 get_policy）",
          after: value,
        });
      }
    }
  }

  const factGate = patch["factGate"];
  if (typeof factGate === "object" && factGate !== null) {
    const mode = (factGate as Record<string, unknown>)["mode"];
    if (typeof mode === "string") {
      rows.push({
        label: "事实核查模式",
        before: "（当前值，见 get_policy）",
        after: mode,
      });
    }
  }

  return rows;
}

function personaFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    tone: "语气风格",
    warmth: "热情程度",
    humor: "幽默感",
    length: "回复长度",
    questionStyle: "提问方式",
    empathyStrategy: "共情策略",
    addressStyle: "称呼方式",
    professionalIdentity: "身份定位",
    companyBackground: "公司背景",
  };
  return labels[key] ?? key;
}
