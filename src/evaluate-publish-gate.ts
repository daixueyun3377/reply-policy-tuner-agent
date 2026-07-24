import { StructuredToolError } from "@roll-agent/sdk";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildEvaluatePublishGateUserMessage,
  type EvaluatePublishGateBlockReason,
} from "./evaluate-publish-gate-messages.ts";
import type { EvaluationOrchestrationAction } from "./presentation/evaluation-orchestration.ts";
import { getTunerPolicy } from "./policy.ts";
import { pruneExpiredFiles } from "./store-cleanup.ts";

export type EvaluatePublishGateRecord = {
  tenantId: string;
  basePolicyVersion: string;
  patchDigest: string;
  /** 服务端 Hard∧Fact∧Judge 综合；Tool 门禁不以该字段为准 */
  recommendedForPublish: boolean;
  /** 本地按 base/draft 增量结果推导的 Hard Gate 结论 */
  hardRecommendedForPublish: boolean;
  /** 本地按 base/draft 增量结果推导的 Fact 结论 */
  factRecommendedForPublish: boolean;
  publishBlocked: boolean;
  orchestrationAction: EvaluationOrchestrationAction;
  evaluatedAtMs: number;
  draftPolicyVersion: string;
};

let gateStoreDirOverride: string | undefined;

function resolveEvaluateGateStoreDir(): string {
  if (gateStoreDirOverride !== undefined) {
    return gateStoreDirOverride;
  }

  const fromEnv = process.env["REPLY_POLICY_TUNER_EVALUATE_GATE_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  return join(homedir(), ".roll-agent", "reply-policy-tuner", "evaluate-gates");
}

function gateFilePath(recordKey: string): string {
  const safeKey = recordKey.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(resolveEvaluateGateStoreDir(), `${safeKey}.json`);
}

export function hashPolicyPatch(patch: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(patch))
    .digest("hex")
    .slice(0, 32);
}

export function buildEvaluatePublishGateKey(input: {
  tenantId: string;
  basePolicyVersion: string;
  patch: Record<string, unknown>;
}): string {
  return `${input.tenantId}:${input.basePolicyVersion}:${hashPolicyPatch(input.patch)}`;
}

export async function recordEvaluatePublishGate(
  input: EvaluatePublishGateRecord,
): Promise<void> {
  const dir = resolveEvaluateGateStoreDir();
  await mkdir(dir, { recursive: true });

  const key = `${input.tenantId}:${input.basePolicyVersion}:${input.patchDigest}`;
  const filePath = gateFilePath(key);
  await writeFile(filePath, `${JSON.stringify(input)}\n`, "utf8");

  // 概率性清理过期 evaluate gate 文件（排除刚写入的文件）。
  // 清理不影响门禁正确性，fire-and-forget 以免阻塞调用方响应。
  const ttlMs = getTunerPolicy().evaluateGateTtlMs;
  void pruneExpiredFiles({
    dir,
    timestampField: "evaluatedAtMs",
    maxAgeMs: ttlMs,
    probabilityDenominator: 5,
    excludeFiles: [filePath],
  }).catch(() => {});
}

function throwPublishGateBlocked(input: {
  reason: EvaluatePublishGateBlockReason;
  record?: EvaluatePublishGateRecord;
  technicalMessage: string;
}): never {
  throw new StructuredToolError({
    code: "publish_not_allowed",
    message: buildEvaluatePublishGateUserMessage({
      reason: input.reason,
      ...(input.record?.orchestrationAction !== undefined
        ? { orchestrationAction: input.record.orchestrationAction }
        : {}),
    }),
    details: {
      reason: input.reason,
      technicalMessage: input.technicalMessage,
      ...(input.record !== undefined
        ? {
            publishBlocked: input.record.publishBlocked,
            hardRecommendedForPublish: input.record.hardRecommendedForPublish,
            factRecommendedForPublish: input.record.factRecommendedForPublish,
            orchestrationAction: input.record.orchestrationAction,
          }
        : {}),
    },
  });
}

export async function assertEvaluatePublishGateAllowsUpdate(input: {
  tenantId: string;
  basePolicyVersion: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  const patchDigest = hashPolicyPatch(input.patch);
  const key = `${input.tenantId}:${input.basePolicyVersion}:${patchDigest}`;
  const path = gateFilePath(key);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throwPublishGateBlocked({
      reason: "missing_evaluate",
      technicalMessage:
        "No matching evaluate_policy_patch record for tenantId/basePolicyVersion/patch.",
    });
  }

  let record: EvaluatePublishGateRecord;
  try {
    record = JSON.parse(raw.trim()) as EvaluatePublishGateRecord;
  } catch {
    throwPublishGateBlocked({
      reason: "corrupt_record",
      technicalMessage: "Evaluate gate record JSON parse failed.",
    });
  }

  const ttlMs = getTunerPolicy().evaluateGateTtlMs;
  if (Date.now() - record.evaluatedAtMs > ttlMs) {
    throwPublishGateBlocked({
      reason: "expired",
      record,
      technicalMessage: `Evaluate gate record expired (ttlMs=${String(ttlMs)}).`,
    });
  }

  if (
    record.tenantId !== input.tenantId ||
    record.basePolicyVersion !== input.basePolicyVersion ||
    record.patchDigest !== patchDigest
  ) {
    throwPublishGateBlocked({
      reason: "mismatch",
      record,
      technicalMessage:
        "Evaluate gate record does not match update_policy tenantId/basePolicyVersion/patch.",
    });
  }

  if (record.publishBlocked) {
    throwPublishGateBlocked({
      reason: "hard_block",
      record,
      technicalMessage: `publishBlocked=true, orchestration.action=${record.orchestrationAction}.`,
    });
  }

  if (!record.hardRecommendedForPublish || !record.factRecommendedForPublish) {
    throwPublishGateBlocked({
      reason: "not_recommended",
      record,
      technicalMessage:
        `hardRecommendedForPublish=${String(record.hardRecommendedForPublish)}, ` +
        `factRecommendedForPublish=${String(record.factRecommendedForPublish)}, ` +
        `orchestration.action=${record.orchestrationAction}.`,
    });
  }
}

export function setEvaluateGateStoreDirForTests(dir: string | undefined): void {
  gateStoreDirOverride = dir;
}
