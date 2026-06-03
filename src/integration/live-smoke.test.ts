import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkHealth,
  getAuthContext,
  getPolicy,
  previewPolicyEffect,
  validatePatch,
} from "../services/reply-authority-client.ts";

const LIVE = process.env["REPLY_POLICY_TUNER_LIVE_TEST"] === "1";
const tenantId = process.env["REPLY_POLICY_TUNER_LIVE_TENANT_ID"]?.trim();

describe("reply-policy-tuner live RAS smoke", { skip: !LIVE }, () => {
  it("health + auth/context + get_policy + validate/preview/evaluate chain", async () => {
    const health = await checkHealth();
    assert.equal(health.ok, true, health.errorMessage);

    const auth = await getAuthContext();
    assert.equal(auth.ok, true, auth.errorMessage);

    assert.ok(tenantId && tenantId.length > 0, "REPLY_POLICY_TUNER_LIVE_TENANT_ID required");

    const policy = await getPolicy(tenantId);
    assert.equal(policy.ok, true, policy.errorMessage);

    const patch = {
      persona: { questionStyle: "单轮只问一个最关键的问题" },
    };

    const validated = await validatePatch(tenantId, {
      basePolicyVersion: policy.data?.policyVersion ?? "",
      patch,
    });
    assert.equal(validated.ok, true, validated.errorMessage);
    assert.ok(validated.data?.diff.length !== undefined);

    const preview = await previewPolicyEffect(tenantId, {
      basePolicyVersion: policy.data?.policyVersion ?? "",
      patch,
      candidateMessage: "你好，想了解一下这个岗位",
    });
    assert.equal(preview.ok, true, preview.errorMessage);
    assert.ok(preview.data?.currentReply.length);
    assert.ok(preview.data?.previewReply.length);
  });
});
