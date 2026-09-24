// Project knowledge — documents in a project's `.kortix/knowledge/` folder.
//
// The project repository is the store: every session clones it, so a document
// uploaded here is on disk in the next session. Each write is one commit on the
// default branch that also regenerates `.kortix/knowledge/INDEX.md` (one line
// per file: path, type, size, description).

import { ApiError, backendApi } from '../../http/api-client';
import { authenticatedFetch } from '../../http/auth';
import { platformConfig } from '../../http/config';
import { unwrap } from './shared';

/** One knowledge file; `path` is relative to `.kortix/knowledge/`. */
export interface ProjectKnowledgeFile {
  path: string;
  /** Repository-relative path, e.g. `.kortix/knowledge/contracts/msa.pdf`. */
  repo_path: string;
  /** Lowercase extension, or `file`. */
  type: string;
  /** Exact size in bytes. */
  size: number;
  description: string | null;
}

/** Server-enforced upload limits, in bytes and files. */
export interface ProjectKnowledgeLimits {
  max_file_bytes: number;
  max_upload_files: number;
  max_upload_bytes: number;
  max_total_bytes: number;
}

export interface ProjectKnowledge {
  /** The branch read — the project default branch. */
  ref: string;
  /** `.kortix/knowledge` */
  root: string;
  /** `.kortix/knowledge/INDEX.md` */
  index_path: string;
  index_exists: boolean;
  files: ProjectKnowledgeFile[];
  total_bytes: number;
  limits: ProjectKnowledgeLimits;
}

export interface ProjectKnowledgeUploadOptions {
  /** Subfolder under `.kortix/knowledge/`, e.g. `contracts/2026`. */
  folder?: string;
  /** One line, applied to every uploaded file. */
  description?: string;
  /** Overwrite a document at the same path. Without it, an existing path is a 409. */
  replace?: boolean;
  signal?: AbortSignal;
}

export interface ProjectKnowledgeCommit {
  commit_sha: string;
  branch: string;
}

export interface ProjectKnowledgeUploadResult extends ProjectKnowledgeCommit {
  files: ProjectKnowledgeFile[];
}

export interface ProjectKnowledgeUpdate {
  /** The document to change, relative to `.kortix/knowledge/`. */
  path: string;
  /** Move it here. */
  newPath?: string;
  /** New description; `null` clears it; omit to keep it. */
  description?: string | null;
}

export interface ProjectKnowledgeUpdateResult extends ProjectKnowledgeCommit {
  file: ProjectKnowledgeFile;
}

export interface ProjectKnowledgeDeleteResult extends ProjectKnowledgeCommit {
  path: string;
}

const knowledgePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/knowledge`;

/** List the documents on the default branch, with the server's upload limits. */
export async function listProjectKnowledge(projectId: string): Promise<ProjectKnowledge> {
  return unwrap(
    await backendApi.get<ProjectKnowledge>(knowledgePath(projectId), {
      // project.file.read is manager-tier; the knowledge page renders its own
      // error state for a member, so the global toast would only duplicate it.
      showErrors: false,
    }),
  );
}

/**
 * Upload one or more documents in one commit. Rejects with `ApiError`:
 * 409 when a path exists (pass `replace`), 413 over a size limit, 400 for an
 * invalid path.
 */
export async function uploadProjectKnowledge(
  projectId: string,
  files: File | readonly File[],
  options: ProjectKnowledgeUploadOptions = {},
): Promise<ProjectKnowledgeUploadResult> {
  const form = new FormData();
  for (const file of Array.isArray(files) ? files : [files as File]) {
    form.append('file', file, file.name);
  }
  if (options.folder) form.append('folder', options.folder);
  if (options.description) form.append('description', options.description);
  if (options.replace) form.append('replace', 'true');
  return unwrap(
    await backendApi.upload<ProjectKnowledgeUploadResult>(knowledgePath(projectId), form, {
      signal: options.signal,
      timeout: 120_000,
      showErrors: false,
    }),
  );
}

/** Move a document, change its description, or both — one commit. */
export async function updateProjectKnowledgeFile(
  projectId: string,
  update: ProjectKnowledgeUpdate,
): Promise<ProjectKnowledgeUpdateResult> {
  const body: Record<string, unknown> = { path: update.path };
  if (update.newPath !== undefined) body.new_path = update.newPath;
  if (update.description !== undefined) body.description = update.description;
  return unwrap(
    await backendApi.patch<ProjectKnowledgeUpdateResult>(knowledgePath(projectId), body, {
      showErrors: false,
    }),
  );
}

/** Delete one document and its index line — one commit. */
export async function deleteProjectKnowledgeFile(
  projectId: string,
  path: string,
): Promise<ProjectKnowledgeDeleteResult> {
  const query = new URLSearchParams({ path });
  return unwrap(
    await backendApi.delete<ProjectKnowledgeDeleteResult>(
      `${knowledgePath(projectId)}?${query.toString()}`,
      { showErrors: false },
    ),
  );
}

/** The exact bytes of one knowledge file, as a Blob. */
export async function downloadProjectKnowledgeFile(
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const query = new URLSearchParams({ path });
  const base = platformConfig().backendUrl.replace(/\/$/, '');
  const response = await authenticatedFetch(`${base}${knowledgePath(projectId)}/file?${query.toString()}`, {
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string' ? body.error : 'Could not download the document',
      { status: response.status },
    );
  }
  return response.blob();
}
