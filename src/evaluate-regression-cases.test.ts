import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendSystemRegressionCases } from "./evaluate-regression-cases.ts";

describe("appendSystemRegressionCases", () => {
  it("adds one system fact boundary smoke regression for primary-only input", () => {
    const cases = appendSystemRegressionCases([
      { caseId: "p1", role: "primary", candidateMessage: "称呼我为同学" },
    ]);

    assert.deepEqual(
      cases.map((item) => item.caseId),
      ["p1", "regression-fact-boundary-smoke-001"],
    );
  });

  it("keeps user cases and adds the fact boundary smoke when no fact safety regression exists", () => {
    const cases = appendSystemRegressionCases([
      { caseId: "p1", role: "primary", candidateMessage: "称呼我为同学" },
      { caseId: "r-user", role: "regression", candidateMessage: "真实问法" },
    ]);

    assert.deepEqual(
      cases.map((item) => item.caseId),
      ["p1", "r-user", "regression-fact-boundary-smoke-001"],
    );
  });

  it("does not add a system smoke when the caller already supplied fact safety regression", () => {
    const cases = appendSystemRegressionCases([
      { caseId: "p1", role: "primary", candidateMessage: "称呼我为同学" },
      {
        caseId: "r-fact",
        role: "regression",
        candidateMessage: "真实事实风险问法",
        tags: ["regression", "safety", "fact"],
      },
    ]);

    assert.deepEqual(
      cases.map((item) => item.caseId),
      ["p1", "r-fact"],
    );
  });

  it("throws when no primary case exists", () => {
    assert.throws(
      () =>
        appendSystemRegressionCases([
          { caseId: "r1", role: "regression", candidateMessage: "你好" },
        ]),
      /至少需要 1 个 primary/,
    );
  });
});
