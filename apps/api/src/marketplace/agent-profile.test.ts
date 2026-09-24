import { describe, expect, test } from 'bun:test';
import type { RegistryItem } from '@kortix/registry';
import {
  agentNameOf,
  deriveAgentProfile,
  governanceYaml,
  splitAgentMarkdown,
  validateAgentGrants,
} from './agent-profile';

// Synthetic fixtures only — a neutral "triage" persona and its use-case template.
function agentItem(overrides: Partial<RegistryItem> = {}): RegistryItem {
  return {
    name: 'triage-agent',
    type: 'registry:agent',
    title: 'Triage agent',
    files: [{ path: 'runtime/agents/triage.md', type: 'registry:file', target: '@agents/triage.md' }],
    ...overrides,
  };
}

function templateItem(agents: Record<string, unknown>): RegistryItem {
  return {
    name: 'triage',
    type: 'registry:template',
    registryDependencies: ['triage-agent', 'triage-rules'],
    meta: { template: { agents } },
  };
}

describe('agentNameOf', () => {
  test('uses the agent file basename, which is the kortix.yaml key', () => {
    expect(agentNameOf(agentItem())).toBe('triage');
  });

  test('falls back to the item name when no agent file is declared', () => {
    expect(agentNameOf(agentItem({ files: [] }))).toBe('triage-agent');
  });
});

describe('deriveAgentProfile', () => {
  test('an explicit meta.agent declaration wins', () => {
    const item = agentItem({
      meta: { agent: { connectors: ['linear'], secrets: ['LINEAR_KEY'], skills: ['triage-rules'] } },
    });
    const profile = deriveAgentProfile(item, [item, templateItem({ triage: { connectors: ['jira'] } })]);
    expect(profile).toEqual({
      name: 'triage',
      file: '@agents/triage.md',
      governance: {
        connectors: ['linear'],
        secrets: ['LINEAR_KEY'],
        skills: ['triage-rules'],
        kortix_permissions: [],
      },
      governanceSource: 'declared',
    });
  });

  test('otherwise it reads the grant from the sibling template that installs the agent', () => {
    const item = agentItem();
    const tpl = templateItem({
      triage: { connectors: ['linear'], secrets: ['LINEAR_KEY'], skills: ['triage-rules'] },
    });
    const profile = deriveAgentProfile(item, [item, tpl]);
    expect(profile.governanceSource).toBe('template');
    expect(profile.templateName).toBe('triage');
    expect(profile.governance).toEqual({
      connectors: ['linear'],
      secrets: ['LINEAR_KEY'],
      skills: ['triage-rules'],
      kortix_permissions: [],
    });
  });

  test('declared capabilities (meta.capabilities / envVars) fold into the grant', () => {
    const item = agentItem({
      envVars: { SEARCH_KEY: 'search api key' },
      meta: { capabilities: { connectors: ['slack'] } },
    });
    const profile = deriveAgentProfile(item, [item]);
    expect(profile.governance.secrets).toEqual(['SEARCH_KEY']);
    expect(profile.governance.connectors).toEqual(['slack']);
    expect(profile.governanceSource).toBe('declared');
  });

  test('no declaration anywhere → deny-by-default (empty grant)', () => {
    const item = agentItem();
    const profile = deriveAgentProfile(item, [item]);
    expect(profile.governanceSource).toBe('none');
    expect(profile.governance).toEqual({
      connectors: [],
      secrets: [],
      skills: [],
      kortix_permissions: [],
    });
  });

  test('an "all" wildcard from a marketplace item is never granted', () => {
    const item = agentItem({ meta: { agent: { connectors: 'all', secrets: ['A', 'A', 7] } } });
    const profile = deriveAgentProfile(item, [item]);
    expect(profile.governance.connectors).toEqual([]);
    expect(profile.governance.secrets).toEqual(['A']);
  });
});

describe('governanceYaml', () => {
  test('renders the exact agents: block, omitting empty grants (deny-by-default)', () => {
    const yaml = governanceYaml('triage', {
      connectors: ['linear'],
      secrets: [],
      skills: ['triage-rules'],
      kortix_permissions: [],
    });
    expect(yaml).toBe('agents:\n  triage:\n    connectors:\n      - linear\n    skills:\n      - triage-rules\n');
  });

  test('an agent with no grants renders an empty mapping, not a wildcard', () => {
    expect(
      governanceYaml('triage', { connectors: [], secrets: [], skills: [], kortix_permissions: [] }),
    ).toBe('agents:\n  triage: {}\n');
  });
});

describe('splitAgentMarkdown', () => {
  test('separates YAML frontmatter from the prompt body', () => {
    const raw = '---\ndescription: >-\n  Triage\n  inbound issues.\nmode: primary\n---\n\nYou triage.\n';
    expect(splitAgentMarkdown(raw)).toEqual({
      frontmatter: { description: 'Triage inbound issues.', mode: 'primary' },
      prompt: 'You triage.\n',
    });
  });

  test('a file without frontmatter is all prompt', () => {
    expect(splitAgentMarkdown('You triage.')).toEqual({ frontmatter: {}, prompt: 'You triage.' });
  });
});

describe('validateAgentGrants', () => {
  const declared = {
    connectors: ['linear'],
    secrets: ['LINEAR_KEY'],
    skills: ['triage-rules'],
    kortix_permissions: [],
  };

  test('absent grants approve the full declared set', () => {
    expect(validateAgentGrants(undefined, declared)).toEqual({ ok: true, grants: declared });
  });

  test('a subset is accepted and missing kinds are denied', () => {
    expect(validateAgentGrants({ connectors: ['linear'] }, declared)).toEqual({
      ok: true,
      grants: { connectors: ['linear'], secrets: [], skills: [], kortix_permissions: [] },
    });
  });

  test('a grant the agent never declared is rejected', () => {
    const result = validateAgentGrants({ secrets: ['OTHER_KEY'] }, declared);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('OTHER_KEY');
  });

  test('a malformed grants payload is rejected', () => {
    expect(validateAgentGrants('all', declared).ok).toBe(false);
    expect(validateAgentGrants({ connectors: 'linear' }, declared).ok).toBe(false);
    expect(validateAgentGrants({ tools: ['x'] }, declared).ok).toBe(false);
  });
});
