import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveEvaluationOrchestration } from "./evaluation-orchestration.ts";
import type { EvaluatePatchResponse } from "../types/reply-policy.ts";

function baseEvaluate(overrides: {
  summary?: Partial<EvaluatePatchResponse["summary"]>;
  cases?: EvaluatePatchResponse["cases"];
}): EvaluatePatchResponse {
  return {
    tenantId: "tenant-a",
    basePolicyVersion: "v1",
    draftPolicyVersion: "v2",
    summary: {
      totalCases: 1,
      primaryCases: 1,
      regressionCases: 0,
      draftFailures: 0,
      regressionWarnings: 0,
      hardRecommendedForPublish: true,
      factRecommendedForPublish: true,
      judgeRecommendedForPublish: true,
      recommendedForPublish: true,
      ...overrides.summary,
    },
    cases: overrides.cases ?? [
      {
        caseId: "main-001",
        role: "primary",
        base: { suggestedReply: "A", stage: "trust" },
        draft: { suggestedReply: "B", stage: "trust" },
        factVerification: {
          base: { blockingIssues: [], nonBlockingIssues: [] },
          draft: { blockingIssues: [], nonBlockingIssues: [] },
        },
      },
    ],
    warnings: [],
  };
}

describe("deriveEvaluationOrchestration", () => {
  it("returns ready_to_publish when all gates pass", () => {
    const orch = deriveEvaluationOrchestration(baseEvaluate({}));
    assert.equal(orch.action, "ready_to_publish");
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.mandatoryPublishReady, true);
    assert.equal(orch.judgeAdvisoryOnly, false);
    assert.equal(orch.requiresExplicitPublishConfirmation, true);
  });

  it("returns rollback_to_propose when hard gate fails", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 1,
          primaryCases: 1,
          regressionCases: 0,
          draftFailures: 0,
          regressionWarnings: 0,
          hardRecommendedForPublish: false,
          factRecommendedForPublish: true,
          judgeRecommendedForPublish: true,
          recommendedForPublish: false,
        },
      }),
    );
    assert.equal(orch.action, "rollback_to_propose");
    assert.equal(orch.publishBlocked, true);
    assert.equal(orch.requiresExplicitPublishConfirmation, false);
  });

  it("returns rollback_to_propose when fact blocking issues exist", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 1,
          primaryCases: 1,
          regressionCases: 0,
          draftFailures: 0,
          regressionWarnings: 0,
          hardRecommendedForPublish: true,
          factRecommendedForPublish: false,
          judgeRecommendedForPublish: true,
          recommendedForPublish: false,
        },
        cases: [
          {
            caseId: "main-001",
            role: "primary",
            base: { suggestedReply: "A", stage: "trust" },
            draft: { suggestedReply: "B", stage: "trust" },
            factVerification: {
              base: { blockingIssues: [], nonBlockingIssues: [] },
              draft: {
                blockingIssues: [{ code: "contradicted_salary", claim: "6000" }],
                nonBlockingIssues: [],
              },
            },
          },
        ],
      }),
    );
    assert.equal(orch.action, "rollback_to_propose");
    assert.equal(orch.publishBlocked, true);
    assert.match(orch.guidance, /factGate\.forbiddenWhenMissingFacts/);
    assert.match(orch.guidance, /patch 完全一致/);
  });

  it("returns decide_with_warnings when only advisory regression fact blocking exists", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 2,
          primaryCases: 1,
          regressionCases: 1,
          draftFailures: 1,
          regressionWarnings: 1,
          hardRecommendedForPublish: true,
          factRecommendedForPublish: false,
          judgeRecommendedForPublish: true,
          recommendedForPublish: false,
        },
        cases: [
          {
            caseId: "main-001",
            role: "primary",
            base: { suggestedReply: "A", stage: "trust" },
            draft: { suggestedReply: "B", stage: "trust" },
            factVerification: {
              base: { blockingIssues: [], nonBlockingIssues: [] },
              draft: { blockingIssues: [], nonBlockingIssues: [] },
            },
          },
          {
            caseId: "regression-fact-boundary-smoke-001",
            role: "regression",
            base: { suggestedReply: "A", stage: "trust" },
            draft: { suggestedReply: "B", stage: "trust" },
            factVerification: {
              base: { blockingIssues: [], nonBlockingIssues: [] },
              draft: {
                blockingIssues: [{ code: "missing_location_fact", claim: "在徐汇上班" }],
                nonBlockingIssues: [],
              },
            },
          },
        ],
      }),
      { advisoryCaseIds: ["regression-fact-boundary-smoke-001"] },
    );
    assert.equal(orch.action, "decide_with_warnings");
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.mandatoryPublishReady, true);
    assert.equal(orch.requiresExplicitPublishConfirmation, true);
    assert.match(orch.guidance, /系统自动回归样本/);
  });

  it("returns decide_with_warnings when only judge fails", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 2,
          primaryCases: 1,
          regressionCases: 1,
          draftFailures: 0,
          regressionWarnings: 1,
          hardRecommendedForPublish: true,
          factRecommendedForPublish: true,
          judgeRecommendedForPublish: false,
          recommendedForPublish: false,
        },
      }),
    );
    assert.equal(orch.action, "decide_with_warnings");
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.judgeAdvisoryOnly, true);
    assert.equal(orch.requiresExplicitPublishConfirmation, true);
  });
});
