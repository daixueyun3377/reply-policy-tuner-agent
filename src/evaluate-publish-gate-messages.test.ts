import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvaluatePublishGateUserMessage } from "./evaluate-publish-gate-messages.ts";

describe("evaluate publish gate user messages", () => {
  it("uses operational language for hard block", () => {
    const message = buildEvaluatePublishGateUserMessage({ reason: "hard_block" });
    assert.match(message, /安全评估|暂时不能写入/);
    assert.doesNotMatch(message, /orchestration|publishBlocked|recommendedForPublish/i);
  });

  it("uses operational language when mandatory gates fail", () => {
    const message = buildEvaluatePublishGateUserMessage({ reason: "not_recommended" });
    assert.match(message, /硬性安全校验|事实核对/);
  });
});
