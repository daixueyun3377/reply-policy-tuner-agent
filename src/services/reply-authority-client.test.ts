import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEvaluateTargetInput } from "./reply-authority-client.ts";

describe("reply authority client target builders", () => {
  it("uses deterministic fallback ids when real conversation ids are not provided", () => {
    const input = buildEvaluateTargetInput({
      tenantId: "tenant-a",
      recruiterUsername: "recruiter-a",
      caseId: "case-1",
      candidateMessage: "你好",
    });

    assert.equal(input.target.conversationId, "eval-case-1");
    assert.equal(input.target.candidateId, "candidate-case-1");
  });

  it("passes through real conversation ids when both ids are provided", () => {
    const input = buildEvaluateTargetInput({
      tenantId: "tenant-a",
      recruiterUsername: "recruiter-a",
      caseId: "case-1",
      candidateMessage: "你好",
      conversationId: "real-conv-1",
      candidateId: "real-candidate-1",
    });

    assert.equal(input.target.conversationId, "real-conv-1");
    assert.equal(input.target.candidateId, "real-candidate-1");
  });

  it("rejects partial real conversation identity", () => {
    assert.throws(
      () =>
        buildEvaluateTargetInput({
          tenantId: "tenant-a",
          recruiterUsername: "recruiter-a",
          caseId: "case-1",
          candidateMessage: "你好",
          conversationId: "real-conv-1",
        }),
      /必须同时传入/,
    );
  });
});
