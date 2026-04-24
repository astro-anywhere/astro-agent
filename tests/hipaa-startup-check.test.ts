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
    ).toThrow(/forbidden present:.*ANTHROPIC_API_KEY must not be set/);
  });

  it('aggregates multiple missing requirements in the error message', () => {
    expect(() =>
      assertHipaaBedrockEnv({ ASTRO_HIPAA_MODE: 'true' }),
    ).toThrow(/missing required:.*CLAUDE_CODE_USE_BEDROCK=1.*AWS_REGION.*ANTHROPIC_MODEL/s);
  });

  it('separates missing and forbidden categories in the error message', () => {
    expect(() =>
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here',
      }),
    ).toThrow(/missing required:.*forbidden present:/s);
  });

  it('does not include forbidden category when no forbidden vars are present', () => {
    try {
      assertHipaaBedrockEnv({ ASTRO_HIPAA_MODE: 'true' });
    } catch (err) {
      expect((err as Error).message).toMatch(/missing required:/);
      expect((err as Error).message).not.toMatch(/forbidden present:/);
      return;
    }
    throw new Error('expected assertHipaaBedrockEnv to throw');
  });

  it('does not include missing category when only forbidden vars are the problem', () => {
    try {
      assertHipaaBedrockEnv({
        ASTRO_HIPAA_MODE: 'true',
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: 'us-east-1',
        ANTHROPIC_MODEL: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        ANTHROPIC_API_KEY: 'sk-ant-should-not-be-here',
      });
    } catch (err) {
      expect((err as Error).message).toMatch(/forbidden present:/);
      expect((err as Error).message).not.toMatch(/missing required:/);
      return;
    }
    throw new Error('expected assertHipaaBedrockEnv to throw');
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
