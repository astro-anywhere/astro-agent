/**
 * Integration tests for agent-runner worktree operations.
 *
 * These tests use REAL git repos in temporary directories -- no mocking of
 * git or filesystem operations.  Only the worktree-include and worktree-setup
 * modules are mocked because they depend on astro config files that will not
 * exist in the throwaway test repos.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock worktree-include and worktree-setup (they depend on project-specific
// config files that won't exist in our ephemeral test repos).
// ---------------------------------------------------------------------------
vi.mock('../src/lib/worktree-include.js', () => ({
  applyWorktreeInclude: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/worktree-setup.js', () => ({
  runSetupScript: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Import the functions under test (from compiled JS output).
// ---------------------------------------------------------------------------
import {
  createWorktree,
  removeLingeringWorktrees,
} from '../../src/lib/worktree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Directories created during tests -- cleaned up in afterAll. */
const tmpDirs: string[] = [];

/**
 * Create a real git repository with:
 *  - one initial commit containing `hello.txt`
 *  - a bare remote set as `origin`
 *  - `main` branch pushed to origin
 */
function createTestGitRepo(): { repoDir: string; bareDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'astro-wt-test-repo-'));
  const bareDir = mkdtempSync(join(tmpdir(), 'astro-wt-test-bare-'));
  tmpDirs.push(repoDir, bareDir);

  // Create bare remote
  execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bareDir });

  // Create local repo
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoDir,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

  // Add origin
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir });

  // Create initial commit
  writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });

  // Push to origin so that origin/main exists
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });

  return { repoDir, bareDir };
}

// ---------------------------------------------------------------------------
// Cleanup all temp dirs after the suite
// ---------------------------------------------------------------------------
afterAll(async () => {
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent-runner worktree (real git)', { timeout: 30_000 }, () => {
  // 1. Default config -------------------------------------------------------
  it('creates a worktree with default config and cleans up', async () => {
    const { repoDir } = createTestGitRepo();

    const result = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-1',
    });

    expect(result).not.toBeNull();
    const setup = result!;

    // Working directory should be under {gitRoot}/.astro/worktrees/test-task-1
    expect(setup.workingDirectory).toContain(
      join('.astro', 'worktrees', 'test-task-1'),
    );

    // Branch name should use the default "astro/" prefix
    expect(setup.branchName).toMatch(/^astro\//);
    expect(setup.branchName).toBe('astro/test-task-1');

    // The worktree directory must actually exist
    expect(existsSync(setup.workingDirectory)).toBe(true);

    // The committed file must be present in the worktree
    const helloPath = join(setup.workingDirectory, 'hello.txt');
    expect(existsSync(helloPath)).toBe(true);
    expect(readFileSync(helloPath, 'utf-8')).toBe('hello world\n');

    // .gitignore in the repo root should contain the agent directory entries
    const gitignorePath = join(repoDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    expect(gitignoreContent).toContain('.astro/');

    // Cleanup should remove the worktree directory
    await setup.cleanup();
    expect(existsSync(setup.workingDirectory)).toBe(false);
  });

  // 2. Custom agentDir ------------------------------------------------------
  it('creates a worktree with a custom agentDir', async () => {
    const { repoDir } = createTestGitRepo();

    const result = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-2',
      agentDir: '.myagent',
    });

    expect(result).not.toBeNull();
    const setup = result!;

    // Worktree path should use the custom agent directory
    expect(setup.workingDirectory).toContain(
      join('.myagent', 'worktrees', 'test-task-2'),
    );
    expect(existsSync(setup.workingDirectory)).toBe(true);

    // .gitignore should reference .myagent/ entries
    const gitignoreContent = readFileSync(
      join(repoDir, '.gitignore'),
      'utf-8',
    );
    expect(gitignoreContent).toContain('.myagent/worktrees/');
    expect(gitignoreContent).toContain('.myagent/cache/');

    await setup.cleanup();
  });

  // 3. Branch prefix from config.json ---------------------------------------
  it('reads branch prefix from config.json', async () => {
    const { repoDir } = createTestGitRepo();

    // Write a config.json with a custom branch prefix
    const configDir = join(repoDir, '.astro');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ branchPrefix: 'custom/' }),
    );

    const result = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-3',
    });

    expect(result).not.toBeNull();
    expect(result!.branchName).toBe('custom/test-task-3');

    await result!.cleanup();
  });

  // 4. Re-execution: same taskId cleans up old worktree ----------------------
  it('handles re-execution with the same taskId', async () => {
    const { repoDir } = createTestGitRepo();

    // First creation
    const first = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-4',
    });
    expect(first).not.toBeNull();
    const firstDir = first!.workingDirectory;
    expect(existsSync(firstDir)).toBe(true);

    // Second creation with the same taskId (simulates re-execution).
    // The implementation removes lingering worktrees on the same branch
    // before creating a new one.
    const second = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-4',
    });
    expect(second).not.toBeNull();
    expect(existsSync(second!.workingDirectory)).toBe(true);

    // The second worktree should be in the same location
    expect(second!.workingDirectory).toBe(firstDir);

    await second!.cleanup();
  });

  // 5. removeLingeringWorktrees ---------------------------------------------
  it('removes a lingering worktree by branch name', async () => {
    const { repoDir } = createTestGitRepo();

    // Create a worktree so there is something to remove
    const result = await createWorktree({
      workingDirectory: repoDir,
      taskId: 'test-task-5',
    });
    expect(result).not.toBeNull();
    const wtDir = result!.workingDirectory;
    expect(existsSync(wtDir)).toBe(true);

    // Use removeLingeringWorktrees to remove it by branch name
    await removeLingeringWorktrees(repoDir, result!.branchName);

    // The worktree directory should be gone
    expect(existsSync(wtDir)).toBe(false);

    // Verify git no longer lists the worktree
    const wtList = execFileSync(
      'git',
      ['-C', repoDir, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf-8' },
    );
    expect(wtList).not.toContain(result!.branchName);
  });

  // 6. Non-git directory throws ---------------------------------------------
  it('throws for a non-git directory', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'astro-wt-test-plain-'));
    tmpDirs.push(plainDir);

    await expect(
      createWorktree({
        workingDirectory: plainDir,
        taskId: 'test-task-nongit',
      }),
    ).rejects.toThrow('Not a git repository');
  });

  // 7. No commits throws ----------------------------------------------------
  it('throws for a git repo with no commits', async () => {
    const emptyGitDir = mkdtempSync(join(tmpdir(), 'astro-wt-test-empty-'));
    tmpDirs.push(emptyGitDir);

    execFileSync('git', ['init'], { cwd: emptyGitDir });

    await expect(
      createWorktree({
        workingDirectory: emptyGitDir,
        taskId: 'test-task-nocommits',
      }),
    ).rejects.toThrow('no commits');
  });
});
