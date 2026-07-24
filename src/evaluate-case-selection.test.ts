import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capCasesForFirstAttempt,
  degradeCasesForRetry,
  pickEvaluateCases,
} from "./evaluate-case-selection.ts";

type Case = {
  caseId: string;
  role: "primary" | "regression";
  regressionScope?: "related" | "general";
};

function caseOf(
  caseId: string,
  role: Case["role"],
  regressionScope?: Case["regressionScope"],
): Case {
  return { caseId, role, ...(regressionScope !== undefined ? { regressionScope } : {}) };
}

describe("pickEvaluateCases", () => {
  it("respects explicit role limits", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("p2", "primary"),
      caseOf("p3", "primary"),
      caseOf("r1", "regression"),
    ];
    const picked = pickEvaluateCases(input, { maxTotal: 3, maxPrimary: 2, maxRegression: 1 });
    assert.deepEqual(
      picked.map((c) => c.caseId),
      ["p1", "p2", "r1"],
    );
  });
});

describe("capCasesForFirstAttempt", () => {
  it("does not cap when already within limit", () => {
    const input = [caseOf("p1", "primary"), caseOf("r1", "regression")];
    const { cases, capped } = capCasesForFirstAttempt(input);
    assert.equal(capped, false);
    assert.equal(cases.length, 2);
  });

  it("focuses multiple primary cases to 1p+2r", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("p2", "primary"),
      caseOf("p3", "primary"),
      caseOf("r1", "regression"),
      caseOf("r2", "regression"),
    ];
    const { cases, capped } = capCasesForFirstAttempt(input);
    assert.equal(capped, true);
    assert.equal(cases.length, 3);
    assert.deepEqual(
      cases.map((c) => c.caseId),
      ["p1", "r1", "r2"],
    );
  });

  it("keeps up to two regression cases", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("r1", "regression"),
      caseOf("r2", "regression"),
    ];
    const { cases, capped } = capCasesForFirstAttempt(input);
    assert.equal(capped, false);
    assert.deepEqual(
      cases.map((c) => c.caseId),
      ["p1", "r1", "r2"],
    );
  });

  it("caps regression cases beyond two", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("r1", "regression"),
      caseOf("r2", "regression"),
      caseOf("r3", "regression"),
    ];
    const { cases, capped } = capCasesForFirstAttempt(input);
    assert.equal(capped, true);
    assert.deepEqual(
      cases.map((c) => c.caseId),
      ["p1", "r1", "r2"],
    );
  });
});

describe("degradeCasesForRetry", () => {
  it("returns undefined when input cannot be reduced while retaining one regression", () => {
    const input = [caseOf("p1", "primary"), caseOf("r1", "regression")];
    assert.equal(degradeCasesForRetry(input), undefined);
  });

  it("drops one regression and retries with 1p+1r", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("r1", "regression"),
      caseOf("r2", "regression"),
    ];
    const degraded = degradeCasesForRetry(input);
    assert.notEqual(degraded, undefined);
    assert.deepEqual(
      degraded!.map((c) => c.caseId),
      ["p1", "r1"],
    );
  });

  it("keeps the related regression when the general case appears first", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("general", "regression", "general"),
      caseOf("related", "regression", "related"),
    ];
    const degraded = degradeCasesForRetry(input);
    assert.deepEqual(
      degraded!.map((c) => c.caseId),
      ["p1", "related"],
    );
  });

  it("degrades unexpected multiple primary input to the first target case", () => {
    const input = [caseOf("p1", "primary"), caseOf("p2", "primary"), caseOf("p3", "primary")];
    const degraded = degradeCasesForRetry(input);
    assert.deepEqual(
      degraded!.map((c) => c.caseId),
      ["p1"],
    );
  });
});
