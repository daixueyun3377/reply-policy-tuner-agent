import type { EvaluationOrchestrationAction } from "./presentation/evaluation-orchestration.ts";

export type EvaluatePublishGateBlockReason =
  | "missing_evaluate"
  | "corrupt_record"
  | "expired"
  | "mismatch"
  | "hard_block"
  | "not_recommended";

export function buildEvaluatePublishGateUserMessage(input: {
  reason: EvaluatePublishGateBlockReason;
  orchestrationAction?: EvaluationOrchestrationAction;
}): string {
  switch (input.reason) {
    case "missing_evaluate":
      return "这次修改还没有完成评估，暂时不能保存。请先完成「策略评估」，评估通过后再确认写入。";
    case "corrupt_record":
      return "评估记录异常，请重新做一次完整评估后再保存。";
    case "expired":
      return "之前的评估结果已过期，请重新评估一次；通过后再确认保存。";
    case "mismatch":
      return "当前要保存的内容和刚才评估时不一致。请用同一套修改重新评估，通过后再保存。";
    case "hard_block":
      return "这次改动还没通过安全评估，暂时不能写入。评估中发现了必须修正的问题（例如违反硬性规则，或回复内容与事实不符），请先调整修改方案并重新评估。";
    case "not_recommended":
      return "这次改动还没通过硬性安全校验或事实核对，暂时不能写入。请先根据评估结果调整修改方案，重新评估通过后再保存。";
  }
}
