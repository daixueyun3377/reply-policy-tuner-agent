import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPolicyPatchRecovery } from "./policy-patch-recovery.ts";

describe("policy patch recovery", () => {
  it("maps tone requests to a supported suggested patch", () => {
    const recovery = buildPolicyPatchRecovery("回复语气更口语化一点");

    assert.equal(recovery.nextAction, "retry_with_suggested_patch");
    assert.deepEqual(recovery.suggestedPatch, {
      persona: {
        tone: "按用户目标调整回复语气：回复语气更口语化一点",
      },
    });
    assert.match(recovery.userFacingPlan, /调整回复语气/);
    assert.doesNotMatch(recovery.userFacingPlan, /persona|tone|unsupported_field/);
  });

  it("maps question requests to a supported suggested patch", () => {
    const recovery = buildPolicyPatchRecovery("不要重复问候选人已经说过的信息");

    assert.equal(recovery.nextAction, "retry_with_suggested_patch");
    assert.deepEqual(recovery.suggestedPatch, {
      persona: {
        questionStyle: "按用户目标调整提问方式：不要重复问候选人已经说过的信息",
      },
    });
  });

  it("asks the agent to rewrite when no safe mapping is known", () => {
    const recovery = buildPolicyPatchRecovery("优化审核判断标准");

    assert.equal(recovery.nextAction, "rewrite_patch_from_user_request");
    assert.equal(recovery.suggestedPatch, undefined);
    assert.match(recovery.agentInstruction, /重新生成/);
    assert.doesNotMatch(recovery.userFacingPlan, /JSON|字段|schema/);
  });
});
