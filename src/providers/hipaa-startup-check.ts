/**
 * HIPAA mode startup check.
 *
 * When `ASTRO_HIPAA_MODE=true`, Astro must route all AI calls through AWS
 * Bedrock (under the AWS BAA). Claude Code natively supports Bedrock when the
 * correct env vars are set; we enforce those here and fail closed at boot if
 * any are missing or if a direct-Anthropic API key is present.
 *
 * See Phase 3 of the HIPAA compliance plan.
 */
export function assertHipaaBedrockEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ASTRO_HIPAA_MODE !== 'true') return;

  const missing: string[] = [];
  if (env.CLAUDE_CODE_USE_BEDROCK !== '1') missing.push('CLAUDE_CODE_USE_BEDROCK=1');
  if (!env.AWS_REGION) missing.push('AWS_REGION');
  if (!env.ANTHROPIC_MODEL) missing.push('ANTHROPIC_MODEL (must be Bedrock model id)');
  if (env.ANTHROPIC_API_KEY) {
    missing.push('(forbidden) ANTHROPIC_API_KEY must not be set in HIPAA mode');
  }

  if (missing.length > 0) {
    throw new Error(
      `HIPAA mode requires Bedrock routing. Problems: ${missing.join(', ')}`,
    );
  }

  console.log('[claude-sdk] HIPAA mode: Bedrock env vars verified');
}
