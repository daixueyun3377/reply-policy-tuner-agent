import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDiffValue, policyPathToLabel } from "./policy-path-labels.ts";

describe("policy path labels", () => {
  it("maps known persona paths", () => {
    assert.equal(policyPathToLabel("persona.tone"), "语气风格");
    assert.equal(policyPathToLabel("persona.questionStyle"), "提问方式");
  });

  it("maps stage goal paths", () => {
    assert.match(policyPathToLabel("stageGoals.trust_building.primaryGoal"), /初次接触阶段/);
  });

  it("formats diff values", () => {
    assert.equal(formatDiffValue("hello"), "hello");
    assert.equal(formatDiffValue(["a", "b"]), "a；b");
    assert.equal(formatDiffValue(null), "（空）");
  });
});
