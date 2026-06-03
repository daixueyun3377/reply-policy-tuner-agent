const PATH_LABELS: Record<string, string> = {
  "persona.tone": "语气风格",
  "persona.warmth": "热情程度",
  "persona.humor": "幽默感",
  "persona.length": "回复长度",
  "persona.questionStyle": "提问方式",
  "persona.empathyStrategy": "共情策略",
  "persona.addressStyle": "称呼方式",
  "persona.professionalIdentity": "身份定位",
  "persona.companyBackground": "公司背景",
  "factGate.mode": "事实核查模式",
  "factGate.fallbackBehavior": "事实缺失兜底",
  "defaultIndustryVoiceId": "默认行业话术",
};

const STAGE_LABELS: Record<string, string> = {
  trust_building: "初次接触阶段",
  private_channel: "加微信阶段",
  qualify_candidate: "确认资格阶段",
  job_consultation: "岗位咨询阶段",
  interview_scheduling: "约面试阶段",
  onboard_followup: "入职跟进阶段",
};

export function policyPathToLabel(path: string): string {
  const direct = PATH_LABELS[path];
  if (direct !== undefined) {
    return direct;
  }

  const stageMatch = /^stageGoals\.([^.]+)\.(.+)$/.exec(path);
  if (stageMatch !== null && stageMatch[1] !== undefined && stageMatch[2] !== undefined) {
    const stageKey = stageMatch[1];
    const field = stageMatch[2];
    const stageLabel = STAGE_LABELS[stageKey] ?? stageKey;
    const fieldLabel =
      field === "primaryGoal"
        ? "主要目标"
        : field === "successCriteria"
          ? "成功标准"
          : field === "ctaStrategy"
            ? "推进策略"
            : field === "disallowedActions"
              ? "禁止行为"
              : field;
    return `${stageLabel} · ${fieldLabel}`;
  }

  if (path.startsWith("hardConstraints.rules")) {
    return "保护规则";
  }

  if (path.startsWith("industryVoices")) {
    return "行业话术";
  }

  return path;
}

export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "（空）";
  }

  if (typeof value === "string") {
    return value.length > 0 ? value : "（空）";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return value.join("；");
    }
    return JSON.stringify(value);
  }

  return JSON.stringify(value);
}
