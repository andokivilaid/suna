import { describe, expect, test } from 'bun:test';
import {
  clampMarketplaceItemsLimit,
  getCatalogItemDetail,
  pageCatalogItems,
  selectTemplateItems,
  type CatalogItem,
} from './catalog';

// Default fixtures use a neutral external registry ('acme') so generic
// filter/pagination behavior is tested independent of the `kortix-starter`
// fold rule (those skills live inside the "Kortix Starter" project now and are
// covered by their own test below).
function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: `acme:${overrides.name ?? 'item'}`,
    registry: 'acme',
    name: 'item',
    type: 'registry:skill',
    title: 'Item',
    description: null,
    categories: [],
    capabilities: { secrets: [], connectors: [], tools: [], network: [] },
    dependencies: [],
    fileCount: 1,
    external: true,
    marketplaceId: 'acme',
    marketplaceLabel: 'Acme',
    ...overrides,
  };
}

function synthetic(count: number, overrides: (i: number) => Partial<CatalogItem> = () => ({})): CatalogItem[] {
  return Array.from({ length: count }, (_, i) =>
    item({ id: `kortix:item-${i}`, name: `item-${i}`, ...overrides(i) }),
  );
}

describe('template + agent resolution', () => {
  test('use-case templates are NOT surfaced in the browse list, but agents are', () => {
    const mix = [
      item({ type: 'registry:template', name: 't', id: 'kortix-starter:t' }),
      item({ type: 'registry:agent', name: 'a', id: 'kortix-starter:a' }),
      item({ type: 'registry:skill', name: 's', id: 'kortix-starter:s' }),
    ];
    expect(pageCatalogItems(mix, {}).items.map((i) => i.type)).toEqual([
      'registry:agent',
      'registry:skill',
    ]);
  });

  test('type=agent (short or full form) narrows the browse list to agents', () => {
    const mix = [
      item({ type: 'registry:agent', name: 'a', id: 'acme:a' }),
      item({ type: 'registry:skill', name: 's', id: 'acme:s' }),
      item({ type: 'registry:agent', name: 'hidden', id: 'acme:hidden', hidden: true }),
    ];
    expect(pageCatalogItems(mix, { type: 'agent' }).items.map((i) => i.id)).toEqual(['acme:a']);
    expect(pageCatalogItems(mix, { type: 'registry:agent' }).total).toBe(1);
  });

  test('but a template resolves by id and detail carries its full declaration', async () => {
    const detail = await getCatalogItemDetail('kortix-starter:customer-support');
    expect(detail).not.toBeNull();
    expect(detail!.type).toBe('registry:template');
    expect((detail!.inputs as Array<{ key: string }>).map((i) => i.key)).toContain('cadence');
    expect(Object.keys(detail!.envVars ?? {})).toContain('PLAIN_API_KEY');
    const tpl = detail!.template as { triggers?: Array<{ slug: string }> };
    expect(tpl.triggers?.map((t) => t.slug)).toContain('support-triage');
  });

  test('and the agent a template installs resolves by id too (for the install-session fetch)', async () => {
    const agent = await getCatalogItemDetail('kortix-starter:support-agent');
    expect(agent).not.toBeNull();
    expect(agent!.type).toBe('registry:agent');
  });

  test('agent detail carries its prompt, frontmatter, and the kortix.yaml grant from its template', async () => {
    const detail = await getCatalogItemDetail('kortix-starter:ar-chaser-agent');
    expect(detail?.agent).toBeDefined();
    const agent = detail!.agent!;
    expect(agent.name).toBe('ar-chaser');
    expect(agent.file).toBe('@agents/ar-chaser.md');
    expect(agent.frontmatter.mode).toBe('primary');
    expect(agent.prompt).toContain('accounts-receivable agent');
    expect(agent.prompt!.startsWith('---')).toBe(false);
    expect(agent.governanceSource).toBe('template');
    expect(agent.templateId).toBe('kortix-starter:ar-chaser');
    expect(agent.governance).toEqual({
      connectors: ['stripe'],
      secrets: ['STRIPE_KEY'],
      skills: ['invoice-math'],
      kortix_permissions: [],
    });
    expect(agent.governanceYaml).toContain('ar-chaser:');
    expect(agent.governanceYaml).toContain('- invoice-math');
    // The grant is the agent's capability manifest on the card too.
    expect(detail!.capabilities.connectors).toContain('stripe');
    expect(detail!.capabilities.secrets).toContain('STRIPE_KEY');
  });

  test('starter-floor agents ship in every project, so they are not browse tiles', () => {
    const mix = [
      item({
        type: 'registry:agent',
        name: 'kortix',
        id: 'kortix-starter:kortix',
        partOfProject: { id: 'kortix-projects:starter', title: 'Kortix Starter' },
      }),
      item({ type: 'registry:agent', name: 'triage-agent', id: 'acme:triage-agent' }),
    ];
    expect(pageCatalogItems(mix, { type: 'agent' }).items.map((i) => i.id)).toEqual([
      'acme:triage-agent',
    ]);
  });

  test('but a starter-floor agent still resolves by id, badged as part of Kortix Starter', async () => {
    const detail = await getCatalogItemDetail('kortix-starter:kortix');
    expect(detail?.type).toBe('registry:agent');
    expect(detail?.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'Kortix Starter' });
  });

  test('non-agent detail has no agent block', async () => {
    const detail = await getCatalogItemDetail('kortix-starter:invoice-math');
    expect(detail).not.toBeNull();
    expect(detail!.agent).toBeUndefined();
  });
});

describe('selectTemplateItems', () => {
  test('keeps registry:template items only, and drops hidden ones', () => {
    const items = [
      item({ id: 'kortix:ar-chaser', name: 'ar-chaser', type: 'registry:template' }),
      item({ id: 'kortix:a-skill', name: 'a-skill', type: 'registry:skill' }),
      item({ id: 'kortix:a-bundle', name: 'a-bundle', type: 'registry:bundle' }),
      item({ id: 'kortix:hidden', name: 'hidden', type: 'registry:template', hidden: true }),
    ];
    expect(selectTemplateItems(items).map((i) => i.name)).toEqual(['ar-chaser']);
  });

  test('returns an empty list when there are no templates', () => {
    expect(selectTemplateItems([item({ type: 'registry:skill' })])).toEqual([]);
  });
});

describe('pageCatalogItems', () => {
  test('slices correctly for a given limit and offset', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 10 });
    expect(result.items).toEqual(items.slice(10, 20));
    expect(result.items.length).toBe(10);
  });

  test('total is the pre-slice filtered count regardless of limit/offset', () => {
    const items = synthetic(25);
    const first = pageCatalogItems(items, { limit: 10, offset: 0 });
    const last = pageCatalogItems(items, { limit: 10, offset: 20 });
    const unpaged = pageCatalogItems(items, {});
    expect(first.total).toBe(25);
    expect(last.total).toBe(25);
    expect(unpaged.total).toBe(25);
  });

  test('more remain after the current page', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 0 });
    expect(result.items.length + 0).toBeLessThan(result.total);
    expect(0 + result.items.length < result.total).toBe(true);
  });

  test('no more remain on the last page', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 20 });
    expect(20 + result.items.length < result.total).toBe(false);
  });

  test('no limit means no pagination signal, i.e. the full list is returned', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, {});
    expect(0 + result.items.length < result.total).toBe(false);
  });

  test('absent limit returns the full filtered list (opt-in guarantee)', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, {});
    expect(result.items).toEqual(items);
    expect(result.items.length).toBe(25);
  });

  test('invalid limit values (zero, negative, non-finite) also skip pagination', () => {
    const items = synthetic(5);
    expect(pageCatalogItems(items, { limit: 0 }).items.length).toBe(5);
    expect(pageCatalogItems(items, { limit: -3 }).items.length).toBe(5);
    expect(pageCatalogItems(items, { limit: Number.NaN }).items.length).toBe(5);
  });

  test('query/type/source filters compose with paging and the visible-type filter stays intact', () => {
    // 'kortix-projects' is a browseable Kortix registry (maps to source 'kortix');
    // 'kortix-starter' items are folded away, so we use projects here.
    const items = [
      ...synthetic(3, (i) => ({ name: `alpha-${i}`, title: `Alpha ${i}`, type: 'registry:skill', registry: 'kortix-projects', marketplaceId: 'kortix' })),
      ...synthetic(3, (i) => ({ name: `beta-${i}`, title: `Beta ${i}`, type: 'registry:skill', registry: 'other-registry' })),
      item({ id: 'hidden-tool', name: 'hidden-tool', title: 'Hidden Tool', type: 'registry:tool', registry: 'kortix-projects' }),
    ];
    const result = pageCatalogItems(items, { query: 'alpha', source: 'kortix', limit: 2, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.items.length).toBe(2);
    expect(result.items.every((it) => it.name.startsWith('alpha'))).toBe(true);
  });

  test('surfaces kortix-starter skills in the browse list alongside the Kortix Starter project', () => {
    const items = [
      item({
        id: 'kortix-starter:pdf',
        name: 'pdf',
        type: 'registry:skill',
        registry: 'kortix-starter',
        partOfProject: { id: 'kortix-projects:starter', title: 'Kortix Starter' },
      }),
      item({ id: 'kortix-projects:starter', name: 'starter', type: 'registry:project', registry: 'kortix-projects' }),
    ];
    const result = pageCatalogItems(items, {});
    expect(result.items.map((it) => it.name).sort()).toEqual(['pdf', 'starter']);
    expect(result.total).toBe(2);
    const pdf = result.items.find((it) => it.name === 'pdf')!;
    expect(pdf.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'Kortix Starter' });
  });

  test('surfaces skills, agents, and projects as browseable; hides commands/bundles/support types', () => {
    const items = [
      item({ id: 'k:skill', name: 'a-skill', type: 'registry:skill' }),
      item({ id: 'k:project', name: 'a-project', type: 'registry:project' }),
      item({ id: 'k:agent', name: 'a-agent', type: 'registry:agent' }),
      item({ id: 'k:command', name: 'a-command', type: 'registry:command' }),
      item({ id: 'k:bundle', name: 'a-bundle', type: 'registry:bundle' }),
      item({ id: 'k:tool', name: 'a-tool', type: 'registry:tool' }),
      item({ id: 'k:rules', name: 'a-rules', type: 'registry:rules' }),
    ];
    const result = pageCatalogItems(items, {});
    const visible = new Set(result.items.map((it) => it.type));
    expect(visible).toEqual(new Set(['registry:skill', 'registry:agent', 'registry:project']));
    expect(result.total).toBe(3);
  });

  test('offset past the end returns empty items, hasMore false, and a correct total', () => {
    const items = synthetic(5);
    const result = pageCatalogItems(items, { limit: 10, offset: 50 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(5);
    expect(50 + result.items.length < result.total).toBe(false);
  });
});

describe('clampMarketplaceItemsLimit', () => {
  test('passes an in-range limit through unchanged', () => {
    expect(clampMarketplaceItemsLimit(30)).toBe(30);
  });

  test('passes the explore-landing limit (120) through unchanged', () => {
    expect(clampMarketplaceItemsLimit(120)).toBe(120);
  });

  test('passes the ceiling itself (200) through unchanged', () => {
    expect(clampMarketplaceItemsLimit(200)).toBe(200);
  });

  test('clamps a limit above 200 down to 200', () => {
    expect(clampMarketplaceItemsLimit(201)).toBe(200);
    expect(clampMarketplaceItemsLimit(5000)).toBe(200);
  });

  test('clamps a non-positive limit up to 1', () => {
    expect(clampMarketplaceItemsLimit(0)).toBe(1);
    expect(clampMarketplaceItemsLimit(-3)).toBe(1);
  });
});
