/**
 * HIPAA mode startup check.
 *
 * When `ASTRO_HIPAA_MODE=true`, Astro must route all AI calls through AWS
 * Bedrock (under the AWS BAA). Claude Code natively supports Bedrock when the
 * correct env vars are set; we enforce those here and fail closed at boot if
 * any are missing or if a direct-Anthropic API key is present.
 *
 * Scope: the Claude SDK is the only provider that natively supports Bedrock,
 * so it is the only provider this check gates. Codex/OpenClaw/OpenCode/Pi
 * call non-Bedrock services and are intentionally out of HIPAA scope — they
 * are expected to be disabled by deployment configuration in HIPAA mode.
 *
 * See Phase 3 of the HIPAA compliance plan.
 */
export function assertHipaaBedrockEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ASTRO_HIPAA_MODE !== 'true') return;

  const missing: string[] = [];
  if (env.CLAUDE_CODE_USE_BEDROCK !== '1') {
    // The Claude SDK only accepts the exact string "1" (not "true"/"yes").
    // Surface the actual value so operators do not have to guess why a
    // truthy-looking setting was rejected.
    const hint = env.CLAUDE_CODE_USE_BEDROCK
      ? ` (got "${env.CLAUDE_CODE_USE_BEDROCK}", must be exactly "1")`
      : '';
    missing.push(`CLAUDE_CODE_USE_BEDROCK=1${hint}`);
  }
  if (!env.AWS_REGION) missing.push('AWS_REGION');
  if (!env.ANTHROPIC_MODEL) missing.push('ANTHROPIC_MODEL (must be Bedrock model id)');

  const forbidden: string[] = [];
  if (env.ANTHROPIC_API_KEY) {
    forbidden.push('ANTHROPIC_API_KEY must not be set in HIPAA mode');
  }

  if (missing.length > 0 || forbidden.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing required: ${missing.join(', ')}`);
    if (forbidden.length > 0) parts.push(`forbidden present: ${forbidden.join(', ')}`);
    throw new Error(
      `HIPAA mode requires Bedrock routing. ${parts.join('; ')}`,
    );
  }

  // Success path: stay silent by default to avoid broadcasting the HIPAA
  // posture of the deployment in logs. Gate on DEBUG/VERBOSE for operators
  // who want explicit confirmation.
  if (process.env.DEBUG || process.env.VERBOSE) {
    console.log('[claude-sdk] HIPAA mode: Bedrock env vars verified');
  }
}
