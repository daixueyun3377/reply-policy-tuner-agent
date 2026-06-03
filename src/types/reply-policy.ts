import { z } from "zod";

// ========== StageGoalPolicy ==========

export const StageGoalPolicySchema = z.object({
  description: z.string().optional(),
  primaryGoal: z.string(),
  successCriteria: z.array(z.string()),
  ctaStrategy: z.string(),
  disallowedActions: z.array(z.string()).optional(),
});

export type StageGoalPolicy = z.infer<typeof StageGoalPolicySchema>;

// ========== StageGoals ==========

export const STAGE_KEYS = [
  "trust_building",
  "private_channel",
  "qualify_candidate",
  "job_consultation",
  "interview_scheduling",
  "onboard_followup",
] as const;

export type StageKey = (typeof STAGE_KEYS)[number];

export const StageGoalsSchema = z.object({
  trust_building: StageGoalPolicySchema,
  private_channel: StageGoalPolicySchema.optional(),
  qualify_candidate: StageGoalPolicySchema,
  job_consultation: StageGoalPolicySchema,
  interview_scheduling: StageGoalPolicySchema,
  onboard_followup: StageGoalPolicySchema,
});

export type StageGoals = z.infer<typeof StageGoalsSchema>;

// ========== Persona ==========

export const PERSONA_LENGTH_VALUES = ["short", "medium", "long"] as const;

export const PersonaSchema = z.object({
  tone: z.string(),
  warmth: z.string(),
  humor: z.string(),
  length: z.enum(PERSONA_LENGTH_VALUES),
  questionStyle: z.string(),
  empathyStrategy: z.string(),
  addressStyle: z.string(),
  professionalIdentity: z.string(),
  companyBackground: z.string(),
});

export type Persona = z.infer<typeof PersonaSchema>;

// ========== IndustryVoice ==========

export const IndustryVoiceSchema = z.object({
  name: z.string(),
  industryBackground: z.string(),
  jargon: z.array(z.string()),
  styleKeywords: z.array(z.string()),
  tabooPhrases: z.array(z.string()),
  guidance: z.array(z.string()),
});

export type IndustryVoice = z.infer<typeof IndustryVoiceSchema>;

export const IndustryVoicesSchema = z.record(z.string(), IndustryVoiceSchema);

// ========== HardConstraints ==========

export const SEVERITY_VALUES = ["high", "medium", "low"] as const;

export const HardConstraintRuleSchema = z.object({
  id: z.string(),
  rule: z.string(),
  severity: z.enum(SEVERITY_VALUES),
});

export const HardConstraintsSchema = z.object({
  rules: z.array(HardConstraintRuleSchema).min(1),
});

export type HardConstraints = z.infer<typeof HardConstraintsSchema>;

// ========== FactGate ==========

export const FACT_GATE_MODE_VALUES = ["strict", "balanced", "open"] as const;
export const FALLBACK_BEHAVIOR_VALUES = ["generic_answer", "ask_followup", "handoff"] as const;

export const FactGateSchema = z.object({
  mode: z.enum(FACT_GATE_MODE_VALUES),
  verifiableClaimTypes: z.array(z.string()),
  fallbackBehavior: z.enum(FALLBACK_BEHAVIOR_VALUES),
  forbiddenWhenMissingFacts: z.array(z.string()),
});

export type FactGate = z.infer<typeof FactGateSchema>;

// ========== QualificationPolicy ==========

export const REDIRECT_PRIORITY_VALUES = ["low", "medium", "high"] as const;

export const QualificationPolicySchema = z
  .object({
    age: z
      .object({
        enabled: z.boolean().optional(),
        revealRange: z.boolean().optional(),
        failStrategy: z.string().optional(),
        unknownStrategy: z.string().optional(),
        passStrategy: z.string().optional(),
        allowRedirect: z.boolean().optional(),
        redirectPriority: z.enum(REDIRECT_PRIORITY_VALUES).optional(),
      })
      .optional(),
  })
  .optional();

export type QualificationPolicy = z.infer<typeof QualificationPolicySchema>;

// ========== OutputGuards ==========

export const OutputGuardsSchema = z
  .object({
    maxQuestionsByMode: z.object({
      minimal: z.number().int().min(0),
      focused: z.number().int().min(0),
    }),
    blockedAuditPhrases: z.array(z.string()),
    blockFirstTurnSpecificFacts: z.boolean(),
  })
  .optional();

export type OutputGuards = z.infer<typeof OutputGuardsSchema>;

// ========== ReplyPolicyConfig (full) ==========

export const ReplyPolicyConfigSchema = z.object({
  stageGoals: StageGoalsSchema,
  persona: PersonaSchema,
  industryVoices: IndustryVoicesSchema,
  defaultIndustryVoiceId: z.string(),
  hardConstraints: HardConstraintsSchema,
  factGate: FactGateSchema,
  qualificationPolicy: QualificationPolicySchema,
  outputGuards: OutputGuardsSchema,
});

export type ReplyPolicyConfig = z.infer<typeof ReplyPolicyConfigSchema>;

// ========== Policy Source ==========

export const POLICY_SOURCE_VALUES = ["tenant-file", "global-file", "default"] as const;

export const PolicySourceSchema = z.enum(POLICY_SOURCE_VALUES);

export type PolicySource = z.infer<typeof PolicySourceSchema>;

// ========== Policy Diff ==========

export const PolicyDiffEntrySchema = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

export type PolicyDiffEntry = z.infer<typeof PolicyDiffEntrySchema>;

// ========== GetPolicy Response ==========

export const GetPolicyResponseSchema = z.object({
  tenantId: z.string(),
  source: PolicySourceSchema,
  policyVersion: z.string(),
  policy: ReplyPolicyConfigSchema,
  warnings: z.array(z.string()),
});

export type GetPolicyResponse = z.infer<typeof GetPolicyResponseSchema>;

// ========== Auth Context ==========

export const AuthContextResponseSchema = z.object({
  role: z.enum(["client", "admin"]),
  clientId: z.string(),
  tenantIds: z.array(z.string()).nullable(),
  scopes: z.array(z.string()),
});

export type AuthContextResponse = z.infer<typeof AuthContextResponseSchema>;

// ========== Validate Patch Response ==========

export const ValidatePatchResponseSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  draftPolicyVersion: z.string(),
  source: PolicySourceSchema,
  policy: ReplyPolicyConfigSchema,
  patch: z.record(z.unknown()),
  warnings: z.array(z.string()),
  diff: z.array(PolicyDiffEntrySchema),
});

export type ValidatePatchResponse = z.infer<typeof ValidatePatchResponseSchema>;

// ========== Preview Reply ==========

export const PreviewReplySchema = z.object({
  suggestedReply: z.string(),
  confidence: z.number().optional(),
  stage: z.string(),
  diagnostics: z.record(z.unknown()).optional(),
});

export type PreviewReply = z.infer<typeof PreviewReplySchema>;

export const PreviewPatchResponseSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  draftPolicyVersion: z.string(),
  warnings: z.array(z.string()),
  diff: z.array(PolicyDiffEntrySchema),
  base: PreviewReplySchema,
  draft: PreviewReplySchema,
});

export type PreviewPatchResponse = z.infer<typeof PreviewPatchResponseSchema>;

// ========== Evaluate Patch Response ==========

export const EvaluateFactIssueSchema = z.object({
  code: z.string(),
  claim: z.string().optional(),
  status: z.string().optional(),
  expected: z.string().optional(),
});

export const EvaluateReplyResultSchema = z.object({
  suggestedReply: z.string(),
  stage: z.string(),
  confidence: z.number().optional(),
  replyGateRewritten: z.boolean().optional(),
  factGateRewritten: z.boolean().optional(),
  gateViolations: z.array(z.string()).optional(),
});

export const EvaluateFactVerificationSideSchema = z.object({
  claims: z.array(z.unknown()).optional(),
  blockingIssues: z.array(EvaluateFactIssueSchema),
  nonBlockingIssues: z.array(EvaluateFactIssueSchema),
});

export const EvaluateCaseResultSchema = z.object({
  caseId: z.string(),
  role: z.enum(["primary", "regression"]),
  base: EvaluateReplyResultSchema,
  draft: EvaluateReplyResultSchema,
  comparison: z
    .object({
      stageChanged: z.boolean().optional(),
      confidenceDelta: z.number().optional(),
      draftIntroducedGateViolations: z.boolean().optional(),
      draftIntroducedFactRewrite: z.boolean().optional(),
      draftIntroducedReplyRewrite: z.boolean().optional(),
    })
    .optional(),
  factVerification: z
    .object({
      base: EvaluateFactVerificationSideSchema,
      draft: EvaluateFactVerificationSideSchema,
    })
    .optional(),
  judge: z
    .object({
      rubricVersion: z.string().optional(),
      winner: z.string().optional(),
      recommendedForPublish: z.boolean().optional(),
      rationale: z.string().optional(),
    })
    .optional(),
});

export const EvaluateSummarySchema = z.object({
  totalCases: z.number().int(),
  primaryCases: z.number().int(),
  regressionCases: z.number().int(),
  draftFailures: z.number().int(),
  regressionWarnings: z.number().int(),
  hardRecommendedForPublish: z.boolean(),
  factRecommendedForPublish: z.boolean(),
  judgeRecommendedForPublish: z.boolean(),
  recommendedForPublish: z.boolean(),
});

export const EvaluatePatchResponseSchema = z.object({
  tenantId: z.string(),
  basePolicyVersion: z.string(),
  draftPolicyVersion: z.string(),
  summary: EvaluateSummarySchema,
  cases: z.array(EvaluateCaseResultSchema),
  warnings: z.array(z.string()),
});

export type EvaluatePatchResponse = z.infer<typeof EvaluatePatchResponseSchema>;

// ========== Evaluate Case Shared Schemas ==========

export const EvaluateTargetSchema = z.object({
  platform: z.literal("zhipin"),
  tenantId: z.string(),
  recruiterBinding: z.object({
    platform: z.literal("zhipin"),
    username: z.string(),
  }),
  conversationId: z.string(),
  candidateId: z.string(),
});

export type EvaluateTarget = z.infer<typeof EvaluateTargetSchema>;

export const BuiltCaseSchema = z.object({
  caseId: z.string(),
  role: z.enum(["primary", "regression"]),
  tags: z.array(z.string()).optional(),
  input: z.object({
    candidateMessage: z.string(),
    conversationHistory: z.array(z.string()).optional(),
    target: EvaluateTargetSchema,
  }),
});

export type BuiltCase = z.infer<typeof BuiltCaseSchema>;

// ========== Preview Policy Effect (tool output shape) ==========

export const PreviewPolicyEffectResponseSchema = z.object({
  currentReply: z.string(),
  previewReply: z.string(),
  stage: z.string(),
  baseConfidence: z.number().optional(),
  draftConfidence: z.number().optional(),
  diff: z.array(PolicyDiffEntrySchema),
});

export type PreviewPolicyEffectResponse = z.infer<typeof PreviewPolicyEffectResponseSchema>;

// ========== Admin Tenants ==========

export const AdminTenantSchema = z.object({
  manifest: z.object({
    tenantId: z.string(),
    displayName: z.string(),
    status: z.string().optional(),
    bindings: z.record(z.unknown()).optional(),
    syncParams: z.record(z.unknown()).optional(),
  }),
  status: z.string(),
  ready: z.boolean(),
  syncedAt: z.string().nullable().optional(),
  hasLocalReplyPolicy: z.boolean(),
});

export type AdminTenant = z.infer<typeof AdminTenantSchema>;

export const AdminTenantsResponseSchema = z.object({
  tenants: z.array(AdminTenantSchema),
});

export type AdminTenantsResponse = z.infer<typeof AdminTenantsResponseSchema>;
