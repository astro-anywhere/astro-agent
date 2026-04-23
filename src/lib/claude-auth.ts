/**
 * Claude Code authentication method detection.
 *
 * Detects which authentication backend is configured via environment variables.
 * The Claude Agent SDK subprocess inherits these env vars and uses them to
 * authenticate with the appropriate backend (Anthropic cloud, Bedrock, Vertex, etc.).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Supported Claude Code authentication methods */
export type ClaudeAuthMethod =
  | 'bedrock'        // AWS Bedrock: CLAUDE_CODE_USE_BEDROCK=1
  | 'vertex'         // Google Vertex AI: CLAUDE_CODE_USE_VERTEX=1
  | 'third-party'    // Third-party OpenAI-compat: ANTHROPIC_BASE_URL
  | 'api-key'        // Direct API key: ANTHROPIC_API_KEY
  | 'oauth-token';   // OAuth token: CLAUDE_CODE_OAUTH_TOKEN

export interface ClaudeAuthDetection {
  method: ClaudeAuthMethod;
  /** Human-readable description for display/logging */
  label: string;
  /** Whether the detected config has all required env vars */
  complete: boolean;
  /** Missing env vars (if incomplete) */
  missing?: string[];
}

export type StoredClaudeOauthTokenSource = 'stored' | 'native-credentials' | 'env' | 'none';

function getClaudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function hasNativeClaudeOauthCredentials(env: Record<string, string | undefined>): boolean {
  const configDir = getClaudeConfigDir(env);
  const hasConfigDirOverride = !!env.CLAUDE_CONFIG_DIR;

  return (
    existsSync(join(configDir, '.credentials.json')) ||
    existsSync(join(configDir, '.claude.json')) ||
    (!hasConfigDirOverride && existsSync(join(homedir(), '.claude.json')))
  );
}

/**
 * Apply the Claude OAuth token from the agent config to the environment used by
 * the Claude Agent SDK.
 *
 * Claude's native credentials are intentionally authoritative because Claude
 * Code account switchers update ~/.claude between invocations. When those
 * files exist, remove any explicit token from the SDK subprocess env so the
 * spawned Claude Code process reads the current native credentials.
 *
 * If native credentials are absent, fall back to Astro's stored token, then an
 * inherited CLAUDE_CODE_OAUTH_TOKEN.
 */
export function applyStoredClaudeOauthToken(
  storedToken: string | undefined,
  env: Record<string, string | undefined> = process.env,
): StoredClaudeOauthTokenSource {
  if (hasNativeClaudeOauthCredentials(env)) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    return 'native-credentials';
  }

  if (storedToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = storedToken;
    return 'stored';
  }

  return env.CLAUDE_CODE_OAUTH_TOKEN ? 'env' : 'none';
}

/**
 * Detect Claude Code authentication method from environment variables.
 *
 * Checks in priority order:
 * 1. Bedrock (CLAUDE_CODE_USE_BEDROCK=1 + AWS credentials)
 * 2. Vertex AI (CLAUDE_CODE_USE_VERTEX=1 + GCP project)
 * 3. Third-party (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL)
 * 4. API Key (ANTHROPIC_API_KEY)
 * 5. OAuth Token (CLAUDE_CODE_OAUTH_TOKEN)
 *
 * Returns null if no authentication method is detected.
 */
export function detectClaudeAuth(env: Record<string, string | undefined> = process.env): ClaudeAuthDetection | null {
  // 1. Amazon Bedrock
  if (env.CLAUDE_CODE_USE_BEDROCK === '1') {
    const hasExplicitKeys = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    const hasProfile = !!env.AWS_PROFILE;
    const hasRegion = !!env.AWS_REGION;
    const hasCredentials = hasExplicitKeys || hasProfile;

    const missing: string[] = [];
    if (!hasRegion) missing.push('AWS_REGION');
    if (!hasCredentials) missing.push('AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_PROFILE');

    return {
      method: 'bedrock',
      label: 'Amazon Bedrock',
      complete: hasRegion && hasCredentials,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

  // 2. Google Vertex AI
  if (env.CLAUDE_CODE_USE_VERTEX === '1') {
    const hasRegion = !!env.CLOUD_ML_REGION;
    const hasProject = !!env.ANTHROPIC_VERTEX_PROJECT_ID;

    const missing: string[] = [];
    if (!hasRegion) missing.push('CLOUD_ML_REGION');
    if (!hasProject) missing.push('ANTHROPIC_VERTEX_PROJECT_ID');

    return {
      method: 'vertex',
      label: 'Google Vertex AI',
      complete: hasRegion && hasProject,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

  // 3. Third-party provider (ANTHROPIC_BASE_URL indicates a custom endpoint)
  if (env.ANTHROPIC_BASE_URL) {
    const hasKey = !!env.ANTHROPIC_API_KEY;
    const hasModel = !!env.ANTHROPIC_MODEL;

    const missing: string[] = [];
    if (!hasKey) missing.push('ANTHROPIC_API_KEY');
    if (!hasModel) missing.push('ANTHROPIC_MODEL');

    return {
      method: 'third-party',
      label: `Third-party provider (${env.ANTHROPIC_BASE_URL})`,
      complete: hasKey && hasModel,
      ...(missing.length > 0 ? { missing } : {}),
    };
  }

  // 4. Direct API key
  if (env.ANTHROPIC_API_KEY) {
    return {
      method: 'api-key',
      label: 'Anthropic API key',
      complete: true,
    };
  }

  // 5. OAuth token
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      method: 'oauth-token',
      label: 'Claude OAuth token',
      complete: true,
    };
  }

  return null;
}

/**
 * Environment variable keys that Claude Code uses for authentication.
 * Pass these through to the subprocess to ensure auth works.
 */
export const CLAUDE_AUTH_ENV_KEYS = [
  // Bedrock
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_REGION',
  // Vertex AI
  'CLAUDE_CODE_USE_VERTEX',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  // Third-party / API key
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  // OAuth
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Model overrides
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;
