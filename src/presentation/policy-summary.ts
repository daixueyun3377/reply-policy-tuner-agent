import { STAGE_KEYS } from "../types/reply-policy.ts";
import {
  FACT_GATE_MODE_LABELS,
  PERSONA_LENGTH_LABELS,
  STAGE_LABELS,
  labelOrRaw,
} from "./labels.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 将策略 JSON 转为运营可读的要点（人设、阶段策略、保护规则等；不含版本号与 JSON 字段名）。
 */
export function summarizePolicyForOperator(
  policy: Record<string, unknown>,
  warnings: readonly string[] = [],
): string {
  const lines: string[] = [];
  const persona = asRecord(policy["persona"]);

  if (persona !== undefined) {
    lines.push("【回复人设】");
    const tone = readString(persona, "tone");
    if (tone !== undefined) {
      lines.push(`· 语气：${tone}`);
    }
    const warmth = readString(persona, "warmth");
    if (warmth !== undefined) {
      lines.push(`· 热情程度：${warmth}`);
    }
    const humor = readString(persona, "humor");
    if (humor !== undefined) {
      lines.push(`· 幽默感：${humor}`);
    }
    const length = readString(persona, "length");
    if (length !== undefined) {
      lines.push(`· 回复长度：${labelOrRaw(length, PERSONA_LENGTH_LABELS)}`);
    }
    const questionStyle = readString(persona, "questionStyle");
    if (questionStyle !== undefined) {
      lines.push(`· 提问方式：${questionStyle}`);
    }
    const empathyStrategy = readString(persona, "empathyStrategy");
    if (empathyStrategy !== undefined) {
      lines.push(`· 共情策略：${empathyStrategy}`);
    }
    const addressStyle = readString(persona, "addressStyle");
    if (addressStyle !== undefined) {
      lines.push(`· 称呼：${addressStyle}`);
    }
    const professionalIdentity = readString(persona, "professionalIdentity");
    if (professionalIdentity !== undefined) {
      lines.push(`· 身份定位：${professionalIdentity}`);
    }
  }

  const stageGoals = asRecord(policy["stageGoals"]);
  if (stageGoals !== undefined) {
    const stageLines: string[] = [];
    for (const stageKey of STAGE_KEYS) {
      const stage = asRecord(stageGoals[stageKey]);
      const ctaStrategy = readString(stage, "ctaStrategy");
      if (ctaStrategy === undefined) {
        continue;
      }
      stageLines.push(`· ${labelOrRaw(stageKey, STAGE_LABELS)}：${ctaStrategy}`);
    }
    if (stageLines.length > 0) {
      lines.push("");
      lines.push("【阶段策略】");
      lines.push(...stageLines);
    }
  }

  const hardConstraints = asRecord(policy["hardConstraints"]);
  const rules = hardConstraints?.["rules"];
  if (Array.isArray(rules)) {
    lines.push("");
    lines.push(`【保护规则】${String(rules.length)} 条`);
    for (const rule of rules.slice(0, 5)) {
      const ruleRecord = asRecord(rule);
      const text = readString(ruleRecord, "rule");
      if (text !== undefined) {
        lines.push(`· ${text}`);
      }
    }
    if (rules.length > 5) {
      lines.push(`· … 另有 ${String(rules.length - 5)} 条`);
    }
  }

  const factGate = asRecord(policy["factGate"]);
  const mode = readString(factGate, "mode");
  if (mode !== undefined) {
    lines.push("");
    lines.push(`【事实核查】${labelOrRaw(mode, FACT_GATE_MODE_LABELS)}`);
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("【提示】");
    for (const warning of warnings) {
      lines.push(`· ${warning}`);
    }
  }

  return lines.join("\n");
}
