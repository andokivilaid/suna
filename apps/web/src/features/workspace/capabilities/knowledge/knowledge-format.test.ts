import { describe, expect, test } from 'bun:test';
import type { ProjectKnowledgeFile, ProjectKnowledgeLimits } from '@kortix/sdk';

import {
  checkUploadSelection,
  filterKnowledgeFiles,
  formatKnowledgeBytes,
  knowledgeFileName,
  knowledgeFolder,
} from './knowledge-format';

const limits: ProjectKnowledgeLimits = {
  max_file_bytes: 100,
  max_upload_files: 2,
  max_upload_bytes: 150,
  max_total_bytes: 1000,
};

const file = (path: string, description: string | null = null): ProjectKnowledgeFile => ({
  path,
  repo_path: `.kortix/knowledge/${path}`,
  type: path.split('.').pop() ?? 'file',
  size: 10,
  description,
});

describe('formatKnowledgeBytes', () => {
  test('uses binary units with one decimal above 1 KB', () => {
    expect(formatKnowledgeBytes(0)).toBe('0 B');
    expect(formatKnowledgeBytes(1536)).toBe('1.5 KB');
    expect(formatKnowledgeBytes(200 * 1024 * 1024)).toBe('200.0 MB');
  });
});

describe('path helpers', () => {
  test('split a knowledge path into folder and name', () => {
    expect(knowledgeFileName('contracts/2026/msa.pdf')).toBe('msa.pdf');
    expect(knowledgeFolder('contracts/2026/msa.pdf')).toBe('contracts/2026');
    expect(knowledgeFolder('brief.md')).toBe('');
  });
});

describe('filterKnowledgeFiles', () => {
  const files = [file('contracts/msa.pdf', 'Master services agreement'), file('brief.md')];
  test('matches path and description, case-insensitively', () => {
    expect(filterKnowledgeFiles(files, 'MSA').map((f) => f.path)).toEqual(['contracts/msa.pdf']);
    expect(filterKnowledgeFiles(files, 'services').map((f) => f.path)).toEqual(['contracts/msa.pdf']);
    expect(filterKnowledgeFiles(files, '  ')).toEqual(files);
  });
});

describe('checkUploadSelection', () => {
  const f = (name: string, size: number) => ({ name, size });
  test('accepts a selection within every limit', () => {
    expect(checkUploadSelection([f('a.md', 10)], limits, 0)).toBeNull();
  });
  test('names the first file over the per-file limit', () => {
    expect(checkUploadSelection([f('a.md', 10), f('b.pdf', 101)], limits, 0)).toEqual({
      kind: 'file-too-large',
      name: 'b.pdf',
    });
  });
  test('refuses too many files, an oversized request, and a full project', () => {
    expect(checkUploadSelection([f('a', 1), f('b', 1), f('c', 1)], limits, 0)?.kind).toBe('too-many-files');
    expect(checkUploadSelection([f('a', 100), f('b', 100)], limits, 0)?.kind).toBe('upload-too-large');
    expect(checkUploadSelection([f('a', 50)], limits, 960)?.kind).toBe('project-full');
  });
  test('an empty selection is not uploadable', () => {
    expect(checkUploadSelection([], limits, 0)?.kind).toBe('empty');
  });
});
