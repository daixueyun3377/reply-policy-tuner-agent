import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEvaluationSummaryMarkdown } from "./evaluation-summary.ts";
import type { EvaluatePatchResponse } from "../types/reply-policy.ts";

describe("formatEvaluationSummaryMarkdown", () => {
  it("formats publish recommendation and case details", () => {
    const data: EvaluatePatchResponse = {
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:global-file:abc",
      draftPolicyVersion: "tenant-a:draft:def",
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
      },
      cases: [
        {
          caseId: "main-001",
          role: "primary",
          base: { suggestedReply: "回复 A", stage: "trust_building" },
          draft: { suggestedReply: "回复 B", stage: "trust_building" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
      ],
      warnings: [],
    };

    const markdown = formatEvaluationSummaryMarkdown(data);
    assert.match(markdown, /ready_to_publish|可进入 Decide/);
    assert.match(markdown, /本次目标样本/);
    assert.match(markdown, /回复 A/);
    assert.match(markdown, /回复 B/);
  });

  it("labels unchanged target-case failures as historical warnings", () => {
    const historicalIssue = { code: "missing_location", claim: "附近门店" };
    const data: EvaluatePatchResponse = {
      tenantId: "tenant-a",
      basePolicyVersion: "v1",
      draftPolicyVersion: "v2",
      summary: {
        totalCases: 1,
        primaryCases: 1,
        regressionCases: 0,
        draftFailures: 1,
        regressionWarnings: 1,
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
            suggestedReply: "旧回复",
            stage: "trust_building",
            gateViolations: ["历史违规"],
          },
          draft: {
            suggestedReply: "新回复",
            stage: "trust_building",
            gateViolations: ["历史违规"],
          },
          comparison: { draftIntroducedGateViolations: false },
          factVerification: {
            base: { blockingIssues: [historicalIssue], nonBlockingIssues: [] },
            draft: {
              blockingIssues: [{ code: "missing_location", claim: "附近有哪些门店" }],
              nonBlockingIssues: [],
            },
          },
        },
      ],
      warnings: [],
    };

    const markdown = formatEvaluationSummaryMarkdown(data);
    assert.match(markdown, /本次修改未新增阻塞问题/);
    assert.match(markdown, /本次目标样本/);
    assert.match(markdown, /本次新增 Hard Gate 违规：无/);
    assert.match(markdown, /历史已有 Hard Gate 违规：历史违规/);
    assert.match(markdown, /历史已有事实阻塞：missing_location/);
  });

  it("labels new general regression fact issues as non-blocking warnings", () => {
    const data: EvaluatePatchResponse = {
      tenantId: "tenant-a",
      basePolicyVersion: "v1",
      draftPolicyVersion: "v2",
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
          caseId: "requested-tone",
          role: "primary",
          base: { suggestedReply: "旧语气", stage: "trust_building" },
          draft: { suggestedReply: "新语气", stage: "trust_building" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
        {
          caseId: "regression-location",
          role: "regression",
          base: { suggestedReply: "你想了解哪个区域？", stage: "job_consultation" },
          draft: { suggestedReply: "目前咱们门店分布挺广的", stage: "job_consultation" },
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
      warnings: [],
    };

    const markdown = formatEvaluationSummaryMarkdown(data, {
      generalRegressionCaseIds: new Set(["regression-location"]),
    });
    assert.match(markdown, /本次修改未新增阻塞问题/);
    assert.match(markdown, /通用回归样本（事实仅告警）/);
    assert.match(markdown, /通用回归新增事实告警（不阻塞）：unsupported_location/);
  });
});
