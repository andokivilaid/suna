import type { ProjectKnowledgeFile, ProjectKnowledgeLimits } from '@kortix/sdk';

/** Binary units, one decimal above 1 KB — the same rendering INDEX.md uses. */
export function formatKnowledgeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function knowledgeFileName(path: string): string {
  return path.split('/').pop() ?? path;
}

export function knowledgeFolder(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function filterKnowledgeFiles(
  files: readonly ProjectKnowledgeFile[],
  query: string,
): readonly ProjectKnowledgeFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter(
    (file) =>
      file.path.toLowerCase().includes(needle) ||
      (file.description ?? '').toLowerCase().includes(needle),
  );
}

export type UploadSelectionProblem =
  | { kind: 'empty' }
  | { kind: 'too-many-files' }
  | { kind: 'file-too-large'; name: string }
  | { kind: 'upload-too-large' }
  | { kind: 'project-full' };

/**
 * The first reason the server would refuse this selection, or null. Mirrors
 * the server limits so the person learns before the bytes leave the browser;
 * the server still enforces every one of them.
 */
export function checkUploadSelection(
  files: ReadonlyArray<{ name: string; size: number }>,
  limits: ProjectKnowledgeLimits,
  usedBytes: number,
): UploadSelectionProblem | null {
  if (files.length === 0) return { kind: 'empty' };
  if (files.length > limits.max_upload_files) return { kind: 'too-many-files' };
  const oversized = files.find((file) => file.size > limits.max_file_bytes);
  if (oversized) return { kind: 'file-too-large', name: oversized.name };
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.max_upload_bytes) return { kind: 'upload-too-large' };
  if (usedBytes + total > limits.max_total_bytes) return { kind: 'project-full' };
  return null;
}
