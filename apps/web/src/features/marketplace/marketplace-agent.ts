import type { UiTranslator } from '@/i18n/translator';
import type { AgentGovernance, MarketplaceInstallGrants } from '@/lib/marketplace-client';

/** Grant kinds in display order. Mirrors the API's `AGENT_GRANT_KINDS`. */
export type AgentGrantKind = keyof AgentGovernance;

export const AGENT_GRANT_KINDS: AgentGrantKind[] = [
  'connectors',
  'secrets',
  'skills',
  'kortix_permissions',
];

/** One reviewable grant: a single connector, secret, skill, or permission. */
export interface AgentGrantRow {
  /** Stable `<kind>:<value>` key — also the declined-set member. */
  key: string;
  kind: AgentGrantKind;
  value: string;
}

export function agentGrantRows(governance: AgentGovernance | undefined): AgentGrantRow[] {
  if (!governance) return [];
  return AGENT_GRANT_KINDS.flatMap((kind) =>
    (governance[kind] ?? []).map((value) => ({ key: `${kind}:${value}`, kind, value })),
  );
}

/** The grant sent to the install session: the declared grant minus declined
 *  rows. Every kind is explicit, so an emptied kind reads as "none" server-side
 *  instead of "approve everything". */
export function approvedAgentGrants(
  governance: AgentGovernance,
  declined: ReadonlySet<string>,
): Required<MarketplaceInstallGrants> {
  const out = { connectors: [], secrets: [], skills: [], kortix_permissions: [] } as Required<
    MarketplaceInstallGrants
  >;
  for (const row of agentGrantRows(governance)) {
    if (!declined.has(row.key)) out[row.kind].push(row.value);
  }
  return out;
}

/** Plain-language sentence for one grant ("Use your stripe connection"). */
export function agentGrantCopy(kind: AgentGrantKind, value: string, t: UiTranslator): string {
  switch (kind) {
    case 'connectors':
      return t('text40cc6b0da5a3', { value0: value });
    case 'secrets':
      return t('texte71987cb4f83', { value0: value });
    case 'skills':
      return t('text2feb0245036c', { value0: value });
    case 'kortix_permissions':
      return t('textbaf0a7ae2251', { value0: value });
  }
}

/** The grant sentence split around its value, so the value (a connector
 *  slug, secret name, skill, or permission — all identifiers) renders in code
 *  style while the surrounding words stay translated. */
export function agentGrantCopyParts(
  kind: AgentGrantKind,
  value: string,
  t: UiTranslator,
): { before: string; value: string; after: string } {
  const marker = '\u0000';
  const sentence = agentGrantCopy(kind, marker, t);
  const at = sentence.indexOf(marker);
  if (at === -1) return { before: agentGrantCopy(kind, value, t), value: '', after: '' };
  return { before: sentence.slice(0, at), value, after: sentence.slice(at + marker.length) };
}

/** Short kind label for a grant row's badge. */
export function agentGrantKindLabel(kind: AgentGrantKind, t: UiTranslator): string {
  switch (kind) {
    case 'connectors':
      return t.raw('text8f0d706fff25');
    case 'secrets':
      return t.raw('text7e32a729b122');
    case 'skills':
      return t.raw('text6df1bb18a59a');
    case 'kortix_permissions':
      return t.raw('text229efc8f5263');
  }
}

/** The agent file's frontmatter as display rows. `description` is skipped —
 *  the detail header already shows it. */
export function frontmatterEntries(
  frontmatter: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  return Object.entries(frontmatter)
    .filter(([key]) => key !== 'description')
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }));
}
