import { StructuredToolError } from "@roll-agent/sdk";
import type { AgentContext } from "@roll-agent/sdk";
import { z } from "zod";
import {
  approveToolAction,
  createToolActionApprovalRequest,
  isToolActionApprovalValid,
  type ToolActionApproval,
  type ToolActionApprovalSubject,
} from "./tool-action-approval.ts";

export const TUNER_TOOL_POLICIES = ["log", "deny", "confirm"] as const;
export const TunerToolPolicySchema = z.enum(TUNER_TOOL_POLICIES);
export type TunerToolPolicy = z.infer<typeof TunerToolPolicySchema>;

const TunerToolPolicyEntrySchema = z.object({
  policy: TunerToolPolicySchema,
});

export const TunerPolicyConfigSchema = z.object({
  approvalTtlMs: z.number().int().positive().max(3_600_000).default(300_000),
  /** evaluate gate 记录有效期（毫秒）；默认 15 分钟，留足 evaluate→展示→确认→写入 的完整窗口 */
  evaluateGateTtlMs: z.number().int().positive().max(3_600_000).default(900_000),
  tools: z.record(TunerToolPolicyEntrySchema).default({}),
});
export type TunerPolicyConfig = z.infer<typeof TunerPolicyConfigSchema>;

const DEFAULT_TUNER_POLICY = TunerPolicyConfigSchema.parse({
  tools: {
    reset_policy: { policy: "confirm" },
    update_policy: { policy: "confirm" },
  },
});

let currentPolicy = DEFAULT_TUNER_POLICY;

function parsePolicyJson(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `REPLY_POLICY_TUNER_POLICY_JSON must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadTunerPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): TunerPolicyConfig {
  const raw = env["REPLY_POLICY_TUNER_POLICY_JSON"];
  const parsed = parsePolicyJson(raw);
  if (parsed === undefined) {
    return DEFAULT_TUNER_POLICY;
  }

  try {
    return TunerPolicyConfigSchema.parse(parsed);
  } catch (error) {
    throw new Error(
      `REPLY_POLICY_TUNER_POLICY_JSON is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function setTunerPolicy(policy: z.input<typeof TunerPolicyConfigSchema>): void {
  currentPolicy = TunerPolicyConfigSchema.parse(policy);
}

export function getTunerPolicy(): TunerPolicyConfig {
  return currentPolicy;
}

export function resetTunerPolicyForTests(): void {
  currentPolicy = DEFAULT_TUNER_POLICY;
}

/**
 * 检查 tool 是否被允许执行。
 * - policy=log → 直接放行
 * - policy=deny → 抛出 action_denied
 * - policy=confirm → 需要 toolActionApproval，否则抛出 needs_confirmation
 */
export async function assertTunerToolAllowed(
  ctx: AgentContext,
  input: {
    readonly subject: ToolActionApprovalSubject;
    readonly approval?: ToolActionApproval;
    readonly deferApprovalConsumption?: boolean;
    readonly policyOverride?: TunerToolPolicy;
    /** needs_confirmation 时展示给运营/编排层的口语化说明 */
    readonly confirmationMessage?: string;
  },
): Promise<{ readonly consumeApproval: () => Promise<void> }> {
  const entry = currentPolicy.tools[input.subject.tool];
  const policy = input.policyOverride ?? entry?.policy ?? "log";

  if (policy === "log") {
    ctx.logger.info(`Reply-policy-tuner tool allowed by tool policy: ${input.subject.tool}`);
    return { consumeApproval: async () => {} };
  }

  if (policy === "deny") {
    const message = "Tool execution denied by reply-policy-tuner tool policy.";
    ctx.logger.warn(
      `${message} ${JSON.stringify(toToolPolicyDetails(input.subject, "tool_policy_deny"))}`,
    );
    throw new StructuredToolError({
      code: "action_denied",
      message,
      details: toToolPolicyDetails(input.subject, "tool_policy_deny"),
    });
  }

  // policy === "confirm"
  if (input.approval !== undefined) {
    const approved =
      input.deferApprovalConsumption === true
        ? await isToolActionApprovalValid({ approval: input.approval, subject: input.subject })
        : await approveToolAction({ approval: input.approval, subject: input.subject });

    if (!approved) {
      const message = "确认已过期、已使用或与当前操作不匹配，请重新展示对比并再次确认。";
      ctx.logger.warn(`${message} tool=${input.subject.tool}`);
      throw new StructuredToolError({
        code: "action_denied",
        message,
        details: {
          ...toToolPolicyDetails(input.subject, "tool_policy_confirm"),
          reason: "approval_invalid_or_expired",
        },
      });
    }

    ctx.logger.info(
      `Reply-policy-tuner tool approved by toolActionApproval: ${input.subject.tool}`,
    );
    return {
      consumeApproval: async () => {
        if (input.deferApprovalConsumption === true && input.approval !== undefined) {
          await approveToolAction({ approval: input.approval, subject: input.subject });
        }
      },
    };
  }

  const message =
    input.confirmationMessage ??
    "Tool execution requires confirmation by reply-policy-tuner tool policy.";
  const approvalRequest = await createToolActionApprovalRequest(input.subject, currentPolicy.approvalTtlMs);
  const details = {
    ...toToolPolicyDetails(input.subject, "tool_policy_confirm"),
    approvalRequest,
  };
  ctx.logger.warn(
    `${message} ${JSON.stringify(toToolPolicyDetails(input.subject, "tool_policy_confirm"))}`,
  );
  throw new StructuredToolError({
    code: "needs_confirmation",
    message,
    details,
  });
}

function toToolPolicyDetails(
  subject: ToolActionApprovalSubject,
  reason: "tool_policy_confirm" | "tool_policy_deny",
): Record<string, unknown> {
  return {
    reason,
    tool: subject.tool,
    target: subject.target,
    ...(subject.summary !== undefined ? { summary: subject.summary } : {}),
  };
}
