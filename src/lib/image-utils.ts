/**
 * Shared image utilities for multimodal dispatch.
 *
 * Used by both Claude SDK and Codex adapters to write task-attached images
 * to disk and clean them up after execution.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join, sep, resolve } from 'node:path';
import type { ImageAttachment } from '../types.js';

/** Safe MIME → file extension mapping. Unknown types fall back to 'png'. */
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
};

/**
 * Write task-attached images to a temp directory on disk.
 *
 * Returns the list of written file paths (for cleanup or CLI flags).
 * Sanitizes filenames to prevent path traversal from network-sourced data.
 */
export async function writeImagesToDir(
  images: ImageAttachment[],
  imageDir: string,
): Promise<string[]> {
  await mkdir(imageDir, { recursive: true });
  const resolvedDir = resolve(imageDir);
  const paths: string[] = [];

  for (const img of images) {
    const ext = MIME_EXT[img.mimeType] ?? 'png';
    // Sanitize filename: strip path separators to prevent traversal
    const rawName = img.filename ?? `image-${img.blobId}.${ext}`;
    const safeName = rawName.replace(/[/\\]/g, '_');
    const filepath = resolve(join(imageDir, safeName));

    // Verify the resolved path is still inside imageDir
    if (!filepath.startsWith(resolvedDir + sep) && filepath !== resolvedDir) {
      console.warn(`[image-utils] Skipping image with unsafe filename: ${img.filename}`);
      continue;
    }

    await writeFile(filepath, Buffer.from(img.data, 'base64'));
    paths.push(filepath);
  }

  return paths;
}

/**
 * Remove temp image files. Errors are silently ignored (best-effort cleanup).
 */
export async function cleanupImages(paths: string[]): Promise<void> {
  await Promise.all(paths.map(p => rm(p, { force: true }).catch(() => {})));
}
