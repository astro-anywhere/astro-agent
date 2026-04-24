/**
 * HIPAA preflight.
 *
 * This module's SOLE purpose is to run `assertHipaaBedrockEnv()` at top level
 * so that importing it BEFORE `@anthropic-ai/claude-agent-sdk` (or any module
 * that statically imports the SDK, such as `claude-sdk-adapter.ts`) guarantees
 * the HIPAA check fires first.
 *
 * ES modules evaluate static imports in source order, so any module that
 * lists this import before other SDK-touching imports is provably fail-closed:
 * if the environment is misconfigured under `ASTRO_HIPAA_MODE=true`, this
 * module throws during its own evaluation and no downstream module (including
 * the Claude SDK) gets a chance to load.
 *
 * Do not add any other exports or side effects to this file — keeping it
 * minimal is load-bearing.
 */
import { assertHipaaBedrockEnv } from './hipaa-startup-check.js';

assertHipaaBedrockEnv();
