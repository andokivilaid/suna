import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { ApiError } from '../../http/api-client';
import { configureKortix } from '../../http/config';
import {
  deleteProjectKnowledgeFile,
  downloadProjectKnowledgeFile,
  listProjectKnowledge,
  updateProjectKnowledgeFile,
  uploadProjectKnowledge,
} from './knowledge';

const projectId = '11111111-1111-4111-8111-111111111111';
const base = `https://api.test/v1/projects/${projectId}/knowledge`;
const originalFetch = globalThis.fetch;

interface Seen {
  url: string;
  method: string;
  auth: string | null;
  body: RequestInit['body'];
}
let seen: Seen[] = [];

function stub(respond: (request: Seen) => Response) {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      url: String(url),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: init?.body,
    };
    seen.push(request);
    return respond(request);
  }) as typeof fetch;
}

const listBody = {
  ref: 'main',
  root: '.kortix/knowledge',
  index_path: '.kortix/knowledge/INDEX.md',
  index_exists: true,
  files: [
    {
      path: 'contracts/msa.pdf',
      repo_path: '.kortix/knowledge/contracts/msa.pdf',
      type: 'pdf',
      size: 16,
      description: 'Master services agreement',
    },
  ],
  total_bytes: 16,
  limits: {
    max_file_bytes: 26_214_400,
    max_upload_files: 10,
    max_upload_bytes: 52_428_800,
    max_total_bytes: 209_715_200,
  },
};

beforeEach(() => {
  seen = [];
  configureKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'test-token' });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('listProjectKnowledge GETs the project knowledge folder with the bearer token', async () => {
  stub(() => Response.json(listBody));
  const result = await listProjectKnowledge(projectId);
  expect(result.files[0]?.path).toBe('contracts/msa.pdf');
  expect(result.limits.max_file_bytes).toBe(26_214_400);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(base);
  expect(seen[0]!.method).toBe('GET');
  expect(seen[0]!.auth).toBe('Bearer test-token');
});

test('uploadProjectKnowledge POSTs every file plus folder, description, and replace as multipart', async () => {
  stub(() =>
    Response.json(
      { commit_sha: 'a'.repeat(40), branch: 'main', files: listBody.files },
      { status: 201 },
    ),
  );
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])], 'msa.pdf', {
    type: 'application/pdf',
  });
  const md = new File(['# Brief\n'], 'brief.md', { type: 'text/markdown' });
  const result = await uploadProjectKnowledge(projectId, [pdf, md], {
    folder: 'contracts',
    description: 'Master services agreement',
    replace: true,
  });
  expect(result.commit_sha).toBe('a'.repeat(40));
  expect(seen[0]!.url).toBe(base);
  expect(seen[0]!.method).toBe('POST');
  const body = seen[0]!.body as FormData;
  const files = body.getAll('file') as File[];
  expect(files.map((file) => file.name)).toEqual(['msa.pdf', 'brief.md']);
  expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]),
  );
  expect(body.get('folder')).toBe('contracts');
  expect(body.get('description')).toBe('Master services agreement');
  expect(body.get('replace')).toBe('true');
});

test('uploadProjectKnowledge accepts one File and omits unset fields', async () => {
  stub(() => Response.json({ commit_sha: 'b'.repeat(40), branch: 'main', files: [] }, { status: 201 }));
  await uploadProjectKnowledge(projectId, new File(['x'], 'a.txt'));
  const body = seen[0]!.body as FormData;
  expect((body.getAll('file') as File[]).map((file) => file.name)).toEqual(['a.txt']);
  expect(body.has('folder')).toBe(false);
  expect(body.has('description')).toBe(false);
  expect(body.has('replace')).toBe(false);
});

test('a refused upload rejects with ApiError carrying the status and server message', async () => {
  stub(() =>
    Response.json(
      { error: '"brief.md" already exists. Delete it or upload with replace.', code: 'knowledge_file_exists' },
      { status: 409 },
    ),
  );
  const error = await uploadProjectKnowledge(projectId, new File(['x'], 'brief.md')).catch(
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(409);
  expect((error as ApiError).message).toContain('already exists');
});

test('updateProjectKnowledgeFile PATCHes path, new_path, and description', async () => {
  stub(() => Response.json({ commit_sha: 'c'.repeat(40), branch: 'main', file: listBody.files[0] }));
  await updateProjectKnowledgeFile(projectId, {
    path: 'draft.pdf',
    newPath: 'contracts/msa.pdf',
    description: null,
  });
  expect(seen[0]!.method).toBe('PATCH');
  expect(seen[0]!.url).toBe(base);
  expect(JSON.parse(String(seen[0]!.body))).toEqual({
    path: 'draft.pdf',
    new_path: 'contracts/msa.pdf',
    description: null,
  });
});

test('deleteProjectKnowledgeFile DELETEs with the path in the query string', async () => {
  stub(() => Response.json({ commit_sha: 'd'.repeat(40), branch: 'main', path: 'a b/c.md' }));
  const result = await deleteProjectKnowledgeFile(projectId, 'a b/c.md');
  expect(result.path).toBe('a b/c.md');
  expect(seen[0]!.method).toBe('DELETE');
  expect(seen[0]!.url).toBe(`${base}?path=a+b%2Fc.md`);
});

test('downloadProjectKnowledgeFile returns the exact bytes as a Blob', async () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe]);
  stub(() => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  const blob = await downloadProjectKnowledgeFile(projectId, 'contracts/msa.pdf');
  expect(seen[0]!.url).toBe(`${base}/file?path=contracts%2Fmsa.pdf`);
  expect(seen[0]!.auth).toBe('Bearer test-token');
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  expect(blob.type).toBe('application/pdf');
});

test('downloadProjectKnowledgeFile rejects with ApiError on a missing file', async () => {
  stub(() => Response.json({ error: 'No document', code: 'knowledge_file_not_found' }, { status: 404 }));
  const error = await downloadProjectKnowledgeFile(projectId, 'gone.pdf').catch((caught) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(404);
});

test('kortix.project(id).knowledge binds the project id for every method', async () => {
  stub((request) =>
    request.method === 'GET' ? Response.json(listBody) : Response.json({ commit_sha: 'e'.repeat(40), branch: 'main', path: 'x.md' }),
  );
  const kortix = createKortix({ backendUrl: 'https://api.test/v1', getToken: async () => 'test-token' });
  const knowledge = kortix.project(projectId).knowledge;
  expect((await knowledge.list()).total_bytes).toBe(16);
  await knowledge.remove('x.md');
  expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual([
    `GET ${base}`,
    `DELETE ${base}?path=x.md`,
  ]);
  expect(typeof knowledge.upload).toBe('function');
  expect(typeof knowledge.update).toBe('function');
  expect(typeof knowledge.download).toBe('function');
});
