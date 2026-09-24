'use client';

import { useTranslations } from '@/i18n/use-translations';
import { PlusIcon as Plus, MagnifyingGlassIcon as Search } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import { displayCompanyLabel } from '@/features/marketplace/marketplace-company-filter';
import { MarketplacePagedGrid } from '@/features/marketplace/marketplace-paged-grid';
import { MarketplaceProjectsGrid } from '@/features/marketplace/marketplace-projects-grid';
import { type MarketplaceItem, type MarketplaceSummary } from '@/lib/marketplace-client';
import { companyIdFromSlug, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { cn } from '@/lib/utils';
import { AddMarketplaceModal } from './add-marketplace-modal';
import {
  MARKETPLACE_GRID_COLUMNS,
  marketplaceBrowseTypes,
  marketplaceTypeFromParam,
  resolveMarketplaceTypeSectionTotal,
  sumMarketplaceTypeCounts,
  withMarketplaceTypeParam,
} from './marketplace-grid';
import { typeMeta } from './marketplace-meta';
import { MarketplaceShell, type MarketplaceCrumb } from './marketplace-shell';

// Skills and agents are browseable alongside Projects (commands/bundles are
// hidden from browse — see MARKETPLACE_VISIBLE_TYPES on the API).

const ALL_SOURCES = 'all';
const ALL_TYPES = 'all';

function sectionId(type: string): string {
  return `type-${type.replace('registry:', '')}`;
}

function pluralize(label: string): string {
  return label.endsWith('s') ? label : `${label}s`;
}

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4 space-y-1">
      <h2 className="text-foreground text-xl font-medium tracking-tight text-balance">{title}</h2>
      {subtitle ? (
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{subtitle}</p>
      ) : null}
    </div>
  );
}

/** One row in the left-rail source filter. */
function SourceRow({
  label,
  count,
  active,
  avatar,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  avatar?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm transition-colors',
        active
          ? 'bg-primary/[0.06] text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
      )}
    >
      {avatar ? <span className="shrink-0">{avatar}</span> : null}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">{count}</span>
      ) : null}
    </button>
  );
}

export function MarketplaceExplore({
  items: catalogItems,
  marketplaces,
  projectItems,
  embedded = false,
  syncUrl = true,
  publicOnly = true,
  scrollContainerRef,
}: {
  /** SSR-bounded first page of the catalog (all sources) — feeds the
   *  "All sources" sectioned preview + Featured rail. */
  items: MarketplaceItem[];
  marketplaces: MarketplaceSummary[];
  /** Every `registry:project` item, server-rendered (not client-fetched) so
   *  the Projects showcase is fully indexed/static. */
  projectItems: MarketplaceItem[];
  /** Render inside a panel (Customize tab) — drops the marketing page chrome. */
  embedded?: boolean;
  /** Mirror the source filter to the URL (`?source=`). Off when embedded. */
  syncUrl?: boolean;
  /** Unauthenticated catalog reads (public). Off for the in-project view. */
  publicOnly?: boolean;
  /** Ancestor scroll element to virtualize the grids against (in-project). */
  scrollContainerRef?: RefObject<HTMLElement | null>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Source filter lives in the left rail — one surface, filtered in place. On
  // the public page ('all') stays fully SSR'd and a deep-linked `?source=` is
  // picked up after hydration; embedded (Customize) keeps it purely local.
  const [source, setSource] = useState<string>(ALL_SOURCES);
  // Type facet (Skills / Agents). Public page mirrors it to `?type=`.
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);

  useEffect(() => {
    if (!syncUrl) return;
    const params = new URLSearchParams(window.location.search);
    const slug = params.get('source');
    if (slug) setSource(companyIdFromSlug(slug));
    setTypeFilter(marketplaceTypeFromParam(params.get('type')));
  }, [syncUrl]);

  const scrollToTop = useCallback(() => {
    if (syncUrl) window.scrollTo({ top: 0, behavior: 'smooth' });
    else scrollContainerRef?.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [syncUrl, scrollContainerRef]);

  const selectSource = useCallback(
    (id: string) => {
      setSource(id);
      if (syncUrl) {
        window.history.replaceState(
          null,
          '',
          withMarketplaceTypeParam(marketplaceSourceHref(id), typeFilter),
        );
      }
      scrollToTop();
    },
    [syncUrl, typeFilter, scrollToTop],
  );

  const selectType = useCallback(
    (type: string) => {
      setTypeFilter(type);
      if (syncUrl) {
        window.history.replaceState(
          null,
          '',
          withMarketplaceTypeParam(`${window.location.pathname}${window.location.search}`, type),
        );
      }
      scrollToTop();
    },
    [syncUrl, scrollToTop],
  );

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Adding/activating sources is an authenticated action — the public marketing
  // page stays browse-only. The featured list + custom git URL live in the
  // "Add a source" modal so the rail stays short (just enabled sources).
  const canManageSources = !publicOnly;
  const [addSourceOpen, setAddSourceOpen] = useState(false);

  const searching = debounced.length > 0;
  const isAll = source === ALL_SOURCES;
  const showProjects = !searching && (isAll || source === 'kortix');
  const sourceLabel = isAll
    ? null
    : displayCompanyLabel(source, marketplaces.find((m) => m.id === source)?.label);

  // Hide items that ship inside a project (e.g. the Kortix Starter skills) from
  // the main grid — the project represents them here. They stay fully browseable
  // by id and addable individually (project detail, add-to-project), just not as
  // their own tiles on the landing grid.
  const componentItems = useMemo(
    () => catalogItems.filter((it) => it.type !== 'registry:project' && !it.partOfProject),
    [catalogItems],
  );
  const typeCounts = useMemo(() => sumMarketplaceTypeCounts(marketplaces), [marketplaces]);

  // One section per browse type that has items — from the loaded page or the
  // source summaries, so agents appear even when the SSR-bounded first page
  // holds none of them.
  const browseTypes = useMemo(
    () =>
      marketplaceBrowseTypes(
        componentItems.map((it) => it.type),
        typeCounts,
      ),
    [componentItems, typeCounts],
  );
  const activeType = browseTypes.includes(typeFilter) ? typeFilter : ALL_TYPES;
  const typeParam = activeType === ALL_TYPES ? undefined : activeType;

  const groups = useMemo(
    () =>
      browseTypes
        .filter((type) => activeType === ALL_TYPES || type === activeType)
        .map((type) => {
          const localCount = componentItems.filter((it) => it.type === type).length;
          return {
            type,
            label: pluralize(typeMeta(type, tI18nComplete).label),
            total: resolveMarketplaceTypeSectionTotal(type, typeCounts, localCount),
          };
        }),
    [browseTypes, activeType, componentItems, typeCounts, tI18nComplete],
  );
  const catalogHeading =
    groups.length === 1 ? groups[0].label : tI18nComplete.raw('text9ff64b83cc7c');

  // Embedded: the fixed top bar already says "Marketplace", so the lone
  // "Marketplace" crumb on the all-sources view is redundant — drop it. A
  // selected source still gets a crumb for the back-to-all affordance.
  const crumbs: MarketplaceCrumb[] = isAll
    ? embedded
      ? []
      : [{ label: tI18nComplete.raw('textc608981d8d68') }]
    : [
        embedded
          ? {
              label: tI18nComplete.raw('textc608981d8d68'),
              onClick: () => selectSource(ALL_SOURCES),
            }
          : { label: tI18nComplete.raw('textc608981d8d68'), href: '/marketplace' },
        { label: sourceLabel ?? source },
      ];

  return (
    <MarketplaceShell
      embedded={embedded}
      scrollRef={scrollContainerRef}
      crumbs={crumbs}
      sidebar={
        <>
          <div className="space-y-2">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              {tI18nComplete.raw('texta9ab23617be7')}
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              {tI18nComplete.raw('texte09bc645d309')}
            </p>
          </div>

          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder={tI18nComplete.raw('text0a6ea1b07058')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              variant="popover"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>

          {browseTypes.length > 1 ? (
            <div className="space-y-1" data-testid="marketplace-type-facet">
              <div className="text-muted-foreground px-2.5 pb-1 text-xs font-medium">
                {tI18nComplete.raw('texta5fc918683bf')}
              </div>
              <SourceRow
                label={tI18nComplete.raw('textf10988e79e8d')}
                active={activeType === ALL_TYPES}
                onClick={() => selectType(ALL_TYPES)}
              />
              {browseTypes.map((type) => {
                const tm = typeMeta(type, tI18nComplete);
                return (
                  <SourceRow
                    key={type}
                    label={pluralize(tm.label)}
                    count={typeCounts[type.replace(/^registry:/, '')]}
                    active={activeType === type}
                    avatar={<tm.Icon className="text-muted-foreground size-4" />}
                    onClick={() => selectType(type)}
                  />
                );
              })}
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 px-2.5 pb-1">
              <div className="text-muted-foreground text-xs font-medium">
                {tI18nComplete.raw('textcaf85b0888d7')}
              </div>
              {canManageSources ? (
                <button
                  type="button"
                  onClick={() => setAddSourceOpen(true)}
                  className="text-muted-foreground/70 hover:text-foreground -mr-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition-colors"
                >
                  <Plus className="size-3.5 shrink-0" />
                  {tI18nComplete.raw('text9fd728c66c9a')}
                </button>
              ) : null}
            </div>
            <SourceRow
              label={tI18nComplete.raw('text08e774c5bacc')}
              active={isAll}
              onClick={() => selectSource(ALL_SOURCES)}
            />
            {marketplaces.map((m) => (
              <SourceRow
                key={m.id}
                label={displayCompanyLabel(m.id, m.label)}
                count={m.count}
                active={source === m.id}
                avatar={
                  <MarketplaceAvatar
                    id={m.id}
                    owner={m.owner}
                    sourceUrl={m.sourceUrl}
                    label={m.label}
                    size="xs"
                  />
                }
                onClick={() => selectSource(m.id)}
              />
            ))}
          </div>

          {canManageSources ? (
            <AddMarketplaceModal open={addSourceOpen} onOpenChange={setAddSourceOpen} />
          ) : null}
        </>
      }
    >
      <div className="space-y-16">
        {showProjects ? (
          <section className="scroll-mt-28">
            <SectionHeading
              title={tI18nComplete.raw('text4b11e510f62b')}
              subtitle={tI18nComplete.raw('textc068cf296b8d')}
            />
            <MarketplaceProjectsGrid items={projectItems} query={debounced} size="featured" />
          </section>
        ) : null}

        {/* Hidden entirely when there's nothing to show — no empty-state placeholder. */}
        {searching || !isAll || componentItems.length > 0 ? (
          <div className="space-y-12">
            <SectionHeading
              title={sourceLabel ?? catalogHeading}
              subtitle={tI18nComplete.raw('text705edc563dcc')}
            />

            {searching ? (
              <MarketplacePagedGrid
                query={debounced}
                type={typeParam}
                source={isAll ? undefined : source}
                publicOnly={publicOnly}
                scrollContainerRef={scrollContainerRef}
                columns={MARKETPLACE_GRID_COLUMNS}
                gridClassName="sm:grid-cols-3"
                showSource={isAll}
                emptyTitle={tI18nComplete.raw('text2df01a03ff43')}
                emptyDescription={tI18nComplete('text05f82c79bce3', { value0: debounced })}
                emptyAction={
                  <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                    {tI18nComplete.raw('text3b7ea51793e9')}
                  </Button>
                }
                header={({ total }) => (
                  <div className="text-muted-foreground text-sm">
                    <span className="tabular-nums">{total}</span>{' '}
                    {total === 1 ? 'result' : 'results'} {tI18nComplete.raw('text0981ce2e694b')}
                    {debounced}
                    {tI18nComplete.raw('textd1fc8381e22d')}
                  </div>
                )}
              />
            ) : isAll ? (
              // Show the whole catalog at once — one virtualized, scrollable grid
              // per type. A single visible type → no redundant per-type heading
              // (the section heading above already names it). When there's
              // nothing here, the section is hidden entirely (see the wrapper below).
              <div className="space-y-12">
                {groups.map((g) => (
                  <section key={g.type} id={sectionId(g.type)} className="scroll-mt-28">
                    {groups.length > 1 ? (
                      <h2 className="text-foreground mb-3 text-lg font-medium tracking-tight text-balance">
                        {g.label}
                      </h2>
                    ) : null}
                    <MarketplacePagedGrid
                      type={g.type}
                      publicOnly={publicOnly}
                      scrollContainerRef={scrollContainerRef}
                      columns={MARKETPLACE_GRID_COLUMNS}
                      gridClassName="sm:grid-cols-3"
                      emptyTitle=""
                      emptyDescription=""
                    />
                  </section>
                ))}
              </div>
            ) : (
              <MarketplacePagedGrid
                source={source}
                type={typeParam}
                publicOnly={publicOnly}
                scrollContainerRef={scrollContainerRef}
                columns={MARKETPLACE_GRID_COLUMNS}
                gridClassName="sm:grid-cols-3"
                showSource={false}
                emptyTitle={tI18nComplete.raw('text49abaf804ab3')}
                emptyDescription={tI18nComplete.raw('text99f521dcb3fa')}
                emptyAction={
                  <Button variant="outline" size="sm" onClick={() => selectSource(ALL_SOURCES)}>
                    {tI18nComplete.raw('text09d2aacd2ac9')}
                  </Button>
                }
              />
            )}
          </div>
        ) : null}
      </div>
    </MarketplaceShell>
  );
}
