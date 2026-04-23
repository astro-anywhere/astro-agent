import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyStoredClaudeOauthToken, detectClaudeAuth, CLAUDE_AUTH_ENV_KEYS } from '../src/lib/claude-auth.js';

describe('detectClaudeAuth', () => {
  // Helper: create a clean env with only the specified vars
  const env = (vars: Record<string, string>): Record<string, string | undefined> => vars;

  describe('Bedrock authentication', () => {
    it('detects Bedrock with explicit AWS keys', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret',
      }));
      expect(result).toEqual({
        method: 'bedrock',
        label: 'Amazon Bedrock',
        complete: true,
      });
    });

    it('detects Bedrock with AWS profile', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'default',
      }));
      expect(result).toEqual({
        method: 'bedrock',
        label: 'Amazon Bedrock',
        complete: true,
      });
    });

    it('detects incomplete Bedrock — missing region', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_PROFILE: 'default',
      }));
      expect(result).toMatchObject({
        method: 'bedrock',
        complete: false,
        missing: ['AWS_REGION'],
      });
    });

    it('detects incomplete Bedrock — missing credentials', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
      }));
      expect(result).toMatchObject({
        method: 'bedrock',
        complete: false,
        missing: ['AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_PROFILE'],
      });
    });

    it('detects incomplete Bedrock — missing both region and credentials', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
      }));
      expect(result).toMatchObject({
        method: 'bedrock',
        complete: false,
        missing: expect.arrayContaining(['AWS_REGION']),
      });
      expect(result?.missing).toHaveLength(2);
    });

    it('ignores CLAUDE_CODE_USE_BEDROCK if not "1"', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: 'true',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'default',
      }));
      // Should not detect as bedrock — falls through to other methods
      expect(result).toBeNull();
    });
  });

  describe('Vertex AI authentication', () => {
    it('detects Vertex AI with all required vars', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
      }));
      expect(result).toEqual({
        method: 'vertex',
        label: 'Google Vertex AI',
        complete: true,
      });
    });

    it('detects incomplete Vertex — missing region', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
      }));
      expect(result).toMatchObject({
        method: 'vertex',
        complete: false,
        missing: ['CLOUD_ML_REGION'],
      });
    });

    it('detects incomplete Vertex — missing project ID', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'us-east5',
      }));
      expect(result).toMatchObject({
        method: 'vertex',
        complete: false,
        missing: ['ANTHROPIC_VERTEX_PROJECT_ID'],
      });
    });
  });

  describe('Third-party provider authentication', () => {
    it('detects third-party with all vars', () => {
      const result = detectClaudeAuth(env({
        ANTHROPIC_BASE_URL: 'https://api.minimax.chat/v1',
        ANTHROPIC_API_KEY: 'key-123',
        ANTHROPIC_MODEL: 'MiniMax-M1',
      }));
      expect(result).toEqual({
        method: 'third-party',
        label: 'Third-party provider (https://api.minimax.chat/v1)',
        complete: true,
      });
    });

    it('detects incomplete third-party — missing key and model', () => {
      const result = detectClaudeAuth(env({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
      }));
      expect(result).toMatchObject({
        method: 'third-party',
        complete: false,
        missing: ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'],
      });
    });
  });

  describe('API key authentication', () => {
    it('detects API key', () => {
      const result = detectClaudeAuth(env({
        ANTHROPIC_API_KEY: 'sk-ant-example',
      }));
      expect(result).toEqual({
        method: 'api-key',
        label: 'Anthropic API key',
        complete: true,
      });
    });
  });

  describe('OAuth token authentication', () => {
    it('detects OAuth token', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_OAUTH_TOKEN: 'token-abc123',
      }));
      expect(result).toEqual({
        method: 'oauth-token',
        label: 'Claude OAuth token',
        complete: true,
      });
    });
  });

  describe('no authentication', () => {
    it('returns null with empty env', () => {
      expect(detectClaudeAuth(env({}))).toBeNull();
    });

    it('returns null with unrelated env vars', () => {
      expect(detectClaudeAuth(env({
        HOME: '/home/user',
        PATH: '/usr/bin',
        NODE_ENV: 'production',
      }))).toBeNull();
    });
  });

  describe('priority order', () => {
    it('Bedrock takes priority over API key', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'default',
        ANTHROPIC_API_KEY: 'sk-ant-example',
      }));
      expect(result?.method).toBe('bedrock');
    });

    it('Vertex takes priority over API key', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
        ANTHROPIC_API_KEY: 'sk-ant-example',
      }));
      expect(result?.method).toBe('vertex');
    });

    it('Bedrock takes priority over Vertex when both set', () => {
      const result = detectClaudeAuth(env({
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-west-2',
        AWS_PROFILE: 'default',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
      }));
      expect(result?.method).toBe('bedrock');
    });

    it('third-party (ANTHROPIC_BASE_URL) takes priority over plain API key', () => {
      const result = detectClaudeAuth(env({
        ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
        ANTHROPIC_API_KEY: 'key-123',
        ANTHROPIC_MODEL: 'custom-model',
      }));
      expect(result?.method).toBe('third-party');
    });

    it('API key takes priority over OAuth token', () => {
      const result = detectClaudeAuth(env({
        ANTHROPIC_API_KEY: 'sk-ant-example',
        CLAUDE_CODE_OAUTH_TOKEN: 'token-abc123',
      }));
      expect(result?.method).toBe('api-key');
    });
  });

  describe('defaults to process.env', () => {
    it('accepts no arguments (uses process.env)', () => {
      // Should not throw — returns based on current process.env
      const result = detectClaudeAuth();
      // We can't assert the exact result since it depends on the test runner's env,
      // but it should be either null or a valid detection
      if (result) {
        expect(result).toHaveProperty('method');
        expect(result).toHaveProperty('label');
        expect(result).toHaveProperty('complete');
      }
    });
  });
});

describe('CLAUDE_AUTH_ENV_KEYS', () => {
  it('includes all known auth-related env vars', () => {
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('CLAUDE_CODE_USE_BEDROCK');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('AWS_REGION');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('AWS_ACCESS_KEY_ID');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('AWS_SECRET_ACCESS_KEY');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('AWS_SESSION_TOKEN');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('AWS_PROFILE');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('CLAUDE_CODE_USE_VERTEX');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('CLOUD_ML_REGION');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_VERTEX_PROJECT_ID');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_BASE_URL');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_API_KEY');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_MODEL');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL');
    expect(CLAUDE_AUTH_ENV_KEYS).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL');
  });
});

describe('applyStoredClaudeOauthToken', () => {
  it('uses the stored token when no env token exists', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: join(tmpdir(), `missing-claude-config-${Date.now()}`),
    };

    const source = applyStoredClaudeOauthToken('stored-token', env);

    expect(source).toBe('stored');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-token');
  });

  it('lets the stored token override an inherited env token', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: join(tmpdir(), `missing-claude-config-${Date.now()}`),
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-token',
    };

    const source = applyStoredClaudeOauthToken('stored-token', env);

    expect(source).toBe('stored');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-token');
  });

  it('keeps the inherited env token when no stored token exists', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: join(tmpdir(), `missing-claude-config-${Date.now()}`),
      CLAUDE_CODE_OAUTH_TOKEN: 'env-token',
    };

    const source = applyStoredClaudeOauthToken(undefined, env);

    expect(source).toBe('env');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('env-token');
  });

  it('reports none when neither token source exists', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CONFIG_DIR: join(tmpdir(), `missing-claude-config-${Date.now()}`),
    };

    const source = applyStoredClaudeOauthToken(undefined, env);

    expect(source).toBe('none');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('lets native Claude credentials take priority over an inherited env token', () => {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
    try {
      writeFileSync(join(claudeConfigDir, '.credentials.json'), '{"claudeAiOauth":{}}');
      const env: Record<string, string | undefined> = {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-token',
      };

      const source = applyStoredClaudeOauthToken(undefined, env);

      expect(source).toBe('native-credentials');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      rmSync(claudeConfigDir, { recursive: true, force: true });
    }
  });

  it('lets native Claude credentials override the stored token', () => {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
    try {
      writeFileSync(join(claudeConfigDir, '.credentials.json'), '{"claudeAiOauth":{}}');
      const env: Record<string, string | undefined> = {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-token',
      };

      const source = applyStoredClaudeOauthToken('stored-token', env);

      expect(source).toBe('native-credentials');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      rmSync(claudeConfigDir, { recursive: true, force: true });
    }
  });
});
