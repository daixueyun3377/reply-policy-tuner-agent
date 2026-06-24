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
        totalCases: 2,
        primaryCases: 1,
        regressionCases: 1,
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
    assert.match(markdown, /主样本/);
    assert.match(markdown, /回复 A/);
    assert.match(markdown, /回复 B/);
  });

  it("includes revision suggestions for advisory regression warnings", () => {
    const data: EvaluatePatchResponse = {
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:global-file:abc",
      draftPolicyVersion: "tenant-a:draft:def",
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
          base: { suggestedReply: "回复 A", stage: "trust_building" },
          draft: { suggestedReply: "回复 B", stage: "trust_building" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: { blockingIssues: [], nonBlockingIssues: [] },
          },
        },
        {
          caseId: "regression-fact-boundary-smoke-001",
          role: "regression",
          base: { suggestedReply: "旧回复", stage: "trust_building" },
          draft: { suggestedReply: "新回复", stage: "trust_building" },
          factVerification: {
            base: { blockingIssues: [], nonBlockingIssues: [] },
            draft: {
              blockingIssues: [{ code: "missing_salary_fact", claim: "保底 7000" }],
              nonBlockingIssues: [],
            },
          },
        },
      ],
      warnings: [],
    };

    const markdown = formatEvaluationSummaryMarkdown(data, {
      advisoryCaseIds: ["regression-fact-boundary-smoke-001"],
    });

    assert.match(markdown, /风险提示/);
    assert.match(markdown, /可选处理/);
    assert.match(markdown, /对应修改方案/);
    assert.match(markdown, /缺少证据时先追问\/确认/);
  });

  it("includes revision suggestions for judge-only warnings and hides unknown diagnostic labels", () => {
    const data: EvaluatePatchResponse = {
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:global-file:abc",
      draftPolicyVersion: "tenant-a:draft:def",
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
          judge: {
            recommendedForPublish: false,
            rationale: "unsupported_field 建议性告警",
          },
        },
      ],
      warnings: ["regression 有 unsupported_field 弱相关告警"],
    };

    const markdown = formatEvaluationSummaryMarkdown(data);

    assert.match(markdown, /风险提示/);
    assert.match(markdown, /可选处理/);
    assert.match(markdown, /对应修改方案/);
    assert.match(markdown, /评审告警/);
    assert.doesNotMatch(markdown, /unsupported_field/);
    assert.match(markdown, /内部告警项/);
  });
});
