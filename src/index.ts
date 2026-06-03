import { defineAgent } from "@roll-agent/sdk";
import { loadTunerPolicyFromEnv, setTunerPolicy } from "./policy.ts";
import { diagnosticStatus } from "./tools/diagnostic-status.ts";
import { buildEvaluateCasesTool } from "./tools/build-evaluate-cases.ts";
import { formatPolicyPreviewTool } from "./tools/format-policy-preview.ts";
import { getPolicyTool } from "./tools/get-policy.ts";
import { previewPolicyEffectTool } from "./tools/preview-policy-effect.ts";
import { resetPolicyTool } from "./tools/reset-policy.ts";
import { resolveRecruiterBindingTool } from "./tools/resolve-recruiter-binding.ts";
import { submitEvaluatePolicyPatchTool } from "./tools/submit-evaluate-policy-patch.ts";
import { updatePolicyTool } from "./tools/update-policy.ts";
import { validatePatchTool } from "./tools/validate-patch.ts";
import { validatePolicyTool } from "./tools/validate-policy.ts";

const tunerPolicy = loadTunerPolicyFromEnv();
setTunerPolicy(tunerPolicy);

const agent = defineAgent({
  name: "reply-policy-tuner-agent",
  tools: [
    diagnosticStatus,
    getPolicyTool,
    validatePatchTool,
    resolveRecruiterBindingTool,
    buildEvaluateCasesTool,
    submitEvaluatePolicyPatchTool,
    previewPolicyEffectTool,
    formatPolicyPreviewTool,
    updatePolicyTool,
    validatePolicyTool,
    resetPolicyTool,
  ],
});

agent.listen().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
