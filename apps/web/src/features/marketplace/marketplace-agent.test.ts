import { describe, expect, test } from 'bun:test';

import { testUiTranslator } from '@/i18n/test-translator';
import type { AgentGovernance } from '@/lib/marketplace-client';
import {
  agentGrantCopy,
  agentGrantRows,
  approvedAgentGrants,
  frontmatterEntries,
} from './marketplace-agent';

// Synthetic fixture: a neutral "triage" persona.
const governance: AgentGovernance = {
  connectors: ['linear'],
  secrets: ['LINEAR_KEY'],
  skills: ['triage-rules'],
  kortix_permissions: [],
};

describe('agentGrantRows', () => {
  test('flattens the grant into one row per value, in a stable kind order', () => {
    expect(agentGrantRows(governance)).toEqual([
      { key: 'connectors:linear', kind: 'connectors', value: 'linear' },
      { key: 'secrets:LINEAR_KEY', kind: 'secrets', value: 'LINEAR_KEY' },
      { key: 'skills:triage-rules', kind: 'skills', value: 'triage-rules' },
    ]);
  });

  test('a missing profile yields no rows', () => {
    expect(agentGrantRows(undefined)).toEqual([]);
  });
});

describe('approvedAgentGrants', () => {
  test('with nothing declined, every kind carries its full declared list', () => {
    expect(approvedAgentGrants(governance, new Set())).toEqual(governance);
  });

  test('declined rows are removed and every kind stays explicit', () => {
    expect(approvedAgentGrants(governance, new Set(['connectors:linear', 'skills:triage-rules']))).toEqual({
      connectors: [],
      secrets: ['LINEAR_KEY'],
      skills: [],
      kortix_permissions: [],
    });
  });
});

describe('agentGrantCopy', () => {
  test('describes each grant in plain language', () => {
    expect(agentGrantCopy('connectors', 'linear', testUiTranslator)).toBe('Use your linear connection');
    expect(agentGrantCopy('secrets', 'LINEAR_KEY', testUiTranslator)).toBe('Read the LINEAR_KEY secret');
    expect(agentGrantCopy('skills', 'triage-rules', testUiTranslator)).toBe('Load the triage-rules skill');
    expect(agentGrantCopy('kortix_permissions', 'sessions.read', testUiTranslator)).toBe(
      'Use the Kortix sessions.read permission',
    );
  });
});

describe('frontmatterEntries', () => {
  test('lists behavior keys, skips description, and renders non-strings as JSON', () => {
    expect(
      frontmatterEntries({
        description: 'Shown elsewhere',
        mode: 'primary',
        temperature: 0.2,
        permission: { edit: 'deny' },
      }),
    ).toEqual([
      { key: 'mode', value: 'primary' },
      { key: 'temperature', value: '0.2' },
      { key: 'permission', value: '{"edit":"deny"}' },
    ]);
  });
});
