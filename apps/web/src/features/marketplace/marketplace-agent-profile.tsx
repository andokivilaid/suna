'use client';

import {
  KeyIcon,
  PlugIcon,
  ShieldCheckIcon,
  SparkleIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

import { UnifiedMarkdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { useTranslations } from '@/i18n/use-translations';
import type { MarketplaceAgentDetail } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import {
  agentGrantCopy,
  agentGrantKindLabel,
  agentGrantRows,
  frontmatterEntries,
  type AgentGrantKind,
} from './marketplace-agent';

const GRANT_ICON: Record<AgentGrantKind, { Icon: PhosphorIcon; tile: string }> = {
  connectors: { Icon: PlugIcon, tile: 'bg-kortix-blue/15 text-kortix-blue' },
  secrets: { Icon: KeyIcon, tile: 'bg-kortix-yellow/15 text-kortix-yellow' },
  skills: { Icon: SparkleIcon, tile: 'bg-muted text-muted-foreground' },
  kortix_permissions: { Icon: ShieldCheckIcon, tile: 'bg-muted text-muted-foreground' },
};

/** Square tinted tile for one grant kind — shared by the detail and the
 *  install review so a grant reads the same in both places. */
export function AgentGrantIcon({ kind }: { kind: AgentGrantKind }) {
  const { Icon, tile } = GRANT_ICON[kind];
  return (
    <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-sm', tile)}>
      <Icon className="size-3.5" />
    </span>
  );
}

function SectionLabel({ count, children }: { count?: number; children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-3 flex items-center gap-2 text-sm">
      <span>{children}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/50 tabular-nums">{count}</span>
      ) : null}
    </div>
  );
}

/**
 * The main column of an agent's detail: what it will be granted (plain
 * language), the exact kortix.yaml block the install adds, its OpenCode
 * behavior (frontmatter), and its prompt. All values are server-derived
 * (`GET /marketplace/items/:id` → `agent`).
 */
export function MarketplaceAgentProfile({ agent }: { agent: MarketplaceAgentDetail }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const grants = agentGrantRows(agent.governance);
  const behavior = frontmatterEntries(agent.frontmatter);

  return (
    <div className="space-y-8" data-testid="marketplace-agent-profile">
      <section>
        <SectionLabel count={grants.length}>{tI18nComplete.raw('text19609ea23c43')}</SectionLabel>
        {grants.length > 0 ? (
          <ul className="bg-popover divide-border divide-y rounded-md border">
            {grants.map((row) => (
              <li key={row.key} className="flex items-center gap-3 px-4 py-2.5">
                <AgentGrantIcon kind={row.kind} />
                <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                  {agentGrantCopy(row.kind, row.value, tI18nComplete)}
                </span>
                <Badge variant="outline" size="sm">
                  {agentGrantKindLabel(row.kind, tI18nComplete)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bg-popover text-muted-foreground rounded-md border px-4 py-3 text-xs">
            {tI18nComplete.raw('text55ee9aa25faf')}
          </p>
        )}
      </section>

      <section>
        <SectionLabel>{tI18nComplete.raw('text926c86e3d187')}</SectionLabel>
        <pre className="bg-secondary text-foreground overflow-x-auto rounded-md border px-4 py-3 font-mono text-xs leading-relaxed">
          <code>{agent.governanceYaml}</code>
        </pre>
      </section>

      {behavior.length > 0 ? (
        <section>
          <SectionLabel count={behavior.length}>{tI18nComplete.raw('textedf8d3f1781f')}</SectionLabel>
          <dl className="bg-popover divide-border divide-y rounded-md border">
            {behavior.map((entry) => (
              <div key={entry.key} className="flex items-baseline gap-3 px-4 py-2">
                <dt className="text-muted-foreground w-28 shrink-0 truncate font-mono text-xs">
                  {entry.key}
                </dt>
                <dd className="text-foreground min-w-0 flex-1 font-mono text-xs break-words">
                  {entry.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section>
        <SectionLabel>{tI18nComplete.raw('text5c39123805ff')}</SectionLabel>
        <div className="bg-secondary rounded-md border p-4">
          {agent.prompt ? (
            <div className="prose-sm text-foreground max-w-none">
              <UnifiedMarkdown content={agent.prompt} allowHtml={false} />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{tI18nComplete.raw('text961e15b7f263')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
