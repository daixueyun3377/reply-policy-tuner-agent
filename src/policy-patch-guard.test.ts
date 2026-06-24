import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPolicyPatchShape,
  getUnsupportedPolicyPatchPaths,
  validatePolicyPatchShape,
  PolicyPatchShapeError,
} from "./policy-patch-guard.ts";

describe("policy patch guard", () => {
  const unsupportedField = "unsupported_field";

  it("accepts known policy fields", () => {
    assert.doesNotThrow(() => {
      assertPolicyPatchShape({
        persona: { tone: "口语化" },
        hardConstraints: {
          rules: [{ id: "wechat-first", rule: "先回答问题，再引导加微信", severity: "high" }],
        },
        industryVoices: {
          retail: { name: "零售", guidance: ["先讲岗位亮点"] },
        },
      });
    });
  });

  it("rejects unknown top-level fields", () => {
    const errors = validatePolicyPatchShape({ [unsupportedField]: "strict" });

    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? "", /unsupported_field/);
    assert.match(errors[0] ?? "", /不要向用户展示/);
    assert.deepEqual(getUnsupportedPolicyPatchPaths({ [unsupportedField]: "strict" }), [
      unsupportedField,
    ]);
  });

  it("rejects unknown nested fields", () => {
    const errors = validatePolicyPatchShape({ persona: { [unsupportedField]: "strict" } });

    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? "", /persona\.unsupported_field/);
    assert.deepEqual(getUnsupportedPolicyPatchPaths({ persona: { [unsupportedField]: "strict" } }), [
      "persona.unsupported_field",
    ]);
  });

  it("rejects unknown fields inside arrays", () => {
    const patch = {
      hardConstraints: {
        rules: [{ id: "r1", rule: "test", severity: "high", [unsupportedField]: "strict" }],
      },
    };
    const errors = validatePolicyPatchShape(patch);

    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0] ?? "", /hardConstraints\.rules\.0\.unsupported_field/);
    assert.deepEqual(getUnsupportedPolicyPatchPaths(patch), [
      "hardConstraints.rules.0.unsupported_field",
    ]);
  });

  it("keeps invalid paths for internal troubleshooting", () => {
    assert.throws(
      () => assertPolicyPatchShape({ [unsupportedField]: "strict" }),
      (error: unknown) => {
        assert.ok(error instanceof PolicyPatchShapeError);
        assert.deepEqual(error.invalidPaths, [unsupportedField]);
        assert.doesNotMatch(error.message, /unsupported_field/);
        return true;
      },
    );
  });
});
