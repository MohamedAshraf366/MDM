import path from 'node:path';

/**
 * Absolute path of a Windows system tool. Bare names are resolved through the
 * search path (which can include the working directory), so a planted
 * executable could run instead; System32 is the trusted location.
 */
export function systemExecutable(name: string): string {
  if (process.platform !== 'win32') return name;
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', name);
}
