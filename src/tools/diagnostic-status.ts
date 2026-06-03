import { defineTool } from "@roll-agent/sdk";
import { z } from "zod";
import {
  collectEffectiveEnvSources,
  EffectiveEnvSourcesSchema,
  TUNER_DECLARED_ENV_KEYS,
} from "../diagnostics/effective-env.ts";
import { checkHealth, getAuthContext, listAdminTenants } from "../services/reply-authority-client.ts";

const AdminTenantsProbeSchema = z.object({
  status: z.number().int(),
  tokenRole: z.enum(["admin", "client", "invalid"]),
  tenantCount: z.number().int().optional(),
  tenants: z
    .array(
      z.object({
        tenantId: z.string(),
        displayName: z.string(),
        hasLocalReplyPolicy: z.boolean(),
      }),
    )
    .optional(),
});

const AuthContextProbeSchema = z.object({
  status: z.number().int(),
  role: z.enum(["client", "admin"]).optional(),
  clientId: z.string().optional(),
  tenantIds: z.array(z.string()).nullable().optional(),
  scopes: z.array(z.string()).optional(),
  capabilities: z.object({
    canRead: z.boolean(),
    canValidate: z.boolean(),
    canPreview: z.boolean(),
    canEvaluate: z.boolean(),
    canWrite: z.boolean(),
    canJudge: z.boolean(),
  }),
});

const DiagnosticStatusOutputSchema = z.object({
  env: EffectiveEnvSourcesSchema,
  ras: z.object({
    health: z.enum(["ok", "unreachable", "error"]),
    healthTimestamp: z.string().optional(),
    tokenRole: z.enum(["admin", "client", "invalid", "unknown"]),
    authContext: AuthContextProbeSchema.optional(),
    adminTenantsProbe: AdminTenantsProbeSchema.optional(),
  }),
});

function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}

function buildCapabilities(scopes: readonly string[]): {
  canRead: boolean;
  canValidate: boolean;
  canPreview: boolean;
  canEvaluate: boolean;
  canWrite: boolean;
  canJudge: boolean;
} {
  return {
    canRead: hasScope(scopes, "reply-policy:read"),
    canValidate: hasScope(scopes, "reply-policy:validate"),
    canPreview: hasScope(scopes, "reply-policy:preview"),
    canEvaluate: hasScope(scopes, "reply-policy:preview"),
    canWrite: hasScope(scopes, "reply-policy:write"),
    canJudge: hasScope(scopes, "reply-policy:judge"),
  };
}

export const diagnosticStatus = defineTool({
  name: "diagnostic_status",
  description:
    "检查环境变量与 Reply Authority Service 连通性；通过 auth/context 探测 scopes 与 tenantIds，Admin 额外返回运营人员列表",
  input: z.object({}),
  output: DiagnosticStatusOutputSchema,
  execute: async (_input, ctx) => {
    ctx.logger.info("Running reply-policy-tuner diagnostic status");

    const env = collectEffectiveEnvSources(TUNER_DECLARED_ENV_KEYS);

    let health: "ok" | "unreachable" | "error" = "unreachable";
    let healthTimestamp: string | undefined;

    try {
      const healthResult = await checkHealth();
      if (healthResult.ok && healthResult.data) {
        health = "ok";
        healthTimestamp = healthResult.data.timestamp;
      } else {
        health = "error";
      }
    } catch {
      health = "unreachable";
    }

    let tokenRole: "admin" | "client" | "invalid" | "unknown" = "unknown";
    let authContext: z.infer<typeof AuthContextProbeSchema> | undefined;
    let adminTenantsProbe: z.infer<typeof AdminTenantsProbeSchema> | undefined;

    if (health === "ok") {
      try {
        const authResult = await getAuthContext();

        if (authResult.ok && authResult.data) {
          tokenRole = authResult.data.role;
          const scopes = authResult.data.scopes;

          authContext = {
            status: 200,
            role: authResult.data.role,
            clientId: authResult.data.clientId,
            tenantIds: authResult.data.tenantIds,
            scopes,
            capabilities: buildCapabilities(scopes),
          };
        } else if (authResult.status === 401) {
          tokenRole = "invalid";
          authContext = {
            status: 401,
            capabilities: buildCapabilities([]),
          };
        }
      } catch {
        tokenRole = "unknown";
      }

      if (tokenRole === "admin") {
        try {
          const tenantsResult = await listAdminTenants();

          if (tenantsResult.ok && tenantsResult.data) {
            const tenants = tenantsResult.data.tenants.map((t) => ({
              tenantId: t.manifest.tenantId,
              displayName: t.manifest.displayName,
              hasLocalReplyPolicy: t.hasLocalReplyPolicy,
            }));
            adminTenantsProbe = {
              status: 200,
              tokenRole: "admin",
              tenantCount: tenants.length,
              tenants,
            };
          } else if (tenantsResult.status === 401) {
            tokenRole = "invalid";
          }
        } catch {
          // keep admin role from auth/context
        }
      } else if (tokenRole === "client" && authContext !== undefined) {
        adminTenantsProbe = {
          status: 403,
          tokenRole: "client",
        };
      }
    }

    return {
      env,
      ras: {
        health,
        ...(healthTimestamp !== undefined ? { healthTimestamp } : {}),
        tokenRole,
        ...(authContext !== undefined ? { authContext } : {}),
        ...(adminTenantsProbe !== undefined ? { adminTenantsProbe } : {}),
      },
    };
  },
});
