import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError } from "@roll-agent/sdk";
import { resetTunerPolicyForTests, setTunerPolicy } from "./policy.ts";
import {
  assertEvaluatePublishGateAllowsUpdate,
  hashPolicyPatch,
  recordEvaluatePublishGate,
  setEvaluateGateStoreDirForTests,
} from "./evaluate-publish-gate.ts";

function expectPublishBlocked(
  error: unknown,
  expectedReason: string,
  messagePattern: RegExp,
): void {
  assert.ok(error instanceof StructuredToolError);
  assert.equal(error.payload.code, "publish_not_allowed");
  assert.match(error.payload.message, messagePattern);
  assert.equal(error.payload.details?.["reason"], expectedReason);
  assert.equal(typeof error.payload.details?.["technicalMessage"], "string");
  assert.doesNotMatch(error.payload.message, /orchestration|recommendedForPublish|update_policy|tenantId/i);
}

describe("evaluate publish gate", () => {
  let tempDir = "";

  afterEach(async () => {
    setEvaluateGateStoreDirForTests(undefined);
    resetTunerPolicyForTests();
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function useTempStore(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "reply-policy-tuner-gate-"));
    setEvaluateGateStoreDirForTests(tempDir);
    setTunerPolicy({
      approvalTtlMs: 300_000,
      tools: { update_policy: { policy: "log" } },
    });
  }

  it("allows update when hard and fact gates pass", async () => {
    await useTempStore();

    const patch = { persona: { questionStyle: "单轮只问一个最关键的问题" } };
    const patchDigest = hashPolicyPatch(patch);

    await recordEvaluatePublishGate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patchDigest,
      recommendedForPublish: true,
      hardRecommendedForPublish: true,
      factRecommendedForPublish: true,
      publishBlocked: false,
      orchestrationAction: "ready_to_publish",
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: "tenant-a:draft:v2",
    });

    await assertEvaluatePublishGateAllowsUpdate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patch,
    });
  });

  it("allows update when only judge advisory fails (recommendedForPublish false)", async () => {
    await useTempStore();

    const patch = { persona: { questionStyle: "单轮只问一个最关键的问题" } };
    const patchDigest = hashPolicyPatch(patch);

    await recordEvaluatePublishGate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patchDigest,
      recommendedForPublish: false,
      hardRecommendedForPublish: true,
      factRecommendedForPublish: true,
      publishBlocked: false,
      orchestrationAction: "decide_with_warnings",
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: "tenant-a:draft:v2",
    });

    await assertEvaluatePublishGateAllowsUpdate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patch,
    });
  });

  it("rejects update when hard or fact gate fails", async () => {
    await useTempStore();

    const patch = { persona: { questionStyle: "test" } };
    const patchDigest = hashPolicyPatch(patch);

    await recordEvaluatePublishGate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patchDigest,
      recommendedForPublish: false,
      hardRecommendedForPublish: false,
      factRecommendedForPublish: true,
      publishBlocked: true,
      orchestrationAction: "rollback_to_propose",
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: "tenant-a:draft:v2",
    });

    await assert.rejects(
      () =>
        assertEvaluatePublishGateAllowsUpdate({
          tenantId: "tenant-a",
          basePolicyVersion: "tenant-a:tenant-file:v1",
          patch,
        }),
      (error: unknown) => {
        expectPublishBlocked(error, "hard_block", /安全评估|暂时不能写入/);
        return true;
      },
    );
  });

  it("rejects update when hard blocked with user-friendly message", async () => {
    await useTempStore();

    const patch = { persona: { questionStyle: "test" } };
    const patchDigest = hashPolicyPatch(patch);

    await recordEvaluatePublishGate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patchDigest,
      recommendedForPublish: false,
      hardRecommendedForPublish: false,
      factRecommendedForPublish: false,
      publishBlocked: true,
      orchestrationAction: "rollback_to_propose",
      evaluatedAtMs: Date.now(),
      draftPolicyVersion: "tenant-a:draft:v2",
    });

    await assert.rejects(
      () =>
        assertEvaluatePublishGateAllowsUpdate({
          tenantId: "tenant-a",
          basePolicyVersion: "tenant-a:tenant-file:v1",
          patch,
        }),
      (error: unknown) => {
        expectPublishBlocked(error, "hard_block", /安全评估|暂时不能写入/);
        return true;
      },
    );
  });

  it("rejects update when no evaluate record exists", async () => {
    await useTempStore();

    await assert.rejects(
      () =>
        assertEvaluatePublishGateAllowsUpdate({
          tenantId: "tenant-a",
          basePolicyVersion: "tenant-a:tenant-file:v1",
          patch: { persona: { questionStyle: "x" } },
        }),
      (error: unknown) => {
        expectPublishBlocked(error, "missing_evaluate", /还没有完成评估/);
        return true;
      },
    );
  });

  it("rejects update when evaluate record expired", async () => {
    await useTempStore();
    setTunerPolicy({
      approvalTtlMs: 1_000,
      evaluateGateTtlMs: 1_000,
      tools: { update_policy: { policy: "log" } },
    });

    const patch = { persona: { questionStyle: "test" } };
    const patchDigest = hashPolicyPatch(patch);

    await recordEvaluatePublishGate({
      tenantId: "tenant-a",
      basePolicyVersion: "tenant-a:tenant-file:v1",
      patchDigest,
      recommendedForPublish: true,
      hardRecommendedForPublish: true,
      factRecommendedForPublish: true,
      publishBlocked: false,
      orchestrationAction: "ready_to_publish",
      evaluatedAtMs: Date.now() - 5_000,
      draftPolicyVersion: "tenant-a:draft:v2",
    });

    await assert.rejects(
      () =>
        assertEvaluatePublishGateAllowsUpdate({
          tenantId: "tenant-a",
          basePolicyVersion: "tenant-a:tenant-file:v1",
          patch,
        }),
      (error: unknown) => {
        expectPublishBlocked(error, "expired", /已过期/);
        return true;
      },
    );
  });
});
