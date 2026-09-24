/**
 * Project knowledge — the git-backed half. Reads the `.kortix/knowledge/`
 * subtree of a branch, and writes documents plus a regenerated `INDEX.md` in
 * ONE commit through `commitMultipleFilesToBranch`, the same commit path the
 * dashboard's customize editors use.
 *
 * Every write is a compare-and-swap on the branch tip: the commit carries the
 * INDEX.md blob it was computed from as `expectedFileRevision`, which pushes
 * with `--force-with-lease` on the tip it read. A concurrent writer therefore
 * never loses an entry — the loser re-reads the tree and recomputes the index,
 * up to `WRITE_ATTEMPTS` times, then answers 409.
 */

import { validateRef } from '../git-ref';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from '../git/branches';
import { execFileAsync, refreshMirror, runGitCapture } from '../git/mirror';
import type { GitBackedProject } from '../git/types';
import {
  KNOWLEDGE_INDEX_PATH,
  KNOWLEDGE_ROOT,
  MAX_KNOWLEDGE_TOTAL_BYTES,
  assertKnowledgeRelativePath,
  knowledgeFileType,
  parseKnowledgeIndex,
  renderKnowledgeIndex,
} from './format';

const WRITE_ATTEMPTS = 3;

/** A refused knowledge operation, with the HTTP status and code it maps to. */
export class KnowledgeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

export interface KnowledgeFile {
  /** Relative to `.kortix/knowledge/`. */
  path: string;
  /** Repository-relative path. */
  repo_path: string;
  /** Lowercase extension, or `file`. */
  type: string;
  size: number;
  description: string | null;
}

export interface KnowledgeState {
  ref: string;
  root: string;
  index_path: string;
  index_exists: boolean;
  files: KnowledgeFile[];
  total_bytes: number;
}

interface TreeBlob {
  path: string;
  size: number;
  sha: string;
}

interface TreeSnapshot {
  repoPath: string;
  blobs: Map<string, TreeBlob>;
  indexSha: string | null;
  descriptions: Map<string, string | null>;
}

function toRepoPath(path: string): string {
  return `${KNOWLEDGE_ROOT}/${path}`;
}

/** Read the knowledge subtree of `branch` from the project mirror. */
async function snapshot(
  project: GitBackedProject,
  branch: string,
  fresh: boolean,
): Promise<TreeSnapshot> {
  const ref = validateRef(branch);
  const repoPath = fresh
    ? await refreshMirror(project, true, { freshRef: ref })
    : await refreshMirror(project);
  const blobs = new Map<string, TreeBlob>();
  let indexSha: string | null = null;

  // `-z` keeps paths verbatim (no C-quoting of spaces or non-ASCII names).
  // A missing branch (an empty repository) exits non-zero: no documents.
  const listed = await runGitCapture(
    ['ls-tree', '-r', '-l', '-z', `refs/heads/${ref}`, '--', `${KNOWLEDGE_ROOT}/`],
    repoPath,
  );
  if (listed.exitCode === 0) {
    for (const record of listed.stdout.split('\0')) {
      const match = /^\d+ blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/s.exec(record);
      if (!match) continue;
      const [, sha, size, repoRelative] = match;
      if (!repoRelative!.startsWith(`${KNOWLEDGE_ROOT}/`)) continue;
      if (repoRelative === KNOWLEDGE_INDEX_PATH) {
        indexSha = sha!;
        continue;
      }
      const path = repoRelative!.slice(KNOWLEDGE_ROOT.length + 1);
      blobs.set(path, { path, size: Number(size), sha: sha! });
    }
  }

  let descriptions = new Map<string, string | null>();
  if (indexSha) {
    const index = await readBlob(repoPath, indexSha, 1024 * 1024);
    descriptions = parseKnowledgeIndex(Buffer.from(index).toString('utf8'));
  }
  return { repoPath, blobs, indexSha, descriptions };
}

async function readBlob(repoPath: string, sha: string, size: number): Promise<Uint8Array> {
  const result = await execFileAsync('git', ['cat-file', 'blob', sha], {
    cwd: repoPath,
    encoding: 'buffer',
    maxBuffer: size + 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return new Uint8Array(result.stdout as Buffer);
}

function toState(ref: string, snap: TreeSnapshot): KnowledgeState {
  const files = [...snap.blobs.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map<KnowledgeFile>((blob) => ({
      path: blob.path,
      repo_path: toRepoPath(blob.path),
      type: knowledgeFileType(blob.path),
      size: blob.size,
      description: snap.descriptions.get(blob.path) ?? null,
    }));
  return {
    ref,
    root: KNOWLEDGE_ROOT,
    index_path: KNOWLEDGE_INDEX_PATH,
    index_exists: snap.indexSha !== null,
    files,
    total_bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export async function readKnowledge(
  project: GitBackedProject,
  branch: string,
  opts: { fresh?: boolean } = {},
): Promise<KnowledgeState> {
  return toState(branch, await snapshot(project, branch, opts.fresh ?? false));
}

export async function readKnowledgeFileBytes(
  project: GitBackedProject,
  branch: string,
  path: string,
): Promise<{ file: KnowledgeFile; bytes: Uint8Array; sha: string }> {
  assertKnowledgeRelativePath(path);
  const snap = await snapshot(project, branch, false);
  const blob = snap.blobs.get(path);
  if (!blob) throw new KnowledgeError(404, 'knowledge_file_not_found', `No document at "${path}"`);
  const bytes = await readBlob(snap.repoPath, blob.sha, blob.size);
  const file = toState(branch, snap).files.find((entry) => entry.path === path)!;
  return { file, bytes, sha: blob.sha };
}

interface CommitPlan {
  files: Array<{ path: string; content: string | Uint8Array }>;
  deletes: string[];
  message: string;
  /** Sizes of the documents after the commit, keyed by knowledge path. */
  sizes: Map<string, number>;
  descriptions: Map<string, string | null>;
}

/**
 * Plan against a fresh snapshot, commit the plan plus the regenerated index,
 * and retry from a new snapshot when another writer moved the branch.
 */
async function commitWithIndex(
  project: GitBackedProject,
  branch: string,
  plan: (snap: TreeSnapshot) => Promise<CommitPlan>,
): Promise<{ commitSha: string; state: KnowledgeState }> {
  for (let attempt = 1; ; attempt++) {
    const snap = await snapshot(project, branch, true);
    const next = await plan(snap);
    const entries = [...next.sizes.entries()].map(([path, size]) => ({ path, size }));
    const index = renderKnowledgeIndex(entries, next.descriptions);
    try {
      const { commitSha } = await commitMultipleFilesToBranch(project, {
        files: [
          ...next.files.map((file) => ({ path: toRepoPath(file.path), content: file.content })),
          { path: KNOWLEDGE_INDEX_PATH, content: index },
        ],
        deletes: next.deletes.map(toRepoPath),
        message: next.message,
        branch,
        expectedFileRevision: { path: KNOWLEDGE_INDEX_PATH, sha: snap.indexSha },
      });
      const files = [...next.sizes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map<KnowledgeFile>(([path, size]) => ({
          path,
          repo_path: toRepoPath(path),
          type: knowledgeFileType(path),
          size,
          description: next.descriptions.get(path) ?? null,
        }));
      return {
        commitSha,
        state: {
          ref: branch,
          root: KNOWLEDGE_ROOT,
          index_path: KNOWLEDGE_INDEX_PATH,
          index_exists: true,
          files,
          total_bytes: files.reduce((sum, file) => sum + file.size, 0),
        },
      };
    } catch (error) {
      if (error instanceof GitFileRevisionConflictError && attempt < WRITE_ATTEMPTS) continue;
      if (error instanceof GitFileRevisionConflictError) {
        throw new KnowledgeError(
          409,
          'knowledge_write_conflict',
          'The knowledge folder changed during this write. Retry.',
        );
      }
      throw error;
    }
  }
}

function currentSizes(snap: TreeSnapshot): Map<string, number> {
  return new Map([...snap.blobs.values()].map((blob) => [blob.path, blob.size]));
}

function assertBudget(sizes: Map<string, number>, maxTotalBytes: number): void {
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (total > maxTotalBytes) {
    throw new KnowledgeError(
      413,
      'knowledge_total_too_large',
      `Knowledge would hold ${Math.ceil(total / (1024 * 1024))} MB, over the ${Math.floor(
        maxTotalBytes / (1024 * 1024),
      )} MB project limit. Remove documents first.`,
    );
  }
}

function pickEntries(state: KnowledgeState, paths: readonly string[]): KnowledgeFile[] {
  return paths
    .map((path) => state.files.find((file) => file.path === path))
    .filter((file): file is KnowledgeFile => Boolean(file));
}

export async function uploadKnowledgeFiles(
  project: GitBackedProject,
  input: {
    branch: string;
    files: Array<{ path: string; bytes: Uint8Array }>;
    /** Applies to every uploaded file. `undefined` keeps a replaced file's
     *  existing description. */
    description?: string | null;
    replace?: boolean;
  },
  limits: { maxTotalBytes?: number } = {},
): Promise<{ commit_sha: string; branch: string; files: KnowledgeFile[] }> {
  if (input.files.length === 0) {
    throw new KnowledgeError(400, 'knowledge_no_files', 'Attach at least one file');
  }
  const seen = new Set<string>();
  for (const file of input.files) {
    assertKnowledgeRelativePath(file.path);
    if (seen.has(file.path)) {
      throw new KnowledgeError(400, 'knowledge_duplicate_path', `"${file.path}" is listed twice`);
    }
    seen.add(file.path);
  }
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_KNOWLEDGE_TOTAL_BYTES;
  const { commitSha, state } = await commitWithIndex(project, input.branch, async (snap) => {
    const existing = input.files.filter((file) => snap.blobs.has(file.path));
    if (existing.length > 0 && !input.replace) {
      throw new KnowledgeError(
        409,
        'knowledge_file_exists',
        `"${existing[0]!.path}" already exists. Delete it or upload with replace.`,
      );
    }
    const sizes = currentSizes(snap);
    const descriptions = new Map(snap.descriptions);
    for (const file of input.files) {
      sizes.set(file.path, file.bytes.byteLength);
      if (input.description !== undefined) descriptions.set(file.path, input.description);
      else if (!snap.blobs.has(file.path)) descriptions.set(file.path, null);
    }
    assertBudget(sizes, maxTotalBytes);
    const names = input.files.map((file) => file.path);
    return {
      files: input.files.map((file) => ({ path: file.path, content: file.bytes })),
      deletes: [],
      message:
        names.length === 1
          ? `knowledge: ${existing.length ? 'replace' : 'add'} ${names[0]}`
          : `knowledge: add ${names.length} documents`,
      sizes,
      descriptions,
    };
  });
  return {
    commit_sha: commitSha,
    branch: input.branch,
    files: pickEntries(state, input.files.map((file) => file.path)),
  };
}

export async function deleteKnowledgeFile(
  project: GitBackedProject,
  input: { branch: string; path: string },
): Promise<{ commit_sha: string; branch: string; path: string }> {
  assertKnowledgeRelativePath(input.path);
  const { commitSha } = await commitWithIndex(project, input.branch, async (snap) => {
    if (!snap.blobs.has(input.path)) {
      throw new KnowledgeError(404, 'knowledge_file_not_found', `No document at "${input.path}"`);
    }
    const sizes = currentSizes(snap);
    sizes.delete(input.path);
    const descriptions = new Map(snap.descriptions);
    descriptions.delete(input.path);
    return {
      files: [],
      deletes: [input.path],
      message: `knowledge: remove ${input.path}`,
      sizes,
      descriptions,
    };
  });
  return { commit_sha: commitSha, branch: input.branch, path: input.path };
}

/** Move a document, change its description, or both — in one commit. */
export async function updateKnowledgeFile(
  project: GitBackedProject,
  input: {
    branch: string;
    path: string;
    newPath?: string;
    /** `undefined` keeps the description; `null` clears it. */
    description?: string | null;
  },
): Promise<{ commit_sha: string; branch: string; file: KnowledgeFile }> {
  assertKnowledgeRelativePath(input.path);
  const target = input.newPath ?? input.path;
  assertKnowledgeRelativePath(target);
  if (target === input.path && input.description === undefined) {
    throw new KnowledgeError(400, 'knowledge_no_change', 'Nothing to change');
  }
  const { commitSha, state } = await commitWithIndex(project, input.branch, async (snap) => {
    const source = snap.blobs.get(input.path);
    if (!source) {
      throw new KnowledgeError(404, 'knowledge_file_not_found', `No document at "${input.path}"`);
    }
    const moving = target !== input.path;
    if (moving && snap.blobs.has(target)) {
      throw new KnowledgeError(409, 'knowledge_file_exists', `"${target}" already exists`);
    }
    const sizes = currentSizes(snap);
    const descriptions = new Map(snap.descriptions);
    const description =
      input.description === undefined ? (snap.descriptions.get(input.path) ?? null) : input.description;
    const files: CommitPlan['files'] = [];
    const deletes: string[] = [];
    if (moving) {
      files.push({ path: target, content: await readBlob(snap.repoPath, source.sha, source.size) });
      deletes.push(input.path);
      sizes.delete(input.path);
      descriptions.delete(input.path);
      sizes.set(target, source.size);
    }
    descriptions.set(target, description);
    return {
      files,
      deletes,
      message: moving
        ? `knowledge: move ${input.path} to ${target}`
        : `knowledge: describe ${input.path}`,
      sizes,
      descriptions,
    };
  });
  return {
    commit_sha: commitSha,
    branch: input.branch,
    file: pickEntries(state, [target])[0]!,
  };
}

