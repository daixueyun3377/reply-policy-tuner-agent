import { z } from "zod";
import { ReplyPolicyConfigSchema } from "./types/reply-policy.ts";

const UNSUPPORTED_POLICY_PATCH_MESSAGE =
  "内部生成的修改方案包含当前策略里没有的配置项。不要向用户展示这个错误；请回到 validate_patch，带上用户原始需求重新生成可支持的修改方案。";

export class PolicyPatchShapeError extends Error {
  readonly errors: string[];
  readonly invalidPaths: string[];

  constructor(invalidPaths: string[]) {
    super(UNSUPPORTED_POLICY_PATCH_MESSAGE);
    this.name = "PolicyPatchShapeError";
    this.errors = [UNSUPPORTED_POLICY_PATCH_MESSAGE];
    this.invalidPaths = invalidPaths;
  }
}

export function getUnsupportedPolicyPatchPaths(patch: Record<string, unknown>): string[] {
  const unknownPaths: string[] = [];
  collectUnknownPatchPaths(ReplyPolicyConfigSchema, patch, [], unknownPaths);
  return unknownPaths;
}

export function validatePolicyPatchShape(patch: Record<string, unknown>): string[] {
  return getUnsupportedPolicyPatchPaths(patch).length > 0
    ? [UNSUPPORTED_POLICY_PATCH_MESSAGE]
    : [];
}

export function assertPolicyPatchShape(patch: Record<string, unknown>): void {
  const invalidPaths = getUnsupportedPolicyPatchPaths(patch);
  if (invalidPaths.length > 0) {
    throw new PolicyPatchShapeError(invalidPaths);
  }
}

function collectUnknownPatchPaths(
  schema: z.ZodTypeAny,
  value: unknown,
  path: readonly string[],
  unknownPaths: string[],
): void {
  const unwrapped = unwrapSchema(schema);

  if (unwrapped instanceof z.ZodObject) {
    if (!isPlainRecord(value)) {
      return;
    }

    const shape = unwrapped.shape;
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = shape[key];
      const childPath = [...path, key];
      if (childSchema === undefined) {
        unknownPaths.push(formatPath(childPath));
        continue;
      }
      collectUnknownPatchPaths(childSchema, childValue, childPath, unknownPaths);
    }
    return;
  }

  if (unwrapped instanceof z.ZodRecord) {
    if (!isPlainRecord(value)) {
      return;
    }

    const valueSchema = unwrapRecordValueSchema(unwrapped);
    for (const [key, childValue] of Object.entries(value)) {
      collectUnknownPatchPaths(valueSchema, childValue, [...path, key], unknownPaths);
    }
    return;
  }

  if (unwrapped instanceof z.ZodArray) {
    if (!Array.isArray(value)) {
      return;
    }

    const itemSchema = unwrapped.element;
    value.forEach((item, index) => {
      collectUnknownPatchPaths(itemSchema, item, [...path, String(index)], unknownPaths);
    });
  }
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap();
  }
  return current;
}

function unwrapRecordValueSchema(schema: z.ZodRecord): z.ZodTypeAny {
  const def = schema._def as { valueType: z.ZodTypeAny };
  return def.valueType;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPath(path: readonly string[]): string {
  return path.join(".");
}
