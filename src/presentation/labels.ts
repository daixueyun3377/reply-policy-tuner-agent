export const PERSONA_LENGTH_LABELS: Record<string, string> = {
  short: "简短（1-2句为主）",
  medium: "中等",
  long: "较长",
};

export const FACT_GATE_MODE_LABELS: Record<string, string> = {
  strict: "严格模式",
  balanced: "平衡模式",
  open: "开放模式",
};

export const STAGE_LABELS: Record<string, string> = {
  trust_building: "初次接触",
  private_channel: "加微信",
  qualify_candidate: "确认资格",
  job_consultation: "岗位咨询",
  interview_scheduling: "约面试",
  onboard_followup: "入职跟进",
};

export function labelOrRaw(value: string, labels: Record<string, string>): string {
  return labels[value] ?? value;
}
