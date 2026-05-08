// File system tools
import fs from 'fs/promises';
import path from 'path';

function securePath(inputPath: string, baseDir: string = process.cwd()): string {
  // Resolve to absolute path
  const resolved = path.resolve(baseDir, inputPath);
  // Check if within baseDir
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

export async function readFile(path: string) {
  const secure = securePath(path);
  return fs.readFile(secure, 'utf-8');
}

export async function writeFile(path: string, data: string) {
  const secure = securePath(path);
  return fs.writeFile(secure, data, 'utf-8');
}

export async function fileExists(path: string) {
  try {
    const secure = securePath(path);
    await fs.access(secure);
    return true;
  } catch {
    return false;
  }
}

export async function deleteFile(path: string) {
  const secure = securePath(path);
  await fs.unlink(secure);
}
