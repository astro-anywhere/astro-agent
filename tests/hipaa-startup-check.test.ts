import { describe, it, expect } from 'vitest';
import { assertHipaaBedrockEnv } from '../src/providers/hipaa-startup-check.js';

describe('assertHipaaBedrockEnv', () => {
  it('is a no-op when ASTRO_HIPAA_MODE is not set', () => {
    expect(() => assertHipaaBedrockEnv({})).not.toThrow();
  });

  it('is a no-op when ASTRO_HIPAA_MODE is not "true"', () => {
    expect(() => assertHipaaBedrockEnv({ ASTRO_HIPAA_MODE: 'false' })).not.toThrow();
  });

  it('throws when HIPAA mode is on but CLAUDE_CODE_USE_BEDROCK is missing', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      }),
    ).toThrow(/CLAUDE_CODE_USE_BEDROCK=1/);
  });

  it('throws when AWS_REGION is missing', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      }),
    ).toThrow(/AWS_REGION/);
  });

  it('throws when ANTHROPIC_MODEL is missing', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
      }),
    ).toThrow(/ANTHROPIC_MODEL/);
  });

  it('throws when ANTHROPIC_API_KEY is present (forbidden in HIPAA mode)', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here',
      }),
    ).toThrow(/ANTHROPIC_API_KEY must not be set/);
  });

  it('aggregates multiple missing requirements in the error message', () => {
    expect(() =>
      assertHipaaBedrockEnv({ ASTRO_HIPAA_MODE: 'true' }),
    ).toThrow(/CLAUDE_CODE_USE_BEDROCK=1.*AWS_REGION.*ANTHROPIC_MODEL/s);
  });

  it('does not throw when all Bedrock env vars are correctly configured', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      }),
    ).not.toThrow();
  });
});
