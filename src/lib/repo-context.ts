/**
 * Repo Context Reader
 *
 * Reads key files from a working directory and returns their contents
 * for injection into plan generation prompts.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE_CAP = 15_000 // 15KB cap for CLAUDE.md and README
const PKG_CAP = 5_000   // 5KB cap for package metadata
const FILE_TREE_CAP = 3000 // max files to show in tree summary

/** File extensions to deprioritize (config, generated, non-source) */
const LOW_PRIORITY_PATTERNS = [
  /\.lock$/,
  /-lock\./,  // package-lock.json, etc.
  /\.min\.[jt]sx?$/,
  /\.d\.ts$/,
  /\.map$/,
  /\.snap$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /\.pdf$/,
  /^\./,  // dotfiles
]

/** Directories to deprioritize (matches anywhere in path, including nested) */
const LOW_PRIORITY_DIRS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.git\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)__pycache__\//,
  /\.egg-info\//,
  /(?:^|\/)vendor\//,
]

function isLowPriority(filePath: string): boolean {
  if (LOW_PRIORITY_DIRS.some(p => p.test(filePath))) return true

  // Treat any file inside a dot-directory (e.g. .github/, .vscode/) as low priority
  const segments = filePath.split('/')
  if (segments.some(seg => seg.length > 1 && seg[0] === '.' && seg !== '..')) return true

  const basename = filePath.split('/').pop() ?? filePath
  if (LOW_PRIORITY_PATTERNS.some(p => p.test(basename))) return true
  return false
}

/**
 * Sort files: source files first, config/generated last.
 * Within each group, preserve original order (usually alphabetical from git ls-files).
 * Optimized to avoid unnecessary allocations when result will be truncated.
 */
function smartSortFiles(files: string[]): string[] {
  const high: string[] = []
  const low: string[] = []
  for (const f of files) {
    if (isLowPriority(f)) {
      low.push(f)
    } else {
      high.push(f)
    }
  }

  // If we have more high-priority files than the cap, return only those
  if (high.length >= FILE_TREE_CAP) {
    return high.slice(0, FILE_TREE_CAP)
  }

  // Otherwise, return all high-priority files + low-priority files up to cap
  return [...high, ...low.slice(0, FILE_TREE_CAP - high.length)]
}

export interface RepoContextResult {
  claudeMd?: string
  readmeMd?: string
  packageInfo?: string
  fileTreeSummary?: string
}

function readFileCapped(path: string, cap: number): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const content = readFileSync(path, 'utf-8')
    if (content.length > cap) {
      return content.slice(0, cap) + '\n\n[... truncated ...]'
    }
    return content
  } catch {
    return undefined
  }
}

/**
 * Read key files from a working directory for context injection.
 * When workingDirectory is empty/falsy, only the file tree is used (remote repo case).
 */
export function readRepoContext(workingDirectory: string, fileTree?: string[]): RepoContextResult {
  const result: RepoContextResult = {}

  // Only read files if we have a valid local working directory
  if (workingDirectory && existsSync(workingDirectory)) {
    // Read CLAUDE.md
    result.claudeMd = readFileCapped(join(workingDirectory, 'CLAUDE.md'), FILE_CAP)

    // Read README.md (try both cases)
    result.readmeMd =
      readFileCapped(join(workingDirectory, 'README.md'), FILE_CAP) ??
      readFileCapped(join(workingDirectory, 'readme.md'), FILE_CAP)

    // Read first package metadata found
    const packageFiles = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
    for (const pkg of packageFiles) {
      const content = readFileCapped(join(workingDirectory, pkg), PKG_CAP)
      if (content) {
        result.packageInfo = `# ${pkg}\n${content}`
        break
      }
    }
  }

  // Format file tree summary with smart filtering
  if (fileTree && fileTree.length > 0) {
    const total = fileTree.length
    const shown = smartSortFiles(fileTree)
    const lines = shown.join('\n')
    result.fileTreeSummary = total > FILE_TREE_CAP
      ? `${lines}\n\n... and ${total - FILE_TREE_CAP} more files (${total} total)`
      : lines
  }

  return result
}
