import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PREVIEW_CONFIRMATION_PROMPT } from "./format-policy-preview.ts";
import { UPDATE_POLICY_CONFIRMATION_MESSAGE } from "./update-policy.ts";

describe("text confirmation prompts", () => {
  it("asks for an explicit evaluation reply without button language", () => {
    assert.match(PREVIEW_CONFIRMATION_PROMPT, /确认评估/);
    assert.doesNotMatch(PREVIEW_CONFIRMATION_PROMPT, /点击|按钮|审批/);
  });

  it("asks for an explicit save reply without button language", () => {
    assert.match(UPDATE_POLICY_CONFIRMATION_MESSAGE, /确认保存/);
    assert.match(UPDATE_POLICY_CONFIRMATION_MESSAGE, /取消/);
    assert.doesNotMatch(UPDATE_POLICY_CONFIRMATION_MESSAGE, /点击|按钮|审批/);
  });
});
