import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubmitEvaluatePolicyPatchInputSchema } from "./submit-evaluate-policy-patch.ts";

function builtCase(
  caseId: string,
  role: "primary" | "regression",
  regressionScope?: "related" | "general",
) {
  return {
    caseId,
    role,
    ...(regressionScope !== undefined ? { regressionScope } : {}),
    input: {
      candidateMessage: "候选人消息",
      target: {
        platform: "zhipin" as const,
        tenantId: "tenant-a",
        recruiterBinding: {
          platform: "zhipin" as const,
          username: "招聘账号",
        },
        conversationId: `conversation-${caseId}`,
        candidateId: `candidate-${caseId}`,
      },
    },
  };
}

describe("SubmitEvaluatePolicyPatchInputSchema", () => {
  const baseInput = {
    tenantId: "tenant-a",
    basePolicyVersion: "v1",
    patch: { persona: { tone: "自然" } },
  };

  it("rejects direct submissions without a regression case", () => {
    const result = SubmitEvaluatePolicyPatchInputSchema.safeParse({
      ...baseInput,
      cases: [builtCase("primary-001", "primary")],
    });

    assert.equal(result.success, false);
  });

  it("accepts one primary and one regression case", () => {
    const result = SubmitEvaluatePolicyPatchInputSchema.safeParse({
      ...baseInput,
      cases: [
        builtCase("primary-001", "primary"),
        builtCase("regression-001", "regression", "related"),
      ],
    });

    assert.equal(result.success, true);
  });

  it("rejects submissions with only a general regression case", () => {
    const result = SubmitEvaluatePolicyPatchInputSchema.safeParse({
      ...baseInput,
      cases: [
        builtCase("primary-001", "primary"),
        builtCase("regression-001", "regression", "general"),
      ],
    });

    assert.equal(result.success, false);
  });
});
