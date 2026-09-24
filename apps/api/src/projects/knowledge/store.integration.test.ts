import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitBackedProject } from '../git/types';
import { KNOWLEDGE_INDEX_PATH, MAX_KNOWLEDGE_TOTAL_BYTES } from './format';
import {
  KnowledgeError,
  deleteKnowledgeFile,
  readKnowledge,
  readKnowledgeFileBytes,
  updateKnowledgeFile,
  uploadKnowledgeFiles,
} from './store';

const exec = promisify(execFile);

let testRoot = '';
let remotePath = '';
let project: GitBackedProject;

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await exec('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

/** Bytes as the remote stores them — independent of the code under test. */
async function remoteBytes(path: string): Promise<Buffer> {
  const result = await exec('git', ['cat-file', 'blob', `main:${path}`], {
    cwd: remotePath,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

// A PDF-shaped binary with bytes that are invalid UTF-8 and a NUL — the exact
// content a string-typed commit path corrupts.
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x9f,
]);

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'kortix-knowledge-'));
  remotePath = join(testRoot, 'remote.git');
  const seedPath = join(testRoot, 'seed');
  await git(['init', '--bare', remotePath]);
  await git(['init', '--initial-branch=main', seedPath]);
  await git(['config', 'user.name', 'Kortix Test'], seedPath);
  await git(['config', 'user.email', 'test@kortix.invalid'], seedPath);
  await writeFile(join(seedPath, 'README.md'), '# seed\n');
  await git(['add', 'README.md'], seedPath);
  await git(['commit', '-m', 'seed'], seedPath);
  await git(['remote', 'add', 'origin', remotePath], seedPath);
  await git(['push', 'origin', 'main'], seedPath);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remotePath);
  project = {
    projectId: `knowledge-${crypto.randomUUID()}`,
    repoUrl: remotePath,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe('project knowledge store', () => {
  test('an empty project lists no documents', async () => {
    const state = await readKnowledge(project, 'main');
    expect(state.files).toEqual([]);
    expect(state.total_bytes).toBe(0);
    expect(state.index_exists).toBe(false);
  });

  test('uploads binary and text in one commit, byte-exact, with the index updated', async () => {
    const result = await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [
        { path: 'contracts/msa.pdf', bytes: PDF_BYTES },
        { path: 'brief.md', bytes: new TextEncoder().encode('# Brief\n') },
      ],
      description: 'Uploaded from the web',
    });
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.files.map((f) => f.path)).toEqual(['contracts/msa.pdf', 'brief.md']);

    // One commit on the remote carries both documents and the index.
    const changed = (await git(['show', '--name-only', '--format=', 'main'], remotePath)).split('\n');
    expect(changed.sort()).toEqual(
      [KNOWLEDGE_INDEX_PATH, '.kortix/knowledge/brief.md', '.kortix/knowledge/contracts/msa.pdf'].sort(),
    );
    expect(Buffer.compare(await remoteBytes('.kortix/knowledge/contracts/msa.pdf'), Buffer.from(PDF_BYTES))).toBe(0);

    const index = (await remoteBytes(KNOWLEDGE_INDEX_PATH)).toString('utf8');
    expect(index).toContain(
      '- [contracts/msa.pdf](<contracts/msa.pdf>) — pdf · 16 B — Uploaded from the web',
    );
    expect(index).toContain('- [brief.md](<brief.md>) — md · 8 B — Uploaded from the web');

    const state = await readKnowledge(project, 'main');
    expect(state.files).toEqual([
      { path: 'brief.md', repo_path: '.kortix/knowledge/brief.md', type: 'md', size: 8, description: 'Uploaded from the web' },
      {
        path: 'contracts/msa.pdf',
        repo_path: '.kortix/knowledge/contracts/msa.pdf',
        type: 'pdf',
        size: 16,
        description: 'Uploaded from the web',
      },
    ]);
    expect(state.total_bytes).toBe(24);
    expect(state.index_exists).toBe(true);

    const read = await readKnowledgeFileBytes(project, 'main', 'contracts/msa.pdf');
    expect(Buffer.compare(Buffer.from(read.bytes), Buffer.from(PDF_BYTES))).toBe(0);
  });

  test('refuses to overwrite an existing document unless replace is set', async () => {
    await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'a.txt', bytes: new TextEncoder().encode('one') }],
      description: 'first',
    });
    const refused = await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'a.txt', bytes: new TextEncoder().encode('two') }],
    }).catch((error) => error);
    expect(refused).toBeInstanceOf(KnowledgeError);
    expect((refused as KnowledgeError).status).toBe(409);
    expect((refused as KnowledgeError).code).toBe('knowledge_file_exists');

    await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'a.txt', bytes: new TextEncoder().encode('two') }],
      replace: true,
    });
    expect((await remoteBytes('.kortix/knowledge/a.txt')).toString()).toBe('two');
    // Replacing without a new description keeps the old one.
    const state = await readKnowledge(project, 'main');
    expect(state.files[0]?.description).toBe('first');
  });

  test('refuses an upload that would exceed the folder budget', async () => {
    const refused = await uploadKnowledgeFiles(
      project,
      { branch: 'main', files: [{ path: 'big.bin', bytes: new Uint8Array(64) }] },
      { maxTotalBytes: 32 },
    ).catch((error) => error);
    expect((refused as KnowledgeError).status).toBe(413);
    expect((refused as KnowledgeError).code).toBe('knowledge_total_too_large');
    expect(MAX_KNOWLEDGE_TOTAL_BYTES).toBeGreaterThan(32);
  });

  test('moves a document and edits its description, carrying the bytes', async () => {
    await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'draft.pdf', bytes: PDF_BYTES }],
      description: 'Draft',
    });
    const moved = await updateKnowledgeFile(project, {
      branch: 'main',
      path: 'draft.pdf',
      newPath: 'final/contract.pdf',
      description: 'Signed contract',
    });
    expect(moved.file.path).toBe('final/contract.pdf');
    expect(Buffer.compare(await remoteBytes('.kortix/knowledge/final/contract.pdf'), Buffer.from(PDF_BYTES))).toBe(0);
    const state = await readKnowledge(project, 'main');
    expect(state.files.map((f) => [f.path, f.description])).toEqual([
      ['final/contract.pdf', 'Signed contract'],
    ]);

    const clash = await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'other.pdf', bytes: PDF_BYTES }],
    }).then(() =>
      updateKnowledgeFile(project, { branch: 'main', path: 'other.pdf', newPath: 'final/contract.pdf' }),
    ).catch((error) => error);
    expect((clash as KnowledgeError).status).toBe(409);
  });

  test('deletes a document and its index line in one commit', async () => {
    await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [
        { path: 'keep.md', bytes: new TextEncoder().encode('keep') },
        { path: 'drop.md', bytes: new TextEncoder().encode('drop') },
      ],
    });
    await deleteKnowledgeFile(project, { branch: 'main', path: 'drop.md' });
    const tree = await git(['ls-tree', '-r', '--name-only', 'main'], remotePath);
    expect(tree).not.toContain('.kortix/knowledge/drop.md');
    expect(tree).toContain('.kortix/knowledge/keep.md');
    const index = (await remoteBytes(KNOWLEDGE_INDEX_PATH)).toString('utf8');
    expect(index).not.toContain('drop.md');
    expect(index).toContain('keep.md');

    const missing = await deleteKnowledgeFile(project, { branch: 'main', path: 'drop.md' }).catch(
      (error) => error,
    );
    expect((missing as KnowledgeError).status).toBe(404);
  });

  test('files an agent added without an index line still list, and the next write indexes them', async () => {
    const seedPath = join(testRoot, 'agent');
    await git(['clone', remotePath, seedPath]);
    await git(['config', 'user.name', 'Agent'], seedPath);
    await git(['config', 'user.email', 'agent@kortix.invalid'], seedPath);
    await exec('mkdir', ['-p', join(seedPath, '.kortix/knowledge')]);
    await writeFile(join(seedPath, '.kortix/knowledge/agent-notes.md'), 'notes');
    await git(['add', '.'], seedPath);
    await git(['commit', '-m', 'agent adds a note'], seedPath);
    await git(['push', 'origin', 'main'], seedPath);

    const before = await readKnowledge(project, 'main', { fresh: true });
    expect(before.files.map((f) => [f.path, f.description])).toEqual([['agent-notes.md', null]]);

    await uploadKnowledgeFiles(project, {
      branch: 'main',
      files: [{ path: 'web.md', bytes: new TextEncoder().encode('web') }],
    });
    const index = (await remoteBytes(KNOWLEDGE_INDEX_PATH)).toString('utf8');
    expect(index).toContain('[agent-notes.md]');
    expect(index).toContain('[web.md]');
  });
});
