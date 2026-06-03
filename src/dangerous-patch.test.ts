import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeDangerousPatchReason, isDangerousPolicyPatch } from "./dangerous-patch.ts";

describe("dangerous policy patch detection", () => {
  it("flags empty hardConstraints.rules", () => {
    assert.equal(isDangerousPolicyPatch({ hardConstraints: { rules: [] } }), true);
    assert.match(describeDangerousPatchReason({ hardConstraints: { rules: [] } }), /保护规则/);
  });

  it("flags factGate.mode open", () => {
    assert.equal(isDangerousPolicyPatch({ factGate: { mode: "open" } }), true);
  });

  it("flags very few protection rules", () => {
    assert.equal(
      isDangerousPolicyPatch({
        hardConstraints: { rules: [{ id: "r1", rule: "test", severity: "high" }] },
      }),
      true,
    );
  });

  it("allows benign persona patch", () => {
    assert.equal(
      isDangerousPolicyPatch({
        persona: { questionStyle: "单轮只问一个最关键的问题" },
      }),
      false,
    );
  });
});
