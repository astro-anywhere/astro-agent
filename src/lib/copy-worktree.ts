import { mkdir, cp, rm, readdir, stat, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { execFile } from 'node:child_process';

export interface CopyWorktreeResult {
  worktreePath: string;
  cleanup: () => Promise<void>;
}

export interface ReferenceWorktreeResult {
  worktreePath: string;
  fileMap: FileMapEntry[];
  cleanup: () => Promise<void>;
}

export interface FileMapEntry {
  relativePath: string;
  sizeBytes: number;
  classification: 'code' | 'data';
}

export interface ApplyChangesResult {
  created: string[];
  modified: string[];
  deleted: string[];
}

const CODE_SIZE_THRESHOLD = 1_000_000; // 1MB

/** Hardcoded directory names that are always excluded, regardless of .gitignore. */
const ALWAYS_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

// ---------------------------------------------------------------------------
// Gitignore pattern support
// ---------------------------------------------------------------------------

/**
 * Load .gitignore patterns from a directory.
 * Returns an empty array if no .gitignore exists.
 */
export async function loadGitignorePatterns(sourceDir: string): Promise<string[]> {
  const gitignorePath = join(sourceDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [];
  }
  try {
    const content = await readFile(gitignorePath, 'utf-8');
    return parseGitignoreContent(content);
  } catch {
    return [];
  }
}

/**
 * Parse raw .gitignore content into an array of usable patterns.
 * Strips comments, blank lines, and negation patterns (for simplicity).
 */
export function parseGitignoreContent(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (line === '') return false;       // blank
      if (line.startsWith('#')) return false; // comment
      if (line.startsWith('!')) return false; // negation — skip for simplicity
      return true;
    });
}

/**
 * Check whether a relative path matches any gitignore pattern.
 *
 * Supported pattern features:
 *  - `*` matches any sequence of characters except `/`
 *  - `**` matches everything (including `/`)
 *  - Trailing `/` means the pattern only matches directories
 *  - Leading `/` anchors the pattern to the root
 *  - Bare name without `/` matches any basename in the tree
 *  - Patterns with an interior `/` (non-leading, non-trailing) are anchored
 */
export function isIgnoredByPattern(
  /** Path relative to the project root, using `/` separators */
  relativePath: string,
  patterns: string[],
  /** Whether the path is a directory */
  isDirectory: boolean,
): boolean {
  for (const raw of patterns) {
    if (matchGitignorePattern(relativePath, raw, isDirectory)) {
      return true;
    }
  }
  return false;
}

/**
 * Match a single gitignore pattern against a relative path.
 */
function matchGitignorePattern(
  relativePath: string,
  rawPattern: string,
  isDirectory: boolean,
): boolean {
  let pattern = rawPattern;

  // Trailing slash → directory-only pattern
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) {
    if (!isDirectory) return false;
    pattern = pattern.slice(0, -1);
  }

  // Leading slash → anchored to root; strip the slash for matching
  const anchored = pattern.startsWith('/');
  if (anchored) {
    pattern = pattern.slice(1);
  }

  // Determine if the pattern should be anchored:
  //  - explicitly via leading `/`
  //  - implicitly if it contains an interior `/`
  const hasInteriorSlash = pattern.includes('/');
  const isAnchored = anchored || hasInteriorSlash;

  if (isAnchored) {
    // Match against the full relative path
    return globMatch(relativePath, pattern);
  }

  // Un-anchored pattern without `/` → match against any component or basename
  // e.g. `*.pyc` matches `foo/bar/baz.pyc`
  // Check the full path first (handles `*` matching within segments)
  if (globMatch(relativePath, pattern)) return true;
  // Check each path segment individually
  const segments = relativePath.split('/');
  // For a directory match, the last segment is the directory name itself
  for (const segment of segments) {
    if (globMatch(segment, pattern)) return true;
  }
  return false;
}

/**
 * Simple glob matcher supporting `*` (any chars except `/`) and `**` (anything).
 * Converts the pattern to a RegExp.
 */
function globMatch(text: string, pattern: string): boolean {
  // Build a regex from the glob pattern
  let regex = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — match everything including `/`
        // `**/` matches zero or more directories
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        // `*` — match anything except `/`
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if (ch === '.') {
      regex += '\\.';
      i += 1;
    } else if (ch === '+' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '^' || ch === '$' || ch === '|' || ch === '\\') {
      regex += '\\' + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += '$';

  try {
    return new RegExp(regex).test(text);
  } catch {
    return false;
  }
}

/**
 * Try to get the list of git-ignored paths using `git ls-files`.
 * Only works inside a git repository. Returns null on failure.
 */
async function getGitIgnoredPaths(sourceDir: string): Promise<Set<string> | null> {
  // Quick check: is this a git repo?
  if (!existsSync(join(sourceDir, '.git'))) {
    return null;
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: sourceDir, timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const paths = new Set(
          stdout
            .split('\n')
            .map((p) => p.replace(/\/$/, '').trim())
            .filter(Boolean),
        );
        resolve(paths);
      },
    );
  });
}

/**
 * Copy project directory to a worktree-like path for non-git execution.
 * Excludes the agent directory and respects .gitignore patterns.
 */
export async function createCopyWorktree(
  sourceDir: string,
  agentDirName: string,
  taskId: string,
): Promise<CopyWorktreeResult> {
  const worktreePath = join(sourceDir, agentDirName, 'worktrees', sanitize(taskId));

  // Clean up any existing worktree at this path
  if (existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
  }

  await mkdir(worktreePath, { recursive: true });

  // Try git-based ignore list first (most accurate), fall back to manual parsing
  const gitIgnored = await getGitIgnoredPaths(sourceDir);
  const gitignorePatterns = gitIgnored ? [] : await loadGitignorePatterns(sourceDir);

  // Copy source directory, excluding agent dir and ignored paths
  await copyDirectoryFiltered(sourceDir, worktreePath, agentDirName, sourceDir, gitIgnored, gitignorePatterns);

  return {
    worktreePath,
    cleanup: async () => {
      await rm(worktreePath, { recursive: true, force: true });
    },
  };
}

/**
 * Create a reference worktree (empty directory with file map).
 * Used for large projects where copying would be too slow.
 */
export async function createReferenceWorktree(
  sourceDir: string,
  agentDirName: string,
  taskId: string,
): Promise<ReferenceWorktreeResult> {
  const worktreePath = join(sourceDir, agentDirName, 'worktrees', sanitize(taskId));

  if (existsSync(worktreePath)) {
    await rm(worktreePath, { recursive: true, force: true });
  }

  await mkdir(worktreePath, { recursive: true });

  const fileMap = await generateFileMap(sourceDir, agentDirName);

  return {
    worktreePath,
    fileMap,
    cleanup: async () => {
      await rm(worktreePath, { recursive: true, force: true });
    },
  };
}

/**
 * Generate a file listing with size classifications.
 * Files < 1MB are classified as 'code', >= 1MB as 'data'.
 */
export async function generateFileMap(
  sourceDir: string,
  agentDirName: string,
): Promise<FileMapEntry[]> {
  const entries: FileMapEntry[] = [];

  async function walk(dir: string) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      const relPath = relative(sourceDir, fullPath);

      // Skip agent dir, .git, node_modules
      if (item.name === agentDirName || item.name === '.git' || item.name === 'node_modules') {
        continue;
      }

      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        try {
          const stats = await stat(fullPath);
          entries.push({
            relativePath: relPath,
            sizeBytes: stats.size,
            classification: stats.size < CODE_SIZE_THRESHOLD ? 'code' : 'data',
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  await walk(sourceDir);
  return entries;
}

/**
 * Recursively copy a directory, excluding the agent dir, always-excluded dirs,
 * and paths matched by .gitignore patterns or `git ls-files` output.
 */
async function copyDirectoryFiltered(
  src: string,
  dest: string,
  agentDirName: string,
  rootDir: string,
  gitIgnoredPaths: Set<string> | null,
  gitignorePatterns: string[],
): Promise<void> {
  const items = await readdir(src, { withFileTypes: true });

  for (const item of items) {
    // Always skip agent dir and hardcoded exclusions
    if (item.name === agentDirName || ALWAYS_EXCLUDED_DIRS.has(item.name)) {
      continue;
    }

    const srcPath = join(src, item.name);
    const relPath = relative(rootDir, srcPath).split(sep).join('/');

    // Check against git ls-files output (most accurate, if available)
    if (gitIgnoredPaths && gitIgnoredPaths.has(relPath)) {
      continue;
    }

    // Check against parsed .gitignore patterns (fallback for non-git dirs)
    if (gitignorePatterns.length > 0 && isIgnoredByPattern(relPath, gitignorePatterns, item.isDirectory())) {
      continue;
    }

    const destPath = join(dest, item.name);

    if (item.isDirectory()) {
      // Recurse into subdirectories so we can filter at every level
      await mkdir(destPath, { recursive: true });
      await copyDirectoryFiltered(srcPath, destPath, agentDirName, rootDir, gitIgnoredPaths, gitignorePatterns);
    } else {
      await cp(srcPath, destPath);
    }
  }
}

/**
 * Compare a worktree copy against the original directory and apply changes back.
 *
 * - New files (exist in worktree but not original): copied to original
 * - Modified files (different content): copied to original
 * - Deleted files (exist in original but not worktree): reported but NOT deleted
 *
 * Excludes the agent dir, .git, and node_modules from comparison.
 *
 * Returns lists of created, modified, and deleted (pending) relative paths.
 */
export async function applyChangesFromCopy(
  worktreePath: string,
  originalDir: string,
  agentDirName: string,
): Promise<ApplyChangesResult> {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  const excludedDirs = new Set([agentDirName, ...ALWAYS_EXCLUDED_DIRS]);

  // Walk the worktree to find new and modified files
  async function walkWorktree(dir: string) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      const relPath = relative(worktreePath, fullPath);

      if (excludedDirs.has(item.name)) continue;

      if (item.isDirectory()) {
        await walkWorktree(fullPath);
      } else if (item.isFile()) {
        const originalPath = join(originalDir, relPath);

        if (!existsSync(originalPath)) {
          // New file — copy to original
          await mkdir(dirname(originalPath), { recursive: true });
          await copyFile(fullPath, originalPath);
          created.push(relPath);
        } else {
          // Check if content differs
          try {
            const worktreeContent = await readFile(fullPath);
            const originalContent = await readFile(originalPath);
            if (!worktreeContent.equals(originalContent)) {
              await copyFile(fullPath, originalPath);
              modified.push(relPath);
            }
          } catch {
            // If we can't read either file, skip
          }
        }
      }
    }
  }

  // Walk the original directory to find deleted files
  async function walkOriginal(dir: string) {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      const relPath = relative(originalDir, fullPath);

      if (excludedDirs.has(item.name)) continue;

      if (item.isDirectory()) {
        await walkOriginal(fullPath);
      } else if (item.isFile()) {
        const worktreeFile = join(worktreePath, relPath);
        if (!existsSync(worktreeFile)) {
          deleted.push(relPath);
        }
      }
    }
  }

  await walkWorktree(worktreePath);
  await walkOriginal(originalDir);

  return { created, modified, deleted };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
