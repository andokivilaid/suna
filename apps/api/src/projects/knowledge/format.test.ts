import { describe, expect, test } from 'bun:test';
import {
  KNOWLEDGE_INDEX_FILENAME,
  KnowledgePathError,
  formatKnowledgeBytes,
  knowledgeFileType,
  normalizeKnowledgeDescription,
  normalizeKnowledgePath,
  parseKnowledgeIndex,
  renderKnowledgeIndex,
} from './format';

describe('normalizeKnowledgePath', () => {
  test('joins an optional folder and a filename into one relative path', () => {
    expect(normalizeKnowledgePath('brief.md')).toBe('brief.md');
    expect(normalizeKnowledgePath('msa.pdf', 'contracts/2026')).toBe('contracts/2026/msa.pdf');
    expect(normalizeKnowledgePath('msa.pdf', '/contracts/')).toBe('contracts/msa.pdf');
    expect(normalizeKnowledgePath('Q3 report (final).pdf', ' finance ')).toBe(
      'finance/Q3 report (final).pdf',
    );
  });

  test('rejects traversal, absolute, hidden, and reserved paths', () => {
    const rejected: Array<[string, string?]> = [
      ['../kortix.yaml'],
      ['a.md', '..'],
      ['a.md', 'x/../../y'],
      ['a.md', './x'],
      ['.env'],
      ['a.md', '.git'],
      ['a\\b.md'],
      ['a/b.md'],
      [''],
      ['   '],
      ['a\u0000.md'],
      ['a]b.md'],
      ['a<b.md'],
      [KNOWLEDGE_INDEX_FILENAME],
      ['index.md'],
      ['x'.repeat(200)],
    ];
    for (const [name, folder] of rejected) {
      expect(() => normalizeKnowledgePath(name, folder)).toThrow(KnowledgePathError);
    }
  });

  test('an index-named file inside a folder is an ordinary document', () => {
    expect(normalizeKnowledgePath('INDEX.md', 'notes')).toBe('notes/INDEX.md');
  });
});

describe('normalizeKnowledgeDescription', () => {
  test('collapses whitespace to one line and maps empty to null', () => {
    expect(normalizeKnowledgeDescription('  Master\n services   agreement ')).toBe(
      'Master services agreement',
    );
    expect(normalizeKnowledgeDescription('   ')).toBeNull();
    expect(normalizeKnowledgeDescription(undefined)).toBeNull();
  });

  test('rejects a description over 280 characters', () => {
    expect(() => normalizeKnowledgeDescription('a'.repeat(281))).toThrow(KnowledgePathError);
  });
});

describe('formatting helpers', () => {
  test('file type is the lowercase extension, or "file"', () => {
    expect(knowledgeFileType('a/B.PDF')).toBe('pdf');
    expect(knowledgeFileType('Makefile')).toBe('file');
  });

  test('sizes use binary units with one decimal above 1 KB', () => {
    expect(formatKnowledgeBytes(0)).toBe('0 B');
    expect(formatKnowledgeBytes(512)).toBe('512 B');
    expect(formatKnowledgeBytes(1536)).toBe('1.5 KB');
    expect(formatKnowledgeBytes(25 * 1024 * 1024)).toBe('25.0 MB');
  });
});

describe('INDEX.md', () => {
  const entries = [
    { path: 'contracts/msa.pdf', size: 1_258_291 },
    { path: 'brief.md', size: 1200 },
    { path: 'Q3 report (final).xlsx', size: 90 },
  ];
  const descriptions = new Map([
    ['contracts/msa.pdf', 'Master services agreement — signed copy'],
    ['brief.md', null],
  ]);

  test('renders one sorted line per file with type, size, and description', () => {
    const text = renderKnowledgeIndex(entries, descriptions);
    expect(text).toContain('# Knowledge');
    const lines = text.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toEqual([
      '- [Q3 report (final).xlsx](<Q3 report (final).xlsx>) — xlsx · 90 B',
      '- [brief.md](<brief.md>) — md · 1.2 KB',
      '- [contracts/msa.pdf](<contracts/msa.pdf>) — pdf · 1.2 MB — Master services agreement — signed copy',
    ]);
  });

  test('parse(render(x)) recovers every description by path', () => {
    const parsed = parseKnowledgeIndex(renderKnowledgeIndex(entries, descriptions));
    expect(parsed.get('contracts/msa.pdf')).toBe('Master services agreement — signed copy');
    expect(parsed.get('brief.md')).toBeNull();
    expect(parsed.get('Q3 report (final).xlsx')).toBeNull();
  });

  test('parse tolerates hand-written lines and ignores prose', () => {
    const parsed = parseKnowledgeIndex(
      [
        '# Knowledge',
        'Some prose an agent wrote.',
        '- [notes.md](notes.md) — md · 2 KB — Meeting notes',
        '* not an entry',
      ].join('\n'),
    );
    expect([...parsed.entries()]).toEqual([['notes.md', 'Meeting notes']]);
  });

  test('an empty folder renders an explicit empty marker', () => {
    expect(renderKnowledgeIndex([], new Map())).toContain('_No documents yet._');
  });
});
