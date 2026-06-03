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
});
