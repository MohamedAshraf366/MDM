import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DownloadError } from './errors';
import { sanitizeFileName } from '../shared/validation';

export class SparseFileWriter {
  private handle: fsp.FileHandle | null = null;
  private closed = false;

  constructor(readonly filePath: string) {}

  async open(totalBytes: number | null): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    let existed = false;
    try {
      await fsp.access(this.filePath);
      existed = true;
    } catch {
      existed = false;
    }
    this.handle = existed ? await fsp.open(this.filePath, 'r+') : await fsp.open(this.filePath, 'w+');
    if (totalBytes !== null && totalBytes > 0) {
      await this.handle.truncate(totalBytes);
    } else if (!existed) {
      await this.handle.truncate(0);
    }
  }

  async writeAt(offset: number, buffer: Buffer): Promise<void> {
    const handle = this.requireHandle();
    let written = 0;
    while (written < buffer.length) {
      const result = await handle.write(buffer, written, buffer.length - written, offset + written);
      if (result.bytesWritten <= 0) throw new DownloadError('The file write failed.', 'DISK_ERROR');
      written += result.bytesWritten;
    }
  }

  async truncate(size: number): Promise<void> {
    await this.requireHandle().truncate(size);
  }

  async flush(): Promise<void> {
    if (this.handle && !this.closed) await this.handle.sync();
  }

  async size(): Promise<number> {
    try {
      const stat = await fsp.stat(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  async close(options?: { skipSync?: boolean }): Promise<void> {
    if (!this.handle || this.closed) return;
    this.closed = true;
    const handle = this.handle;
    this.handle = null;
    if (!options?.skipSync) {
      try {
        await handle.sync();
      } catch {
        // A final sync failure is surfaced by size/checksum verification.
      }
    }
    await handle.close();
  }

  private requireHandle(): fsp.FileHandle {
    if (!this.handle || this.closed) throw new DownloadError('The download file is not open.', 'INTERNAL');
    return this.handle;
  }
}

export function resolveInside(baseDir: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  const base = path.resolve(baseDir);
  const target = path.resolve(base, safeName);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new DownloadError('Unsafe file path detected.', 'INTERNAL');
  }
  return target;
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function uniquePathSync(target: string, reservedPaths: Set<string> = new Set()): string {
  const directory = path.dirname(target);
  const parsed = path.parse(target);
  let candidate = target;
  let counter = 0;
  const normalized = (value: string) => value.toLowerCase();
  const reserved = new Set(Array.from(reservedPaths).map(normalized));
  while (fs.existsSync(candidate) || reserved.has(normalized(candidate))) {
    counter++;
    candidate = path.join(directory, `${parsed.name} (${counter})${parsed.ext}`);
  }
  return candidate;
}

export function reservedPathsExcept(
  reservedPaths: Set<string>,
  targetPath: string | null | undefined
): Set<string> {
  if (!targetPath) return reservedPaths;
  const normalized = path.resolve(targetPath).toLowerCase();
  const remaining = new Set<string>();
  for (const candidate of reservedPaths) {
    if (path.resolve(candidate).toLowerCase() !== normalized) remaining.add(candidate);
  }
  return remaining;
}

export async function resolveTargetPath(
  directory: string,
  fileName: string,
  policy: 'rename' | 'overwrite' | 'skip',
  reservedPaths: Set<string> = new Set()
): Promise<string> {
  const desired = resolveInside(directory, fileName);
  const exists = await fileExists(desired);
  const reserved = Array.from(reservedPaths).some((p) => p.toLowerCase() === desired.toLowerCase());
  if (policy === 'overwrite') return desired;
  if (policy === 'skip' && (exists || reserved)) {
    throw new DownloadError('A file with this name already exists.', 'FILE_EXISTS');
  }
  if (!exists && !reserved) return desired;
  return uniquePathSync(desired, reservedPaths);
}

export async function checkDiskSpace(
  targetDirectory: string,
  requiredBytes: number | null,
  probe: DiskSpaceProbe = defaultDiskSpaceProbe
): Promise<void> {
  if (requiredBytes === null || requiredBytes <= 0) return;
  const free = await probe(targetDirectory);
  if (free === null) return;
  const safetyMargin = 8 * 1024 * 1024;
  if (free < requiredBytes + safetyMargin) {
    throw new DownloadError(
      `Not enough free space. Required ${formatFree(requiredBytes + safetyMargin)}, available ${formatFree(free)}.`,
      'DISK_FULL'
    );
  }
}

export type DiskSpaceProbe = (directory: string) => Promise<number | null>;

export const defaultDiskSpaceProbe: DiskSpaceProbe = async (directory) => {
  let current = path.resolve(directory);
  for (;;) {
    try {
      const stats = await fsp.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
};

function formatFree(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function safeUnlink(target: string): Promise<void> {
  try {
    await fsp.unlink(target);
  } catch {
    // Ignore missing files.
  }
}

export async function atomicPlace(tempPath: string, targetPath: string, overwrite: boolean): Promise<string> {
  if (overwrite) {
    await safeUnlink(targetPath);
  }
  try {
    await fsp.rename(tempPath, targetPath);
    return targetPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EPERM' || code === 'EACCES') {
      const alternative = uniquePathSync(targetPath);
      await fsp.rename(tempPath, alternative);
      return alternative;
    }
    throw error;
  }
}

export function tempFilePath(directory: string, id: string): string {
  return path.join(directory, `~mdm-${id}.part`);
}
