/**
 * Project knowledge — the pure half: path rules, limits, and the INDEX.md
 * format. No I/O, so every rule here is unit-tested in isolation.
 *
 * Knowledge is a folder convention, not a table: documents live in the
 * project repository under `.kortix/knowledge/`, beside an `INDEX.md` that
 * lists one line per file. The repository is cloned into every session, so an
 * agent reads the index and the files with ordinary file tools.
 */

export const KNOWLEDGE_ROOT = '.kortix/knowledge';
export const KNOWLEDGE_INDEX_FILENAME = 'INDEX.md';
export const KNOWLEDGE_INDEX_PATH = `${KNOWLEDGE_ROOT}/${KNOWLEDGE_INDEX_FILENAME}`;

/** One document. Git hosts warn at 50 MB and refuse 100 MB. */
export const MAX_KNOWLEDGE_FILE_BYTES = 25 * 1024 * 1024;
/** One upload request. */
export const MAX_KNOWLEDGE_UPLOAD_FILES = 10;
export const MAX_KNOWLEDGE_UPLOAD_BYTES = 50 * 1024 * 1024;
/** The whole folder. Every session clones it, so it stays small. */
export const MAX_KNOWLEDGE_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_KNOWLEDGE_DESCRIPTION_CHARS = 280;

const MAX_SEGMENT_CHARS = 128;
const MAX_PATH_CHARS = 512;
const MAX_DEPTH = 8;

/** A path or description the knowledge rules refuse. Maps to HTTP 400. */
export class KnowledgePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgePathError';
  }
}

// Control characters, both slashes, and the characters the INDEX.md link
// syntax needs (`[`, `]`, `<`, `>`).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_SEGMENT_CHARS = /[\u0000-\u001f\u007f/\\[\]<>]/;

function assertSegment(segment: string, what: string): void {
  if (!segment) throw new KnowledgePathError(`${what} has an empty path segment`);
  if (segment === '.' || segment === '..') {
    throw new KnowledgePathError(`${what} must stay inside ${KNOWLEDGE_ROOT}/`);
  }
  if (segment.startsWith('.')) {
    throw new KnowledgePathError(`${what} cannot start with "." ("${segment}")`);
  }
  if (segment !== segment.trim()) {
    throw new KnowledgePathError(`${what} cannot start or end with whitespace`);
  }
  if (segment.length > MAX_SEGMENT_CHARS) {
    throw new KnowledgePathError(`${what} segment is over ${MAX_SEGMENT_CHARS} characters`);
  }
  if (FORBIDDEN_SEGMENT_CHARS.test(segment)) {
    throw new KnowledgePathError(`${what} contains a forbidden character`);
  }
}

/**
 * Validate a knowledge-relative path (`contracts/msa.pdf`). Returns it
 * unchanged, or throws `KnowledgePathError`. The root `INDEX.md` is reserved
 * for the index itself.
 */
export function assertKnowledgeRelativePath(path: string): string {
  if (typeof path !== 'string' || !path) throw new KnowledgePathError('Path is required');
  if (path.length > MAX_PATH_CHARS) {
    throw new KnowledgePathError(`Path is over ${MAX_PATH_CHARS} characters`);
  }
  const segments = path.split('/');
  if (segments.length > MAX_DEPTH) {
    throw new KnowledgePathError(`Path is deeper than ${MAX_DEPTH} levels`);
  }
  for (const segment of segments) assertSegment(segment, 'Path');
  if (segments.length === 1 && segments[0]!.toLowerCase() === KNOWLEDGE_INDEX_FILENAME.toLowerCase()) {
    throw new KnowledgePathError(`${KNOWLEDGE_INDEX_FILENAME} is reserved for the knowledge index`);
  }
  return path;
}

/**
 * Join an optional folder (`contracts/2026`, surrounding slashes and
 * whitespace ignored) and a filename into one knowledge-relative path.
 */
export function normalizeKnowledgePath(filename: string, folder?: string | null): string {
  const name = typeof filename === 'string' ? filename.trim() : '';
  if (!name) throw new KnowledgePathError('Filename is required');
  if (name.includes('/') || name.includes('\\')) {
    throw new KnowledgePathError('Filename cannot contain a slash');
  }
  const trimmedFolder = (folder ?? '').trim().replace(/^\/+|\/+$/g, '');
  return assertKnowledgeRelativePath(trimmedFolder ? `${trimmedFolder}/${name}` : name);
}

/** One line, collapsed whitespace, `null` when empty. */
export function normalizeKnowledgeDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new KnowledgePathError('Description must be a string');
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length > MAX_KNOWLEDGE_DESCRIPTION_CHARS) {
    throw new KnowledgePathError(
      `Description is over ${MAX_KNOWLEDGE_DESCRIPTION_CHARS} characters`,
    );
  }
  return collapsed;
}

export function knowledgeFileType(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'file';
  return name.slice(dot + 1).toLowerCase();
}

export function formatKnowledgeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface KnowledgeIndexEntry {
  path: string;
  size: number;
}

const INDEX_HEADER = [
  '# Knowledge',
  '',
  'Project documents for agents and people. The files live beside this index in',
  '`.kortix/knowledge/`, and every session has a copy. One line per file: path,',
  'type, size, and a one-line description. Keep this index in sync when you add,',
  'move, or remove a document — the `kortix-knowledge` skill has the format.',
  '',
];

/**
 * Render INDEX.md from the files that exist and the descriptions known for
 * them. Entries sort by path, so the file is stable across writers.
 */
export function renderKnowledgeIndex(
  entries: readonly KnowledgeIndexEntry[],
  descriptions: ReadonlyMap<string, string | null>,
): string {
  const lines = [...INDEX_HEADER];
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length === 0) lines.push('_No documents yet._');
  for (const entry of sorted) {
    const meta = `${knowledgeFileType(entry.path)} · ${formatKnowledgeBytes(entry.size)}`;
    const description = descriptions.get(entry.path);
    lines.push(
      `- [${entry.path}](<${entry.path}>) — ${meta}${description ? ` — ${description}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const ENTRY_LINE = /^- \[([^\]]+)\]\((?:<[^>]*>|[^)\s]*)\)\s+—\s+(.*)$/;

/**
 * Read the description of every entry line in INDEX.md, keyed by path.
 * Tolerant: prose, headings, and malformed lines are ignored, so a
 * hand-edited index never breaks the listing.
 */
export function parseKnowledgeIndex(text: string): Map<string, string | null> {
  const descriptions = new Map<string, string | null>();
  for (const line of text.split('\n')) {
    const match = ENTRY_LINE.exec(line.trimEnd());
    if (!match) continue;
    const rest = match[2] ?? '';
    const separator = rest.indexOf(' — ');
    const description = separator === -1 ? '' : rest.slice(separator + 3).trim();
    descriptions.set(match[1]!, description || null);
  }
  return descriptions;
}
