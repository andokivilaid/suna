/**
 * Project knowledge — documents uploaded into `.kortix/knowledge/` from outside
 * a session. Maps to spec §10b (KNOW-1, KNOW-2). Each flow provisions its own
 * seeded project because every step writes to the repository.
 *
 * Read-back uses the existing repository file routes (`/files`,
 * `/files/content`) so the proof is what a session would clone, not what the
 * knowledge route reports about itself. Binary bytes are proven through the
 * download ETag, which is the git blob id: this flow computes
 * `sha1("blob <n>\0" + bytes)` locally and compares.
 */
import { createHash } from 'node:crypto';
import { flow } from '../core/flow';

const LIST = '/v1/projects/:projectId/knowledge';
const DOWNLOAD = '/v1/projects/:projectId/knowledge/file';
const FILES = '/v1/projects/:projectId/files';
const CONTENT = '/v1/projects/:projectId/files/content';
const INDEX = '.kortix/knowledge/INDEX.md';

// PDF-shaped bytes that are invalid UTF-8 and contain a NUL: a text-only
// commit path would corrupt them.
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x9f,
]);
const BRIEF = '# Brief\n\nKNOW-1 project brief.\n';

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function form(files: Array<[Uint8Array | string, string, string]>, fields: Record<string, string> = {}) {
  const body = new FormData();
  for (const [bytes, name, type] of files) body.append('file', new File([bytes], name, { type }));
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
}

flow(
  'KNOW-1',
  {
    domain: 'knowledge',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'GET /v1/projects/:projectId/knowledge',
      'POST /v1/projects/:projectId/knowledge',
      'PATCH /v1/projects/:projectId/knowledge',
      'DELETE /v1/projects/:projectId/knowledge',
      'GET /v1/projects/:projectId/knowledge/file',
      'GET /v1/projects/:projectId/files',
      'GET /v1/projects/:projectId/files/content',
    ],
  },
  async (ctx) => {
    const project = await ctx.fixtures.project({ seed: true });
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: project.id };

    await ctx.step('owner lists knowledge on a new project -> 200, no documents, published limits', async () => {
      const r = await owner.get(LIST, { params });
      r.status(200)
        .body()
        .has('$.root', '.kortix/knowledge')
        .has('$.index_path', INDEX)
        .has('$.files.length', 0)
        .has('$.total_bytes', 0)
        .has('$.limits.max_file_bytes', 25 * 1024 * 1024);
    });

    await ctx.step('owner uploads a markdown brief with a description -> 201 with one commit', async () => {
      const r = await owner.post(LIST, form([[BRIEF, 'brief.md', 'text/markdown']], { description: 'Project brief' }), { params });
      r.status(201).body().has('$.files[0].path', 'brief.md').has('$.files[0].description', 'Project brief');
      if (!/^[0-9a-f]{40}$/.test(r.json<any>().commit_sha)) throw new Error('commit_sha is not a git SHA');
    });

    await ctx.step('owner uploads a binary PDF into a folder -> 201 at contracts/msa.pdf', async () => {
      const r = await owner.post(
        LIST,
        form([[PDF, 'msa.pdf', 'application/pdf']], { folder: 'contracts', description: 'Master services agreement' }),
        { params },
      );
      r.status(201).body().has('$.files[0].path', 'contracts/msa.pdf').has('$.files[0].size', PDF.byteLength);
    });

    await ctx.step('owner lists knowledge -> both documents with type, exact size, and description', async () => {
      const r = await owner.get(LIST, { params });
      r.status(200)
        .body()
        .has('$.index_exists', true)
        .has('$.files.length', 2)
        .has('$.files[0].path', 'brief.md')
        .has('$.files[0].type', 'md')
        .has('$.files[0].size', new TextEncoder().encode(BRIEF).byteLength)
        .has('$.files[1].path', 'contracts/msa.pdf')
        .has('$.files[1].type', 'pdf')
        .has('$.files[1].description', 'Master services agreement');
    });

    await ctx.step('the repository file routes show both documents and INDEX.md under .kortix/knowledge', async () => {
      const r = await owner.get(FILES, { params, query: { path: '.kortix/knowledge' } });
      r.status(200);
      const paths = r.json<Array<{ path: string }>>().map((entry) => entry.path).sort();
      const expected = ['.kortix/knowledge/INDEX.md', '.kortix/knowledge/brief.md', '.kortix/knowledge/contracts/msa.pdf'];
      if (JSON.stringify(paths) !== JSON.stringify(expected)) {
        throw new Error(`repository tree is ${JSON.stringify(paths)}`);
      }
      (await owner.get(CONTENT, { params, query: { path: '.kortix/knowledge/brief.md' } }))
        .status(200)
        .body()
        .has('$.content', BRIEF);
    });

    await ctx.step('INDEX.md holds one line per document with type, size, and description', async () => {
      const r = await owner.get(CONTENT, { params, query: { path: INDEX } });
      r.status(200);
      const index = r.json<{ content: string }>().content;
      for (const line of [
        `- [brief.md](<brief.md>) — md · ${new TextEncoder().encode(BRIEF).byteLength} B — Project brief`,
        '- [contracts/msa.pdf](<contracts/msa.pdf>) — pdf · 16 B — Master services agreement',
      ]) {
        if (!index.includes(line)) throw new Error(`INDEX.md is missing "${line}"`);
      }
    });

    await ctx.step('owner downloads the PDF -> 200, application/pdf, ETag equals the git blob id of the uploaded bytes', async () => {
      const r = await owner.get(DOWNLOAD, { params, query: { path: 'contracts/msa.pdf' } });
      r.status(200);
      if (r.header('content-type') !== 'application/pdf') throw new Error(`content-type ${r.header('content-type')}`);
      if (r.header('content-length') !== String(PDF.byteLength)) throw new Error(`content-length ${r.header('content-length')}`);
      if (r.header('etag') !== `"${gitBlobSha(PDF)}"`) throw new Error(`etag ${r.header('etag')} does not match the uploaded bytes`);
    });

    await ctx.step('re-uploading brief.md is refused with 409; with replace=true it lands and keeps the description', async () => {
      const again = await owner.post(LIST, form([['# Brief v2\n', 'brief.md', 'text/markdown']]), { params });
      again.status(409).body().has('$.code', 'knowledge_file_exists');
      const replaced = await owner.post(LIST, form([['# Brief v2\n', 'brief.md', 'text/markdown']], { replace: 'true' }), { params });
      replaced.status(201).body().has('$.files[0].description', 'Project brief').has('$.files[0].size', 11);
    });

    await ctx.step('owner moves the PDF and edits its description -> 200; the old path is gone', async () => {
      const r = await owner.patch(LIST, { path: 'contracts/msa.pdf', new_path: 'archive/msa-2026.pdf', description: 'Signed MSA' }, { params });
      r.status(200).body().has('$.file.path', 'archive/msa-2026.pdf').has('$.file.description', 'Signed MSA');
      (await owner.get(DOWNLOAD, { params, query: { path: 'contracts/msa.pdf' } })).status(404);
      const moved = await owner.get(DOWNLOAD, { params, query: { path: 'archive/msa-2026.pdf' } });
      moved.status(200);
      if (moved.header('etag') !== `"${gitBlobSha(PDF)}"`) throw new Error('moved bytes differ from the upload');
    });

    await ctx.step('owner deletes brief.md -> 200; the file and its index line are gone', async () => {
      (await owner.del(LIST, { params, query: { path: 'brief.md' } })).status(200).body().has('$.path', 'brief.md');
      (await owner.get(CONTENT, { params, query: { path: '.kortix/knowledge/brief.md' } })).status(404);
      const index = (await owner.get(CONTENT, { params, query: { path: INDEX } })).json<{ content: string }>().content;
      if (index.includes('brief.md')) throw new Error('INDEX.md still lists brief.md');
      (await owner.get(LIST, { params })).status(200).body().has('$.files.length', 1).has('$.files[0].path', 'archive/msa-2026.pdf');
    });

    await ctx.step('deleting brief.md again -> 404 knowledge_file_not_found', async () => {
      (await owner.del(LIST, { params, query: { path: 'brief.md' } }))
        .status(404)
        .body()
        .has('$.code', 'knowledge_file_not_found');
    });
  },
);

flow(
  'KNOW-2',
  {
    domain: 'knowledge',
    requires: ['database'],
    timeoutMs: 180_000,
    routes: [
      'GET /v1/projects/:projectId/knowledge',
      'POST /v1/projects/:projectId/knowledge',
      'PATCH /v1/projects/:projectId/knowledge',
      'DELETE /v1/projects/:projectId/knowledge',
      'GET /v1/projects/:projectId/knowledge/file',
    ],
  },
  async (ctx) => {
    const team = await ctx.fixtures.team();
    const project = await team.project({ seed: true });
    const params = { projectId: project.id };
    const owner = ctx.client.as(ctx.P.OWNER);
    const member = await team.addMember('member');
    await team.grantProjectRole(project.id, member.userId!, 'member');

    await ctx.step('path traversal and hidden paths are refused with 400 knowledge_invalid_path', async () => {
      const attempts = [
        await owner.post(LIST, form([['x', 'evil.md', 'text/markdown']], { folder: '../..' }), { params }),
        await owner.post(LIST, form([['x', 'evil.md', 'text/markdown']], { folder: 'a/../../b' }), { params }),
        await owner.post(LIST, form([['x', '.env', 'text/plain']]), { params }),
        await owner.post(LIST, form([['x', 'INDEX.md', 'text/markdown']]), { params }),
        await owner.del(LIST, { params, query: { path: '../../kortix.yaml' } }),
        await owner.patch(LIST, { path: 'a.md', new_path: '../../escape.md' }, { params }),
        await owner.get(DOWNLOAD, { params, query: { path: '../../README.md' } }),
      ];
      for (const r of attempts) r.status(400).body().has('$.code', 'knowledge_invalid_path');
    });

    await ctx.step('a file over 25 MiB is refused with 413; more than 10 files is refused with 400', async () => {
      const big = new Uint8Array(25 * 1024 * 1024 + 1);
      (await owner.post(LIST, form([[big, 'big.bin', 'application/octet-stream']]), { params, timeoutMs: 60_000 }))
        .status(413)
        .body()
        .has('$.code', 'knowledge_file_too_large');
      const many = Array.from({ length: 11 }, (_, i) => ['x', `f${i}.txt`, 'text/plain'] as [string, string, string]);
      (await owner.post(LIST, form(many), { params })).status(400).body().has('$.code', 'knowledge_too_many_files');
    });

    await ctx.step('a project member without project.file.write cannot upload or delete -> 403', async () => {
      const asMember = ctx.client.as(member);
      (await asMember.post(LIST, form([['x', 'member.md', 'text/markdown']]), { params })).status(403);
      (await asMember.del(LIST, { params, query: { path: 'member.md' } })).status(403);
      (await asMember.patch(LIST, { path: 'member.md', description: 'x' }, { params })).status(403);
    });

    await ctx.step('a non-member gets 403 or 404 and an anonymous caller gets 401', async () => {
      (await ctx.client.as(ctx.P.NONMEMBER).post(LIST, form([['x', 'n.md', 'text/markdown']]), { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.NONMEMBER).get(LIST, { params })).status([403, 404]);
      (await ctx.client.as(ctx.P.ANON).get(LIST, { params })).status(401);
      (await ctx.client.as(ctx.P.ANON).post(LIST, form([['x', 'a.md', 'text/markdown']]), { params })).status(401);
    });

    await ctx.step('no refused request wrote anything: the knowledge folder is still empty', async () => {
      (await owner.get(LIST, { params })).status(200).body().has('$.files.length', 0).has('$.index_exists', false);
    });
  },
);
