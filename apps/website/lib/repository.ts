import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const GITHUB_REPOSITORY_URL = 'https://github.com/GautamBytes/cashu-fault-lab';

function packageName(directory: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

export function repositoryRoot(): string {
  const workingDirectory = process.cwd();
  return packageName(workingDirectory) === 'cashu-fault-lab'
    ? workingDirectory
    : resolve(workingDirectory, '../..');
}

export function resolveRepositoryPath(contentPath: string): string {
  const root = repositoryRoot();
  const resolvedPath = resolve(root, contentPath);
  const relativePath = relative(root, resolvedPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Repository content path escapes the project root');
  }

  return resolvedPath;
}

export function sourceUrl(contentPath: string, action: 'view' | 'edit'): string {
  resolveRepositoryPath(contentPath);
  const normalizedPath = contentPath.split(sep).join('/');
  const actionPath = action === 'view' ? 'blob/main' : 'edit/main';
  return `${GITHUB_REPOSITORY_URL}/${actionPath}/${encodeURI(normalizedPath)}`;
}
