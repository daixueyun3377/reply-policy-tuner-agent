export const PATCH_RECOVERY_NEXT_ACTIONS = [
  "retry_with_suggested_patch",
  "rewrite_patch_from_user_request",
] as const;

export type PatchRecoveryNextAction = (typeof PATCH_RECOVERY_NEXT_ACTIONS)[number];

export type PolicyPatchRecovery = {
  recoverable: true;
  nextAction: PatchRecoveryNextAction;
  agentInstruction: string;
  userFacingPlan: string;
  suggestedPatch?: Record<string, unknown>;
};

export function buildPolicyPatchRecovery(userRequest: string): PolicyPatchRecovery {
  const suggestedPatch = buildSuggestedPatch(userRequest);

  if (suggestedPatch !== undefined) {
    return {
      recoverable: true,
      nextAction: "retry_with_suggested_patch",
      agentInstruction:
        "内部生成的修改方案包含当前策略里没有的配置项。不要向用户展示内部失败原因或策略字段名；请直接使用 suggestedPatch 重新调用 validate_patch。",
      userFacingPlan: buildUserFacingPlan(userRequest),
      suggestedPatch,
    };
  }

  return {
    recoverable: true,
    nextAction: "rewrite_patch_from_user_request",
    agentInstruction:
      "内部生成的修改方案包含当前策略里没有的配置项。不要向用户展示内部失败原因或策略字段名；请根据 userRequest 重新生成只修改现有策略项的最小 patch，再调用 validate_patch。",
    userFacingPlan:
      "我会按你的目标重新整理一个更贴近现有策略能力的修改方案，再继续预览和评估。",
  };
}

function buildSuggestedPatch(userRequest: string): Record<string, unknown> | undefined {
  const text = userRequest.toLowerCase();

  if (matches(text, ["语气", "口语", "口吻", "自然", "亲和", "温和", "强硬", "正式", "冷淡"])) {
    return {
      persona: {
        tone: summarizeToneGoal(userRequest),
      },
    };
  }

  if (matches(text, ["提问", "问题", "追问", "反问", "问太多", "重复问"])) {
    return {
      persona: {
        questionStyle: summarizeQuestionGoal(userRequest),
      },
    };
  }

  if (matches(text, ["简短", "短一点", "太长", "长一点", "详细", "篇幅", "字数"])) {
    return {
      persona: {
        length: summarizeLengthGoal(text),
      },
    };
  }

  if (matches(text, ["称呼", "叫法", "称谓"])) {
    return {
      persona: {
        addressStyle: "按用户偏好调整称呼方式，保持自然礼貌，不使用让候选人不舒服的称谓",
      },
    };
  }

  if (matches(text, ["共情", "理解", "安慰", "关心", "体谅"])) {
    return {
      persona: {
        empathyStrategy: "先回应候选人的感受和顾虑，再给出清晰建议，避免机械式推进",
      },
    };
  }

  if (matches(text, ["微信", "加微", "加微信", "私域", "联系方式"])) {
    return {
      stageGoals: {
        private_channel: {
          ctaStrategy: "先回答候选人的问题，再自然说明加微信便于继续沟通，不强行打断当前问题",
        },
      },
    };
  }

  return undefined;
}

function buildUserFacingPlan(userRequest: string): string {
  const text = userRequest.toLowerCase();

  if (matches(text, ["语气", "口语", "口吻", "自然", "亲和", "温和", "强硬", "正式", "冷淡"])) {
    return "我会按你的目标调整回复语气，先看一条预览效果。";
  }
  if (matches(text, ["提问", "问题", "追问", "反问", "问太多", "重复问"])) {
    return "我会按你的目标调整提问方式，先看一条预览效果。";
  }
  if (matches(text, ["简短", "短一点", "太长", "长一点", "详细", "篇幅", "字数"])) {
    return "我会按你的目标调整回复长度，先看一条预览效果。";
  }
  if (matches(text, ["称呼", "叫法", "称谓"])) {
    return "我会按你的目标调整称呼方式，先看一条预览效果。";
  }
  if (matches(text, ["共情", "理解", "安慰", "关心", "体谅"])) {
    return "我会按你的目标调整共情方式，先看一条预览效果。";
  }
  if (matches(text, ["微信", "加微", "加微信", "私域", "联系方式"])) {
    return "我会按你的目标调整引导加微信的方式，先看一条预览效果。";
  }

  return "我会按你的目标重新整理一个更贴近现有策略能力的修改方案，再继续预览和评估。";
}

function summarizeToneGoal(userRequest: string): string {
  return `按用户目标调整回复语气：${userRequest}`;
}

function summarizeQuestionGoal(userRequest: string): string {
  return `按用户目标调整提问方式：${userRequest}`;
}

function summarizeLengthGoal(text: string): "short" | "medium" | "long" {
  if (matches(text, ["简短", "短一点", "太长", "精简"])) {
    return "short";
  }
  if (matches(text, ["长一点", "详细", "展开"])) {
    return "long";
  }
  return "medium";
}

function matches(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}
