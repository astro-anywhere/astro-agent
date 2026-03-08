/**
 * Tests for shared summary utilities in base-adapter.ts:
 * - parseSummaryResponse: JSON parsing with code fence stripping
 * - SUMMARY_PROMPT: prompt constant validation
 * - SUMMARY_TIMEOUT_MS: timeout constant
 */

import { describe, it, expect } from 'vitest';
import { parseSummaryResponse, SUMMARY_PROMPT, SUMMARY_TIMEOUT_MS, createNoopStream } from '../src/providers/base-adapter.js';

describe('SUMMARY_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof SUMMARY_PROMPT).toBe('string');
    expect(SUMMARY_PROMPT.length).toBeGreaterThan(100);
  });

  it('requests JSON output with all required fields', () => {
    expect(SUMMARY_PROMPT).toContain('JSON');
    expect(SUMMARY_PROMPT).toContain('"status"');
    expect(SUMMARY_PROMPT).toContain('"workCompleted"');
    expect(SUMMARY_PROMPT).toContain('"executiveSummary"');
    expect(SUMMARY_PROMPT).toContain('"keyFindings"');
    expect(SUMMARY_PROMPT).toContain('"filesChanged"');
    expect(SUMMARY_PROMPT).toContain('"followUps"');
    expect(SUMMARY_PROMPT).toContain('"prUrl"');
    expect(SUMMARY_PROMPT).toContain('"prNumber"');
    expect(SUMMARY_PROMPT).toContain('"branchName"');
  });

  it('is domain-agnostic (not specialized to coding)', () => {
    // Should NOT contain language that assumes coding context
    expect(SUMMARY_PROMPT).not.toContain('code reviewers');
    expect(SUMMARY_PROMPT).not.toContain('PR description');
  });
});

describe('SUMMARY_TIMEOUT_MS', () => {
  it('is 30 seconds', () => {
    expect(SUMMARY_TIMEOUT_MS).toBe(30_000);
  });
});

describe('parseSummaryResponse', () => {
  const prefix = '[test]';

  it('parses a valid JSON summary', () => {
    const json = JSON.stringify({
      status: 'success',
      workCompleted: 'Implemented the feature',
      executiveSummary: 'A detailed summary of the work.',
      keyFindings: ['Added API endpoint', 'Updated tests'],
      filesChanged: ['src/api.ts', 'tests/api.test.ts'],
      followUps: ['Monitor performance'],
      prUrl: 'https://github.com/org/repo/pull/42',
      prNumber: 42,
      branchName: 'feat/new-api',
    });

    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('success');
    expect(result!.workCompleted).toBe('Implemented the feature');
    expect(result!.executiveSummary).toBe('A detailed summary of the work.');
    expect(result!.keyFindings).toEqual(['Added API endpoint', 'Updated tests']);
    expect(result!.filesChanged).toEqual(['src/api.ts', 'tests/api.test.ts']);
    expect(result!.followUps).toEqual(['Monitor performance']);
    expect(result!.prUrl).toBe('https://github.com/org/repo/pull/42');
    expect(result!.prNumber).toBe(42);
    expect(result!.branchName).toBe('feat/new-api');
  });

  it('strips markdown json code fences', () => {
    const json = '```json\n{"status":"success","workCompleted":"Done","executiveSummary":"Summary","keyFindings":[],"filesChanged":[],"followUps":[]}\n```';
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('success');
  });

  it('strips plain code fences', () => {
    const json = '```\n{"status":"partial","workCompleted":"Halfway","executiveSummary":"Partial work","keyFindings":[],"filesChanged":[],"followUps":[]}\n```';
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('partial');
  });

  it('extracts JSON from surrounding text', () => {
    const text = 'Here is the summary:\n{"status":"failure","workCompleted":"Failed to build","executiveSummary":"Build errors","keyFindings":["Build failed"],"filesChanged":[],"followUps":["Fix build"]}\nDone.';
    const result = parseSummaryResponse(text, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('failure');
    expect(result!.workCompleted).toBe('Failed to build');
  });

  it('returns undefined for empty string', () => {
    expect(parseSummaryResponse('', prefix)).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseSummaryResponse('{ this is not: valid json !!! }', prefix)).toBeUndefined();
  });

  it('returns undefined for non-JSON text', () => {
    expect(parseSummaryResponse('Just some plain text without any JSON', prefix)).toBeUndefined();
  });

  it('handles JSON with whitespace', () => {
    const json = `
    {
      "status": "success",
      "workCompleted": "Spaced out",
      "executiveSummary": "With lots of whitespace",
      "keyFindings": [],
      "filesChanged": [],
      "followUps": []
    }
    `;
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('success');
  });

  it('warns when executiveSummary is missing but still returns result', () => {
    const json = JSON.stringify({
      status: 'success',
      workCompleted: 'Done',
      keyFindings: [],
      filesChanged: [],
      followUps: [],
    });
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('success');
    expect(result!.executiveSummary).toBeUndefined();
  });

  it('handles partial status', () => {
    const json = JSON.stringify({
      status: 'partial',
      workCompleted: 'Partially done',
      executiveSummary: 'Work in progress.',
      keyFindings: ['Started implementation'],
      filesChanged: ['src/index.ts'],
      followUps: ['Complete remaining work'],
    });
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('partial');
  });

  it('handles failure status', () => {
    const json = JSON.stringify({
      status: 'failure',
      workCompleted: 'Could not complete',
      executiveSummary: 'Failed due to errors.',
      keyFindings: ['Build errors'],
      filesChanged: [],
      followUps: ['Fix the build'],
    });
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.status).toBe('failure');
  });

  it('handles null prUrl and prNumber', () => {
    const json = JSON.stringify({
      status: 'success',
      workCompleted: 'Done',
      executiveSummary: 'Summary',
      keyFindings: [],
      filesChanged: [],
      followUps: [],
      prUrl: null,
      prNumber: null,
      branchName: null,
    });
    const result = parseSummaryResponse(json, prefix);
    expect(result).not.toBeUndefined();
    expect(result!.prUrl).toBeNull();
    expect(result!.prNumber).toBeNull();
    expect(result!.branchName).toBeNull();
  });
});

describe('createNoopStream', () => {
  it('returns an object with all TaskOutputStream methods', () => {
    const stream = createNoopStream();
    expect(typeof stream.stdout).toBe('function');
    expect(typeof stream.stderr).toBe('function');
    expect(typeof stream.status).toBe('function');
    expect(typeof stream.toolTrace).toBe('function');
    expect(typeof stream.text).toBe('function');
    expect(typeof stream.toolUse).toBe('function');
    expect(typeof stream.toolResult).toBe('function');
    expect(typeof stream.fileChange).toBe('function');
    expect(typeof stream.sessionInit).toBe('function');
    expect(typeof stream.approvalRequest).toBe('function');
  });

  it('approvalRequest returns { answered: false }', async () => {
    const stream = createNoopStream();
    const result = await stream.approvalRequest('question', ['yes', 'no']);
    expect(result).toEqual({ answered: false });
  });

  it('all methods are callable without errors', () => {
    const stream = createNoopStream();
    expect(() => stream.stdout('test')).not.toThrow();
    expect(() => stream.stderr('test')).not.toThrow();
    expect(() => stream.status('running', 50, 'msg')).not.toThrow();
    expect(() => stream.text('data')).not.toThrow();
    expect(() => stream.toolUse('tool', {})).not.toThrow();
    expect(() => stream.toolResult('tool', '', true)).not.toThrow();
    expect(() => stream.fileChange('path', 'created')).not.toThrow();
    expect(() => stream.sessionInit('sid')).not.toThrow();
  });
});
