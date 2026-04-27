/**
 * .worktreeinclude support
 *
 * Copies files that match both .worktreeinclude AND .gitignore patterns
 * into the worktree. This allows env files, secrets, and other gitignored
 * files to be available in isolated worktrees.
 */

import { readFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
// Static import so esbuild can bundle the module inline. The previous
// createRequire('ignore') pattern left it as a runtime require, which
// fails when the bundled .mjs ships without an adjacent node_modules/.
//
// `ignore` is a CJS module exporting a callable function with an
// attached namespace. Under `module: "NodeNext"` TypeScript merges
// the function and namespace into a single namespace type, so the
// default import isn't typed as callable. The runtime value IS the
// factory function — cast through unknown to tell TS.
import ignoreImport from 'ignore';

type Ignore = {
  add(patterns: string | readonly string[]): Ignore;
  ignores(pathname: string): boolean;
};
type IgnoreFactory = (options?: object) => Ignore;
const ignoreLib = ignoreImport as unknown as IgnoreFactory;

export interface WorktreeIncludeOptions {
  gitRoot: string;
  worktreePath: string;
  log?: (msg: string) => void;
}

export async function applyWorktreeInclude({
  gitRoot,
  worktreePath,
  log,
}: WorktreeIncludeOptions): Promise<void> {
  const includeContent = await readFileSafe(join(gitRoot, '.worktreeinclude'));
  if (!includeContent) {
    return; // No .worktreeinclude — nothing to do
  }

  const gitignoreContent = await readFileSafe(join(gitRoot, '.gitignore'));
  if (!gitignoreContent) {
    return; // No .gitignore — nothing would be both included and ignored
  }

  const includeMatcher = ignoreLib().add(includeContent);
  const ignoreMatcher = ignoreLib().add(gitignoreContent);

  const filesToCopy = await walkAndMatch(gitRoot, includeMatcher, ignoreMatcher);

  for (const relPath of filesToCopy) {
    try {
      const src = join(gitRoot, relPath);
      const dest = join(worktreePath, relPath);
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(src, dest);
      log?.(`worktree-include: copied ${relPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`worktree-include: failed to copy ${relPath}: ${msg}`);
    }
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function walkAndMatch(
  root: string,
  includeMatcher: Ignore,
  ignoreMatcher: Ignore,
  dir: string = root,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(root, fullPath);

    if (entry.isDirectory()) {
      const children = await walkAndMatch(root, includeMatcher, ignoreMatcher, fullPath);
      results.push(...children);
    } else if (entry.isFile()) {
      if (includeMatcher.ignores(relPath) && ignoreMatcher.ignores(relPath)) {
        results.push(relPath);
      }
    }
  }

  return results;
}
