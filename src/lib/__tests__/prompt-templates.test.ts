/**
 * Tests for prompt template builders
 */

import { describe, it, expect } from 'vitest';

import {
  PLAN_GRAPH_SCHEMA,
  buildPlanSystemPrompt,
  buildChatSystemPrompt,
  buildTaskExecutionPrompt,
  buildSummaryPrompt,
  buildTaskChatSystemPrompt,
} from '../prompt-templates.js';

describe('PLAN_GRAPH_SCHEMA', () => {
  it('should be a valid JSON-serializable object', () => {
    const json = JSON.stringify(PLAN_GRAPH_SCHEMA);
    const parsed = JSON.parse(json);

    expect(parsed).toBeDefined();
    expect(parsed.type).toBe('object');
  });

  it('should have required top-level properties', () => {
    expect(PLAN_GRAPH_SCHEMA.required).toEqual(['projectName', 'nodes', 'edges']);
  });

  it('should define projectName, nodes, and edges properties', () => {
    expect(PLAN_GRAPH_SCHEMA.properties.projectName).toBeDefined();
    expect(PLAN_GRAPH_SCHEMA.properties.nodes).toBeDefined();
    expect(PLAN_GRAPH_SCHEMA.properties.edges).toBeDefined();
  });

  it('should define nodes as an array with required item fields', () => {
    const nodes = PLAN_GRAPH_SCHEMA.properties.nodes;
    expect(nodes.type).toBe('array');
    expect(nodes.items.required).toContain('id');
    expect(nodes.items.required).toContain('type');
    expect(nodes.items.required).toContain('title');
    expect(nodes.items.required).toContain('description');
    expect(nodes.items.required).toContain('status');
  });

  it('should define edges as an array with required item fields', () => {
    const edges = PLAN_GRAPH_SCHEMA.properties.edges;
    expect(edges.type).toBe('array');
    expect(edges.items.required).toContain('id');
    expect(edges.items.required).toContain('source');
    expect(edges.items.required).toContain('target');
    expect(edges.items.required).toContain('type');
  });
});

describe('buildPlanSystemPrompt', () => {
  it('should return a string containing node rules and constraints', () => {
    const prompt = buildPlanSystemPrompt();

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('## Node rules');
    expect(prompt).toContain('## Edge rules');
    expect(prompt).toContain('## Constraints');
  });

  it('should include vision document when provided', () => {
    const prompt = buildPlanSystemPrompt('Build a weather app');

    expect(prompt).toContain('## Project Vision Document');
    expect(prompt).toContain('<user_vision>');
    expect(prompt).toContain('Build a weather app');
    expect(prompt).toContain('</user_vision>');
  });

  it('should not include vision section when no vision doc is provided', () => {
    const prompt = buildPlanSystemPrompt();

    expect(prompt).not.toContain('## Project Vision Document');
    expect(prompt).not.toContain('<user_vision>');
  });

  it('should include repo context when provided (without file tree)', () => {
    const prompt = buildPlanSystemPrompt(undefined, {
      claudeMd: '# My Project\nSome instructions',
      readmeMd: '# README\nProject readme',
      packageInfo: '{"name": "my-package"}',
      fileTreeSummary: 'src/index.ts\nsrc/utils.ts',
    });

    expect(prompt).toContain('## CLAUDE.md (Project Instructions)');
    expect(prompt).toContain('Some instructions');
    expect(prompt).toContain('## README.md');
    expect(prompt).toContain('Project readme');
    expect(prompt).toContain('## Package Metadata');
    expect(prompt).toContain('my-package');
    // File tree is intentionally excluded from prompt (used for autocompletion only)
    expect(prompt).not.toContain('## File Tree');
    expect(prompt).not.toContain('src/index.ts');
  });

  it('should use tool-based instructions when repo context is provided', () => {
    const prompt = buildPlanSystemPrompt(undefined, {
      claudeMd: 'something',
    });

    expect(prompt).toContain('access to the repository');
    expect(prompt).toContain('tools (Read, Glob, Grep)');
  });

  it('should use JSON-only instructions when no repo context is provided', () => {
    const prompt = buildPlanSystemPrompt();

    expect(prompt).toContain('JSON-only project planning API');
  });

  it('should contain the example JSON structure', () => {
    const prompt = buildPlanSystemPrompt();

    expect(prompt).toContain('"projectName"');
    expect(prompt).toContain('"nodes"');
    expect(prompt).toContain('"edges"');
  });
});

describe('buildChatSystemPrompt', () => {
  it('should return a string mentioning plan updates', () => {
    const prompt = buildChatSystemPrompt();

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Modifying the Plan');
    expect(prompt).toContain('astro-updates');
  });

  it('should include vision document when provided', () => {
    const prompt = buildChatSystemPrompt('My project vision');

    expect(prompt).toContain('## Project Vision Document');
    expect(prompt).toContain('My project vision');
  });

  it('should include plan nodes when provided', () => {
    const nodes = [
      {
        id: 'n1',
        title: 'Setup project',
        description: 'Initialize repo',
        status: 'planned',
        type: 'task',
        priority: 'medium',
        estimate: 'S',
        milestoneId: 'n2',
        dependencies: [],
      },
      {
        id: 'n2',
        title: 'MVP Complete',
        description: 'Milestone',
        status: 'planned',
        type: 'milestone',
        dependencies: ['n1'],
      },
    ];

    const prompt = buildChatSystemPrompt(undefined, nodes);

    expect(prompt).toContain('## Current Plan Nodes');
    expect(prompt).toContain('Setup project');
    expect(prompt).toContain('MVP Complete');
    expect(prompt).toContain('## Available Milestones');
  });

  it('should include edges when provided', () => {
    const nodes = [
      { id: 'n1', title: 'Task 1', description: 'D1', status: 'planned', type: 'task' },
      { id: 'n2', title: 'Task 2', description: 'D2', status: 'planned', type: 'task' },
    ];
    const edges = [
      { source: 'n1', target: 'n2', type: 'dependency' },
    ];

    const prompt = buildChatSystemPrompt(undefined, nodes, edges);

    expect(prompt).toContain('## Current Edges (Dependencies)');
    expect(prompt).toContain('Task 1 [n1]');
    expect(prompt).toContain('Task 2 [n2]');
  });

  it('should mention astro-edges for edge management', () => {
    const prompt = buildChatSystemPrompt();

    expect(prompt).toContain('astro-edges');
  });

  it('should mention astro-add-nodes for decomposition', () => {
    const prompt = buildChatSystemPrompt();

    expect(prompt).toContain('astro-add-nodes');
  });

  it('should instruct against using tools', () => {
    const prompt = buildChatSystemPrompt();

    expect(prompt).toContain('Do NOT use any tools');
  });
});

describe('buildTaskExecutionPrompt', () => {
  it('should assemble vision doc, deps, and description', () => {
    const prompt = buildTaskExecutionPrompt({
      taskTitle: 'Implement login',
      taskDescription: 'Add OAuth2 login flow',
      visionDoc: 'Build a secure auth system',
      dependencyOutputs: 'Task "Setup DB" completed: schema created.',
    });

    expect(prompt).toContain('## Project Vision');
    expect(prompt).toContain('Build a secure auth system');
    expect(prompt).toContain('## Previous Task Outputs');
    expect(prompt).toContain('Task "Setup DB" completed');
    expect(prompt).toContain('## Current Task');
    expect(prompt).toContain('**Implement login**');
    expect(prompt).toContain('Add OAuth2 login flow');
    expect(prompt).toContain('## Instructions');
  });

  it('should omit vision section when not provided', () => {
    const prompt = buildTaskExecutionPrompt({
      taskTitle: 'Fix bug',
      taskDescription: 'Fix the login bug',
    });

    expect(prompt).not.toContain('## Project Vision');
    expect(prompt).toContain('**Fix bug**');
  });

  it('should omit dependency outputs when not provided', () => {
    const prompt = buildTaskExecutionPrompt({
      taskTitle: 'First task',
      taskDescription: 'No dependencies',
    });

    expect(prompt).not.toContain('## Previous Task Outputs');
  });

  it('should include working directory when provided', () => {
    const prompt = buildTaskExecutionPrompt({
      taskTitle: 'Build feature',
      taskDescription: 'Implement the feature',
      workingDirectory: '/home/user/project',
    });

    expect(prompt).toContain('## Working Directory');
    expect(prompt).toContain('/home/user/project');
  });

  it('should use user_task delimiters for security', () => {
    const prompt = buildTaskExecutionPrompt({
      taskTitle: 'Task',
      taskDescription: 'Description',
    });

    expect(prompt).toContain('<user_task>');
    expect(prompt).toContain('</user_task>');
  });
});

describe('buildSummaryPrompt', () => {
  it('should return a string for summarization', () => {
    const prompt = buildSummaryPrompt({
      taskTitle: 'Implement API',
      taskDescription: 'Build REST endpoints',
      executionOutput: 'All tests pass. 5 endpoints created.',
      fileChanges: [
        { path: 'src/api.ts', action: 'modified' },
        { path: 'src/routes.ts', action: 'created' },
      ],
      status: 'success',
    });

    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('task execution summarizer');
    expect(prompt).toContain('**Implement API**');
    expect(prompt).toContain('Build REST endpoints');
    expect(prompt).toContain('All tests pass');
    expect(prompt).toContain('modified: src/api.ts');
    expect(prompt).toContain('created: src/routes.ts');
    expect(prompt).toContain('Execution Status: success');
  });

  it('should truncate long execution output', () => {
    const longOutput = 'x'.repeat(20_000);

    const prompt = buildSummaryPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      executionOutput: longOutput,
      fileChanges: [],
      status: 'success',
    });

    // Output should be truncated to 15000 chars with prefix
    expect(prompt).toContain('...\n');
    expect(prompt).not.toContain('x'.repeat(20_000));
    expect(prompt).toContain('x'.repeat(100)); // Should contain some of the content
  });

  it('should handle empty file changes', () => {
    const prompt = buildSummaryPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      executionOutput: 'done',
      fileChanges: [],
      status: 'failure',
    });

    expect(prompt).toContain('No file changes recorded.');
    expect(prompt).toContain('Execution Status: failure');
  });

  it('should include JSON response format instructions', () => {
    const prompt = buildSummaryPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      executionOutput: 'done',
      fileChanges: [],
      status: 'success',
    });

    expect(prompt).toContain('"workCompleted"');
    expect(prompt).toContain('"filesChanged"');
    expect(prompt).toContain('"followUps"');
  });
});

describe('buildTaskChatSystemPrompt', () => {
  it('should include task title and description', () => {
    const prompt = buildTaskChatSystemPrompt({
      taskTitle: 'Fix auth bug',
      taskDescription: 'Tokens expire too early',
    });

    expect(prompt).toContain('**Fix auth bug**');
    expect(prompt).toContain('Tokens expire too early');
  });

  it('should include vision doc when provided', () => {
    const prompt = buildTaskChatSystemPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      visionDoc: 'Project vision here',
    });

    expect(prompt).toContain('## Project Vision');
    expect(prompt).toContain('Project vision here');
  });

  it('should include task output when provided', () => {
    const prompt = buildTaskChatSystemPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      taskOutput: 'Execution result: success',
    });

    expect(prompt).toContain('## Task Output');
    expect(prompt).toContain('Execution result: success');
  });

  it('should truncate long task output', () => {
    const longOutput = 'y'.repeat(15_000);

    const prompt = buildTaskChatSystemPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
      taskOutput: longOutput,
    });

    expect(prompt).toContain('[... output truncated ...]');
  });

  it('should omit task output section when not provided', () => {
    const prompt = buildTaskChatSystemPrompt({
      taskTitle: 'Task',
      taskDescription: 'Desc',
    });

    expect(prompt).not.toContain('## Task Output');
  });
});
