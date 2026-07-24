import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveEvaluationGateDecision,
  deriveEvaluationOrchestration,
} from "./evaluation-orchestration.ts";
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
    assert.match(orch.guidance, /确认保存/);
    assert.doesNotMatch(orch.guidance, /点击|按钮|审批/);
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
    assert.match(orch.guidance, /确认保存/);
    assert.doesNotMatch(orch.guidance, /点击|按钮|审批/);
  });

  it("does not block historical location and salary regression issues", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 3,
          primaryCases: 1,
          regressionCases: 2,
          draftFailures: 2,
          regressionWarnings: 2,
          hardRecommendedForPublish: false,
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
            caseId: "location-regression",
            role: "regression",
            base: {
              suggestedReply: "旧回复",
              stage: "trust",
              gateViolations: ["历史违规"],
            },
            draft: {
              suggestedReply: "新回复",
              stage: "trust",
              gateViolations: ["历史违规"],
            },
            comparison: { draftIntroducedGateViolations: false },
            factVerification: {
              base: {
                blockingIssues: [{ code: "missing_location", claim: "附近门店" }],
                nonBlockingIssues: [],
              },
              draft: {
                blockingIssues: [{ code: "missing_location", claim: "附近有哪些门店" }],
                nonBlockingIssues: [],
              },
            },
          },
          {
            caseId: "salary-regression",
            role: "regression",
            base: {
              suggestedReply: "旧薪资回复",
              stage: "trust",
              gateViolations: ["audit_tone"],
            },
            draft: {
              suggestedReply: "新薪资回复",
              stage: "trust",
              gateViolations: ["audit_tone"],
            },
            comparison: { draftIntroducedGateViolations: false },
            factVerification: {
              base: {
                blockingIssues: [{ code: "contradicted_salary", claim: "固定薪资 6000 元" }],
                nonBlockingIssues: [],
              },
              draft: {
                blockingIssues: [{ code: "contradicted_salary", claim: "薪资是 6000 元" }],
                nonBlockingIssues: [],
              },
            },
          },
        ],
      }),
    );

    assert.equal(orch.action, "ready_to_publish");
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.mandatoryPublishReady, true);
    assert.match(orch.guidance, /历史已有问题/);
  });

  it("does not block historical issues in the target primary case", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 1,
          primaryCases: 1,
          regressionCases: 0,
          draftFailures: 1,
          regressionWarnings: 0,
          hardRecommendedForPublish: false,
          factRecommendedForPublish: false,
          judgeRecommendedForPublish: true,
          recommendedForPublish: false,
        },
        cases: [
          {
            caseId: "requested-tone",
            role: "primary",
            base: {
              suggestedReply: "旧语气",
              stage: "trust",
              gateViolations: ["audit_tone"],
            },
            draft: {
              suggestedReply: "新语气",
              stage: "trust",
              gateViolations: ["audit_tone"],
            },
            comparison: { draftIntroducedGateViolations: false },
            factVerification: {
              base: {
                blockingIssues: [{ code: "contradicted_location", claim: "浦东有岗" }],
                nonBlockingIssues: [],
              },
              draft: {
                blockingIssues: [{ code: "contradicted_location", claim: "浦东这边有岗" }],
                nonBlockingIssues: [],
              },
            },
          },
        ],
      }),
    );

    assert.equal(orch.action, "ready_to_publish");
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.mandatoryPublishReady, true);
  });

  it("blocks issues newly introduced by the patch in regression cases", () => {
    const orch = deriveEvaluationOrchestration(
      baseEvaluate({
        summary: {
          totalCases: 2,
          primaryCases: 1,
          regressionCases: 1,
          draftFailures: 1,
          regressionWarnings: 1,
          hardRecommendedForPublish: false,
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
            caseId: "regression-001",
            role: "regression",
            base: { suggestedReply: "旧回复", stage: "trust" },
            draft: {
              suggestedReply: "新回复",
              stage: "trust",
              gateViolations: ["新增违规"],
            },
            comparison: { draftIntroducedGateViolations: true },
            factVerification: {
              base: { blockingIssues: [], nonBlockingIssues: [] },
              draft: {
                blockingIssues: [{ code: "contradicted_location", claim: "全国有门店" }],
                nonBlockingIssues: [],
              },
            },
          },
        ],
      }),
    );

    assert.equal(orch.action, "rollback_to_propose");
    assert.equal(orch.publishBlocked, true);
    assert.equal(orch.mandatoryPublishReady, false);
  });

  it("warns instead of blocking for new fact issues in general regression cases", () => {
    const data = baseEvaluate({
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
          base: { suggestedReply: "旧语气", stage: "trust" },
          draft: { suggestedReply: "新语气", stage: "trust" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
        {
          caseId: "regression-location",
          role: "regression",
          base: { suggestedReply: "你想了解哪个区域？", stage: "job" },
          draft: { suggestedReply: "目前咱们门店分布挺广的", stage: "job" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: {
              blockingIssues: [
                { code: "unsupported_location", claim: "门店分布挺广" },
              ],
              nonBlockingIssues: [],
            },
          },
        },
      ],
    });
    const options = {
      generalRegressionCaseIds: new Set(["regression-location"]),
    };
    const decision = deriveEvaluationGateDecision(data, options);
    const orch = deriveEvaluationOrchestration(data, options);

    assert.equal(decision.factBlocked, false);
    assert.equal(decision.advisoryFactIssues, 1);
    assert.equal(orch.publishBlocked, false);
    assert.equal(orch.action, "ready_to_publish");
    assert.match(orch.guidance, /通用回归事实告警/);
  });

  it("still blocks new hard violations in general regression cases", () => {
    const data = baseEvaluate({
      summary: {
        totalCases: 2,
        primaryCases: 1,
        regressionCases: 1,
        draftFailures: 1,
        regressionWarnings: 1,
        hardRecommendedForPublish: false,
        factRecommendedForPublish: true,
        judgeRecommendedForPublish: true,
        recommendedForPublish: false,
      },
      cases: [
        {
          caseId: "main-001",
          role: "primary",
          base: { suggestedReply: "旧语气", stage: "trust" },
          draft: { suggestedReply: "新语气", stage: "trust" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
        {
          caseId: "regression-location",
          role: "regression",
          base: { suggestedReply: "旧回复", stage: "job" },
          draft: {
            suggestedReply: "新回复",
            stage: "job",
            gateViolations: ["泄露隐私信息"],
          },
          comparison: { draftIntroducedGateViolations: true },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
      ],
    });
    const orch = deriveEvaluationOrchestration(data, {
      generalRegressionCaseIds: new Set(["regression-location"]),
    });

    assert.equal(orch.publishBlocked, true);
    assert.equal(orch.action, "rollback_to_propose");
  });
});
