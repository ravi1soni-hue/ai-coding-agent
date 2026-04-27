// File system tools
import fs from 'fs/promises';

export async function readFile(path: string) {
  return fs.readFile(path, 'utf-8');
}

export async function writeFile(path: string, data: string) {
  return fs.writeFile(path, data, 'utf-8');
}

export async function fileExists(path: string) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function deleteFile(path: string) {
  await fs.unlink(path);
}
