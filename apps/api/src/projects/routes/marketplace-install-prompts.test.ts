import { describe, expect, test } from 'bun:test';

import {
  buildAgentInstallPrompt,
  buildRegistryProjectInstallPrompt,
  buildTemplateInstallPrompt,
} from './marketplace-install-prompts';

function templateEntry(over: Record<string, unknown> = {}) {
  return {
    item: {
      name: 'customer-support',
      type: 'registry:template',
      title: 'Customer support on autopilot',
      description: 'Works the Plain support queue.',
      registryDependencies: ['support-agent'],
      envVars: { PLAIN_API_KEY: 'Plain key', STRIPE_SECRET_KEY: 'Stripe key' },
      inputs: [
        { key: 'cadence', label: 'How often to check', type: 'cron', default: '0 */15 * * * *', required: true },
      ],
      meta: {
        template: {
          agents: { 'support-agent': { secrets: ['PLAIN_API_KEY', 'STRIPE_SECRET_KEY'] } },
          triggers: [
            { slug: 'support-triage', type: 'cron', agent: 'support-agent', cron: '{{cadence}}', prompt: 'Check Plain.' },
          ],
          env_optional: ['PLAIN_API_KEY', 'STRIPE_SECRET_KEY'],
        },
      },
      ...over,
    },
  } as unknown as Parameters<typeof buildTemplateInstallPrompt>[0];
}

describe('buildTemplateInstallPrompt', () => {
  test('tells the agent to read the full declaration from one show --json call', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('Customer support on autopilot');
    expect(p).toContain('kortix marketplace show kortix-starter:customer-support --json');
    expect(p).toContain('.inputs');
    expect(p).toContain('.template');
    expect(p).toContain('do not search');
  });

  test('gives dependency parts as fully-qualified ids + the exact file-content endpoint', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    // namespaced from the template id, not a bare "support-agent"
    expect(p).toContain('kortix-starter:support-agent');
    expect(p).toContain('$KORTIX_API_URL/marketplace/items/<part-id>/file?path=<target>');
    expect(p).toContain('.kortix/opencode/agents/');
  });

  test('wires the trigger from the show output and ships it DISABLED', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('.template.triggers');
    expect(p).toContain('{{key}}');
    expect(p).toContain('enabled: false');
    expect(p).toContain('DISABLED');
  });

  test('walks the required secrets and holds the run behind a confirmation', () => {
    const p = buildTemplateInstallPrompt(templateEntry(), 'kortix-starter:customer-support');
    expect(p).toContain('PLAIN_API_KEY');
    expect(p).toContain('STRIPE_SECRET_KEY');
    expect(p).toContain('never ask me to paste a raw key');
    expect(p).toContain("don't run anything until I say go");
  });

  test('handles a template with no dependencies without erroring', () => {
    const p = buildTemplateInstallPrompt(templateEntry({ registryDependencies: [] }), 'kortix-starter:x');
    expect(p).toContain('kortix marketplace show kortix-starter:x');
    expect(p).not.toContain('Install its parts');
  });
});

describe('buildRegistryProjectInstallPrompt', () => {
  test('drives the post-CR handoff instead of leaving manual setup instructions', () => {
    const p = buildRegistryProjectInstallPrompt(
      {
        item: {
          name: 'seo-department',
          type: 'registry:project',
          title: 'SEO Department',
          description: 'A full SEO department.',
          registryDependencies: ['technical-seo-audit'],
          files: [
            {
              path: 'kortix.yaml',
              content: 'default_agent: seo-director\nagents:\n  seo-director:\n    skills: all\n',
            },
            { path: 'install.md', content: '# SEO Department Install Guide\n' },
          ],
        },
      } as never,
      'kortix_version: 2\n',
    );

    expect(p).toContain('read it from the supplied file block');
    expect(p).toContain('ask whether to apply/merge it now');
    expect(p).toContain('Do not merge without explicit approval');
    expect(p).toContain('kortix cr merge <number-or-id>');
    expect(p).toContain('structured session-start/background-session tool');
    expect(p).toContain('Open session button');
    expect(p).not.toContain('Once merged, start a session');
  });
});

describe('buildAgentInstallPrompt', () => {
  // Synthetic fixture: a neutral "triage" persona.
  const declared = {
    connectors: ['linear'],
    secrets: ['LINEAR_KEY'],
    skills: ['triage-rules'],
    kortix_permissions: [],
  };
  const input = (approved = declared, content: string | null = '---\nmode: primary\n---\nYou triage for {{projectName}}.\n') => ({
    id: 'acme:triage-agent',
    item: {
      name: 'triage-agent',
      title: 'Triage agent',
      description: 'Triages inbound issues.',
      files: [{ path: 'agents/triage.md', target: '@agents/triage.md', content }],
    },
    profile: { name: 'triage', file: '@agents/triage.md', governance: declared },
    approved,
  });

  test('writes the agent file to its conventional path with the inline content', () => {
    const p = buildAgentInstallPrompt(input());
    expect(p).toContain('Triage agent');
    expect(p).toContain('.kortix/opencode/agents/triage.md');
    expect(p).toContain('You triage for {{projectName}}.');
    expect(p).toContain("{{projectName}}` to this project's name");
    expect(p).toContain('do not overwrite');
  });

  test('pins the exact approved kortix.yaml grant and forbids anything wider', () => {
    const p = buildAgentInstallPrompt(input());
    expect(p).toContain('agents:\n  triage:\n    connectors:\n      - linear\n    secrets:\n      - LINEAR_KEY\n    skills:\n      - triage-rules\n');
    expect(p).toContain('Never use `all`');
    expect(p).not.toContain('declined');
  });

  test('lists every declined capability and tells the agent not to grant it', () => {
    const p = buildAgentInstallPrompt(
      input({ connectors: [], secrets: ['LINEAR_KEY'], skills: [], kortix_permissions: [] }),
    );
    expect(p).toContain('I declined');
    expect(p).toContain('connector `linear`');
    expect(p).toContain('skill `triage-rules`');
    expect(p).not.toContain('- linear');
    // A declined skill is not installed.
    expect(p).not.toContain('`acme:triage-rules`');
  });

  test('installs each approved skill from the same registry', () => {
    expect(buildAgentInstallPrompt(input())).toContain('`acme:triage-rules`');
  });

  test('asks for setup links for approved secrets and connectors, never raw keys', () => {
    const p = buildAgentInstallPrompt(input());
    expect(p).toContain('`request_secret` / `connect`');
    expect(p).toContain('LINEAR_KEY');
  });

  test('fetches the agent file from the catalog when it has no inline content', () => {
    const p = buildAgentInstallPrompt(input(declared, null));
    expect(p).toContain('/marketplace/items/acme%3Atriage-agent/file?path=%40agents%2Ftriage.md');
  });

  test('ends in a change request, not a direct push', () => {
    expect(buildAgentInstallPrompt(input())).toContain('Open a change request');
  });
});
