import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { StructuredToolError, type AgentContext } from "@roll-agent/sdk";
import {
  assertTunerToolAllowed,
  loadTunerPolicyFromEnv,
  resetTunerPolicyForTests,
  setTunerPolicy,
} from "./policy.ts";
import {
  resetToolActionApprovalsForTests,
  setApprovalStoreDirForTests,
} from "./tool-action-approval.ts";

function createTestContext(): AgentContext {
  return {
    llm: { generateText: async () => "" },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

function readApprovalId(error: unknown): string {
  assert.ok(error instanceof StructuredToolError);
  const approvalRequest = error.payload.details?.["approvalRequest"];
  assert.equal(typeof approvalRequest, "object");
  assert.notEqual(approvalRequest, null);
  return (approvalRequest as { id: string }).id;
}

describe("reply-policy-tuner tool policy", () => {
  let tempDir = "";

  afterEach(async () => {
    resetTunerPolicyForTests();
    resetToolActionApprovalsForTests();
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  async function useTempApprovalStore(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), "reply-policy-tuner-approval-"));
    setApprovalStoreDirForTests(tempDir);
  }

  it("returns needs_confirmation for reset_policy without approval", async () => {
    await useTempApprovalStore();
    await assert.rejects(
      () =>
        assertTunerToolAllowed(createTestContext(), {
          subject: {
            tool: "reset_policy",
            target: "tenant-a",
            digest: "sha256:abc",
            summary: "重置",
          },
          deferApprovalConsumption: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );
  });

  it("allows reset_policy with valid approval", async () => {
    await useTempApprovalStore();
    let approvalId = "";
    try {
      await assertTunerToolAllowed(createTestContext(), {
        subject: {
          tool: "reset_policy",
          target: "tenant-a",
          digest: "sha256:abc",
        },
        deferApprovalConsumption: true,
      });
    } catch (error) {
      approvalId = readApprovalId(error);
    }

    const { consumeApproval } = await assertTunerToolAllowed(createTestContext(), {
      subject: { tool: "reset_policy", target: "tenant-a", digest: "sha256:abc" },
      deferApprovalConsumption: true,
      approval: { id: approvalId },
    });
    await consumeApproval();
  });

  it("rejects expired or wrong approval id", async () => {
    await useTempApprovalStore();
    await assert.rejects(
      () =>
        assertTunerToolAllowed(createTestContext(), {
          subject: { tool: "reset_policy", target: "tenant-a", digest: "sha256:abc" },
          deferApprovalConsumption: true,
          approval: { id: "not-a-real-approval" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "action_denied");
        assert.equal(error.payload.details?.["reason"], "approval_invalid_or_expired");
        return true;
      },
    );
  });

  it("returns needs_confirmation for update_policy by default", async () => {
    await useTempApprovalStore();
    setTunerPolicy(loadTunerPolicyFromEnv({}));
    await assert.rejects(
      () =>
        assertTunerToolAllowed(createTestContext(), {
          subject: {
            tool: "update_policy",
            target: "tenant-a",
            digest: "sha256:def",
          },
          deferApprovalConsumption: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof StructuredToolError);
        assert.equal(error.payload.code, "needs_confirmation");
        return true;
      },
    );
  });
});
