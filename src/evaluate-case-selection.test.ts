import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  capCasesForFirstAttempt,
  degradeCasesForRetry,
  pickEvaluateCases,
} from "./evaluate-case-selection.ts";

type Case = { caseId: string; role: "primary" | "regression" };

function caseOf(caseId: string, role: Case["role"]): Case {
  return { caseId, role };
}

describe("pickEvaluateCases", () => {
  it("keeps 2 primary and 1 regression for default cap", () => {
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

  it("caps 4 cases to 2p+1r", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("p2", "primary"),
      caseOf("p3", "primary"),
      caseOf("r1", "regression"),
    ];
    const { cases, capped } = capCasesForFirstAttempt(input);
    assert.equal(capped, true);
    assert.equal(cases.length, 3);
    assert.deepEqual(
      cases.map((c) => c.caseId),
      ["p1", "p2", "r1"],
    );
  });
});

describe("degradeCasesForRetry", () => {
  it("returns undefined when already 1p+1r", () => {
    const input = [caseOf("p1", "primary"), caseOf("r1", "regression")];
    assert.equal(degradeCasesForRetry(input), undefined);
  });

  it("degrades 2p+1r to 1p+1r", () => {
    const input = [
      caseOf("p1", "primary"),
      caseOf("p2", "primary"),
      caseOf("r1", "regression"),
    ];
    const degraded = degradeCasesForRetry(input);
    assert.notEqual(degraded, undefined);
    assert.deepEqual(
      degraded!.map((c) => c.caseId),
      ["p1", "r1"],
    );
  });

  it("degrades 3 primary without dropping to two primaries only", () => {
    const input = [caseOf("p1", "primary"), caseOf("p2", "primary"), caseOf("p3", "primary")];
    const degraded = degradeCasesForRetry(input);
    assert.deepEqual(
      degraded!.map((c) => c.caseId),
      ["p1"],
    );
  });
});
