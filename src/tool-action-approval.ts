import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { pruneExpiredFiles } from "./store-cleanup.ts";

export const ToolActionApprovalSchema = z.object({
  id: z.string().trim().min(1),
});
export type ToolActionApproval = z.infer<typeof ToolActionApprovalSchema>;

export type ToolActionApprovalSubject = {
  readonly tool: string;
  readonly target: string;
  readonly digest: string;
  readonly summary?: string;
};

type PersistedApproval = ToolActionApprovalSubject & {
  readonly id: string;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
};

export type ToolActionApprovalRequest = {
  readonly id: string;
  readonly expiresAt: string;
  readonly tool: string;
  readonly target: string;
  readonly summary?: string;
  readonly retryInput: {
    readonly toolActionApproval: ToolActionApproval;
  };
};

// ========== Store Directory ==========

let storeDirOverride: string | undefined;

function resolveApprovalStoreDir(): string {
  if (storeDirOverride !== undefined) {
    return storeDirOverride;
  }

  const fromEnv = process.env["REPLY_POLICY_TUNER_APPROVAL_DIR"]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  return join(homedir(), ".roll-agent", "reply-policy-tuner", "approvals");
}

function approvalFilePath(id: string): string {
  return join(resolveApprovalStoreDir(), `${id}.json`);
}

// ========== In-Memory Fallback (同进程内仍保留 Map 加速读取) ==========

const MAX_CACHE_SIZE = 100;
const memoryCache = new Map<string, PersistedApproval>();

function memoryCacheSet(id: string, approval: PersistedApproval): void {
  if (memoryCache.size >= MAX_CACHE_SIZE) {
    // 删除最早插入的条目
    const firstKey = memoryCache.keys().next().value;
    if (firstKey !== undefined) {
      memoryCache.delete(firstKey);
    }
  }
  memoryCache.set(id, approval);
}

// ========== File Operations ==========

async function persistApproval(approval: PersistedApproval): Promise<void> {
  const dir = resolveApprovalStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(approvalFilePath(approval.id), `${JSON.stringify(approval)}\n`, "utf8");
  memoryCacheSet(approval.id, approval);

  // 概率性清理过期 approval 文件
  await pruneExpiredFiles({
    dir,
    timestampField: "expiresAtMs",
    maxAgeMs: 0,
    absoluteExpiry: true,
    probabilityDenominator: 3,
  }).catch(() => {});
}

async function loadApproval(id: string): Promise<PersistedApproval | undefined> {
  // 先查内存缓存
  const cached = memoryCache.get(id);
  if (cached !== undefined) {
    return cached;
  }

  // 从文件加载
  try {
    const raw = await readFile(approvalFilePath(id), "utf8");
    const data = JSON.parse(raw.trim()) as PersistedApproval;
    memoryCacheSet(id, data);
    return data;
  } catch {
    return undefined;
  }
}

async function removeApproval(id: string): Promise<void> {
  memoryCache.delete(id);
  try {
    await unlink(approvalFilePath(id));
  } catch {
    // file may already be deleted
  }
}

// ========== Validation Helpers ==========

function subjectMatchesApproval(
  subject: ToolActionApprovalSubject,
  approval: PersistedApproval,
): boolean {
  return (
    subject.tool === approval.tool &&
    subject.target === approval.target &&
    subject.digest === approval.digest
  );
}

function isExpired(approval: PersistedApproval, nowMs = Date.now()): boolean {
  return nowMs >= approval.expiresAtMs;
}

// ========== Public API ==========

export async function createToolActionApprovalRequest(
  subject: ToolActionApprovalSubject,
  ttlMs: number,
  nowMs = Date.now(),
): Promise<ToolActionApprovalRequest> {
  const id = randomUUID();
  const expiresAtMs = nowMs + ttlMs;

  const approval: PersistedApproval = {
    id,
    tool: subject.tool,
    target: subject.target,
    digest: subject.digest,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
    expiresAtMs,
    createdAtMs: nowMs,
  };

  await persistApproval(approval);

  return {
    id,
    expiresAt: new Date(expiresAtMs).toISOString(),
    tool: subject.tool,
    target: subject.target,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
    retryInput: {
      toolActionApproval: { id },
    },
  };
}

export async function approveToolAction(input: {
  readonly approval: ToolActionApproval;
  readonly subject: ToolActionApprovalSubject;
}): Promise<boolean> {
  const valid = await isToolActionApprovalValid(input);
  if (!valid) {
    return false;
  }

  await removeApproval(input.approval.id);
  return true;
}

export async function isToolActionApprovalValid(input: {
  readonly approval: ToolActionApproval;
  readonly subject: ToolActionApprovalSubject;
}): Promise<boolean> {
  const approval = await loadApproval(input.approval.id);
  if (approval === undefined) {
    return false;
  }

  if (isExpired(approval)) {
    await removeApproval(input.approval.id);
    return false;
  }

  if (!subjectMatchesApproval(input.subject, approval)) {
    return false;
  }

  return true;
}

export function setApprovalStoreDirForTests(dir: string | undefined): void {
  storeDirOverride = dir;
}

export function resetToolActionApprovalsForTests(): void {
  memoryCache.clear();
  storeDirOverride = undefined;
}
