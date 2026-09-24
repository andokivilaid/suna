/**
 * Pure prompt builder for the agent-driven marketplace install-session. Kept in
 * its own leaf module (no config/db imports) so the template semantics can be
 * unit-tested without booting the API's env graph.
 */

import {
  AGENT_GRANT_KINDS,
  governanceYaml,
  type AgentGovernance,
  type AgentGrantKind,
} from '../../marketplace/agent-profile';

interface TemplateInputDecl {
  key: string;
  label?: string;
  type?: string;
  default?: string;
  help?: string;
  required?: boolean;
}

interface TemplateCatalogEntry {
  item: {
    name: string;
    title?: string;
    description?: string | null;
    registryDependencies?: string[];
    inputs?: TemplateInputDecl[];
    envVars?: Record<string, string>;
    meta?: {
      template?: {
        agents?: Record<string, { secrets?: string[]; connectors?: string[]; skills?: string[] }>;
        connectors?: Array<{ slug: string; app?: string }>;
        channels?: string[];
        triggers?: Array<Record<string, unknown>>;
        env_optional?: string[];
      };
    };
  };
}

interface ProjectCatalogEntry {
  item: {
    name: string;
    title?: string;
    description?: string | null;
    registryDependencies?: string[];
    files?: Array<{ path: string; content?: string | null }>;
  };
}

/** Build the initial prompt for an agent-driven merge of a `registry:project`
 *  item into an EXISTING project. This is judgment-heavy (does the incoming
 *  agent persona collide with one that already exists? does the target project
 *  even want a new default agent?) — so an agent reads both sides and opens
 *  a change request rather than a blind file overwrite. */
export function buildRegistryProjectInstallPrompt(
  entry: ProjectCatalogEntry,
  targetManifestRaw: string | null,
): string {
  const item = entry.item;
  const ownFiles = (item.files ?? []).filter((f) => typeof f.content === 'string');
  // Today every registry:project item is a base (inline-content) item, so
  // `files[].content` is always populated here. If an EXTERNAL project item
  // ever lands in the catalog, its file content is fetched lazily and isn't
  // present on `item.files` — silently falling through would produce a prompt
  // with none of the template's actual files, i.e. a no-op merge. Fail loudly
  // instead of degrading silently (a full fix would resolve content per file).
  if ((item.files ?? []).length > 0 && ownFiles.length === 0) {
    throw new Error(
      `Project template "${item.name}" has no resolvable file content (likely an external registry item) — install-session merge only supports base project items today.`,
    );
  }
  const deps = item.registryDependencies ?? [];

  const lines: string[] = [
    `Integrate the "${item.title ?? item.name}" project template into THIS project — without breaking anything already here.`,
    '',
    item.description ?? '',
    '',
    "This project's current kortix.yaml:",
    '```yaml',
    targetManifestRaw ?? '(no manifest found)',
    '```',
    '',
    'The template contributes these files. Its own kortix.yaml is a reference for what agent it expects to exist — do NOT overwrite this project\'s kortix.yaml with it verbatim.',
  ];
  for (const file of ownFiles) {
    lines.push('', `--- ${file.path} ---`, '```', file.content ?? '', '```');
  }
  if (deps.length > 0) {
    lines.push(
      '',
      "It also depends on these marketplace skills — install each one (they're additive, they won't conflict with anything already installed):",
      ...deps.map((d) => `- ${d}`),
    );
  }
  lines.push(
    '',
    'Steps:',
    "1. Read this project's current kortix.yaml and .kortix/opencode/agents/ to see what already exists.",
    '2. Add the template\'s agent persona as a new agent file — rename it if the name collides with an existing agent. Do not remove or overwrite any existing agent.',
    "3. Merge the template's kortix.yaml `agents:` entry for that agent into this project's kortix.yaml. Leave default_agent and every other existing agent untouched unless the user asks otherwise.",
    '4. Install the marketplace skills listed above.',
    '5. If the template includes `install.md`, read it from the supplied file block before you finish. Use it as the template-specific setup guide and tell the user what company inputs, connectors, secrets, webhooks, or trigger decisions it will need after the files land.',
    '6. Open a change request with the result — do not push directly to the default branch.',
    '',
    'After the change request is open, keep driving the install instead of leaving the user with manual handoff work:',
    '',
    '- Show the CR number/status and ask whether to apply/merge it now. Do not merge without explicit approval.',
    '- If the user approves and your Kortix grant allows it, merge it yourself with `kortix cr merge <number-or-id>`.',
    '- After a successful merge, start the first setup session with the template\'s intended agent (infer it from the template `kortix.yaml`, usually `default_agent` or the newly added agent). Prefer a structured session-start/background-session tool when available so the UI can render an Open session control; otherwise use `kortix sessions new --agent <agent> --prompt "<setup prompt>" --json`.',
    '- Give the user a direct session link or tell them to use the Open session button for the session that just started.',
    '- If you do not have permission to merge or start sessions, say exactly which button/action is needed in the UI: Apply the CR, then open the setup session with the newly installed agent. Do not merely say "start a new session" without a link or button.',
  );
  return lines.join('\n');
}

/** A use-case template: its `registryDependencies` (an agent + a skill) plus a
 *  `meta.template` block (agent grants, connectors, a scheduled trigger whose
 *  string fields carry `{{input}}` placeholders) and declared `inputs`. Installed
 *  conversationally through the existing marketplace: the agent reads the template
 *  and its parts with the `kortix marketplace` CLI, collects the inputs, installs
 *  the parts, wires the schedule + grants + secrets, and ships the trigger DISABLED
 *  until the user says go. This prompt supplies the template semantics (inputs,
 *  trigger wiring, the exact ids to install) that a plain item install ignores —
 *  it does NOT re-implement fetching; the agent uses its CLI for that. */
export function buildTemplateInstallPrompt(entry: TemplateCatalogEntry, id: string): string {
  const item = entry.item;
  const tpl = item.meta?.template ?? {};
  // Dependencies are named within the same registry as the template, so give the
  // agent their fully-qualified ids to install — no searching/guessing.
  const namespace = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
  const depIds = (item.registryDependencies ?? []).map((d) => (namespace ? `${namespace}:${d}` : d));
  const secrets = Object.keys(item.envVars ?? {});
  const connectors = (tpl.connectors ?? []).map((c) => c.app ?? c.slug);
  const channels = tpl.channels ?? [];

  const steps: string[] = [
    `Read the template first: \`kortix marketplace show ${id} --json\`. The response carries the full declaration — \`.inputs\` (what to ask me), \`.envVars\` (required secrets), and \`.template\` (the trigger to wire, agent grants, connectors, channels). Everything you need is in that one response; do not search the repo or the web for it. Then tell me in a line or two what it adds and what you'll need from me.`,
    'Ask me for each input the template declares, pre-filling its default.',
  ];
  if (depIds.length) {
    steps.push(
      `Install its parts — ${depIds.map((d) => `\`${d}\``).join(', ')} — from the marketplace: \`kortix marketplace show <part-id> --json\` lists its \`.files[].target\`, and each file's content comes from \`GET $KORTIX_API_URL/marketplace/items/<part-id>/file?path=<target>\` (the \`.content\` field). Write each file to its conventional path (\`@agents/x.md\` → \`.kortix/opencode/agents/x.md\`, \`@skills/y\` → \`.kortix/opencode/skills/y\`), rendering \`{{projectName}}\` to this project's name.`,
    );
  }
  steps.push(
    "Wire the template's trigger (`.template.triggers` from the show output) into this project's `kortix.yaml`, rendering my input values into it (replace every `{{key}}` with what I gave you), and ship it **DISABLED** (`enabled: false`). Add the matching agent grant (`.template.agents`) under `agents:`.",
  );
  const needs = [
    secrets.length ? `secrets ${secrets.join(', ')} (Settings → Secrets)` : null,
    connectors.length ? `connectors ${connectors.join(', ')} (Settings → Connectors)` : null,
    channels.length ? `a ${channels.join('/')} channel (Settings → Channels)` : null,
  ].filter(Boolean);
  if (needs.length) {
    steps.push(
      `Walk me through connecting what it needs — ${needs.join('; ')}. Mint setup links with the \`request_secret\` / \`connect\` tools — never ask me to paste a raw key into the chat.`,
    );
  }
  steps.push(
    'Only after I confirm and the required accounts are connected, enable the trigger (`enabled: true`) and commit. Never enable it while a required secret or connector is still missing.',
    "Confirm it's live and tell me when it first runs.",
  );

  return [
    `Install the "${item.title ?? item.name}" automation into THIS project — as a short guided conversation, not a form.`,
    '',
    item.description ?? '',
    '',
    `This is a use-case template (marketplace id "${id}"). Set it up like this — and don't run anything until I say go:`,
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}

interface AgentInstallInput {
  /** Catalog id of the agent item (`<registry>:<name>`). */
  id: string;
  item: {
    name: string;
    title?: string;
    description?: string | null;
    files?: Array<{ path: string; target?: string; content?: string | null }>;
  };
  profile: { name: string; file: string | null; governance: AgentGovernance };
  /** The grant the user approved in the capability review (a subset of
   *  `profile.governance`, validated by the route). */
  approved: AgentGovernance;
}

const GRANT_NOUN: Record<AgentGrantKind, string> = {
  connectors: 'connector',
  secrets: 'secret',
  skills: 'skill',
  kortix_permissions: 'Kortix permission',
};

/** Agent-driven install of a `registry:agent` into THIS project, bound to the
 *  capability set the user approved: the session writes the agent file, adds
 *  EXACTLY the approved kortix.yaml grant (never wider, never `all`), installs
 *  the approved skills, mints setup links for approved secrets/connectors, and
 *  opens a change request. */
export function buildAgentInstallPrompt(input: AgentInstallInput): string {
  const { id, item, profile, approved } = input;
  const title = item.title ?? item.name;
  const namespace = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
  const repoPath = `.kortix/opencode/agents/${profile.name}.md`;
  const file = (item.files ?? []).find((f) => (f.target ?? f.path) === profile.file);
  const inline = typeof file?.content === 'string' ? file.content : null;

  const declined: string[] = [];
  for (const kind of AGENT_GRANT_KINDS) {
    for (const value of profile.governance[kind]) {
      if (!approved[kind].includes(value)) declined.push(`${GRANT_NOUN[kind]} \`${value}\``);
    }
  }

  const lines: string[] = [
    `Add the "${title}" agent to THIS project, with exactly the capabilities I approved.`,
    '',
    item.description ?? '',
    '',
  ];

  if (inline != null) {
    lines.push(
      `The agent file (marketplace item "${id}"). Write it to \`${repoPath}\`, rendering \`{{projectName}}\` to this project's name:`,
      '',
      '```markdown',
      inline,
      '```',
    );
  } else {
    const fileTarget = profile.file ?? `@agents/${profile.name}.md`;
    lines.push(
      `Fetch the agent file (marketplace item "${id}") from \`GET $KORTIX_API_URL/marketplace/items/${encodeURIComponent(id)}/file?path=${encodeURIComponent(fileTarget)}\` (the \`.content\` field). Write it to \`${repoPath}\`, rendering \`{{projectName}}\` to this project's name.`,
    );
  }

  lines.push(
    '',
    `Add exactly this entry under \`agents:\` in this project's kortix.yaml:`,
    '',
    '```yaml',
    governanceYaml(profile.name, approved).trimEnd(),
    '```',
    '',
    'Grants are deny-by-default: a kind that is not listed means none. Do not add any connector, secret, skill, or permission that is not listed above. Never use `all`.',
  );

  if (declined.length) {
    lines.push(
      '',
      `I declined: ${declined.join(', ')}. Do not grant them. Tell me in one line what the agent cannot do without them.`,
    );
  }

  const steps: string[] = [
    `Read this project's kortix.yaml and \`.kortix/opencode/agents/\`. If an agent named \`${profile.name}\` already exists, stop and ask me what to do — do not overwrite it or merge into its grant.`,
    `Write the agent file and add the kortix.yaml entry above. Leave \`default_agent\` and every other agent untouched.`,
  ];
  if (approved.skills.length) {
    const skillIds = approved.skills.map((s) => `\`${namespace ? `${namespace}:${s}` : s}\``);
    steps.push(
      `Install each approved skill that is not already in \`.kortix/opencode/skills/\`: ${skillIds.join(', ')}. \`kortix marketplace show <id> --json\` lists its \`.files[].target\`; write each file to its conventional path (\`@skills/y\` → \`.kortix/opencode/skills/y\`).`,
    );
  }
  const needs = [
    ...approved.secrets.map((s) => `secret ${s}`),
    ...approved.connectors.map((c) => `connector ${c}`),
  ];
  if (needs.length) {
    steps.push(
      `Walk me through connecting ${needs.join(', ')}. Mint setup links with the \`request_secret\` / \`connect\` tools (or \`kortix secrets request\` / \`kortix connectors link\`) — never ask me to paste a raw key.`,
    );
  }
  steps.push(
    'Open a change request with the result — do not push directly to the default branch.',
    'Tell me in one line what the agent does and how to start a session with it.',
  );

  lines.push('', 'Steps:', ...steps.map((step, i) => `${i + 1}. ${step}`));
  return lines.join('\n');
}
