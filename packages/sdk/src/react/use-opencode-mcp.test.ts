import { describe, expect, test } from 'bun:test';

import * as root from '../index';
import * as react from './index';

/** The JSDoc block that sits directly on `export function <name>`. */
async function jsdocFor(name: string): Promise<string> {
  const source = await Bun.file(new URL('./use-opencode-mcp.ts', import.meta.url).pathname).text();
  const at = source.indexOf(`export function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  const before = source.slice(0, at).trimEnd();
  expect(before.endsWith('*/')).toBe(true);
  return before.slice(before.lastIndexOf('/**'));
}

describe('useAddMcpServer deprecation', () => {
  test('stays exported from ./react (removing it is a breaking change)', () => {
    expect(typeof (react as Record<string, unknown>).useAddMcpServer).toBe('function');
  });

  test('is marked @deprecated, says why, and names the persistent replacement', async () => {
    const doc = await jsdocFor('useAddMcpServer');
    expect(doc).toContain('@deprecated');
    // The reason: OpenCode's POST /mcp is process memory only.
    expect(doc).toContain('in-memory');
    expect(doc).toContain('restart');
    // The replacement, by its real exported names.
    expect(doc).toContain('createConnector');
    expect(doc).toContain("provider: 'mcp'");
    expect(doc).toContain('discoverConnectorAuth');
  });

  test('the names the deprecation points to are real root exports', () => {
    const exported = root as Record<string, unknown>;
    expect(typeof exported.createConnector).toBe('function');
    expect(typeof exported.discoverConnectorAuth).toBe('function');
  });
});
