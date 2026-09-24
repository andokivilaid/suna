/**
 * Agent profile for a `registry:agent` marketplace item: the agent's
 * kortix.yaml name, its install target, and the governance grant it asks for.
 *
 * Pure module (no config/db imports) so the catalog and the install-session
 * route share one derivation, and both are unit-testable.
 *
 * Where the grant comes from, in order:
 *   1. `meta.agent` on the agent item (author-declared governance), merged with
 *      `meta.capabilities` + `envVars` (the generic capability manifest).
 *   2. The sibling `registry:template` that installs this agent
 *      (`meta.template.agents.<name>`) — how the bundled use-case personas
 *      declare their grants today.
 *   3. Nothing → an empty grant. kortix.yaml v2 is deny-by-default.
 *
 * A marketplace item never receives an `all` wildcard: consent is per named
 * connector, secret, skill, and permission (MARKETPLACE.md §5.1).
 */

import type { RegistryItem } from "@kortix/registry";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const AGENT_GRANT_KINDS = [
  "connectors",
  "secrets",
  "skills",
  "kortix_permissions",
] as const;

export type AgentGrantKind = (typeof AGENT_GRANT_KINDS)[number];

export type AgentGovernance = Record<AgentGrantKind, string[]>;

export interface AgentProfile {
  /** The `agents:` key in kortix.yaml and the `.md` filename. */
  name: string;
  /** Install target of the agent file (`@agents/<name>.md`), when declared. */
  file: string | null;
  governance: AgentGovernance;
  governanceSource: "declared" | "template" | "none";
  /** The sibling template the grant was read from (`governanceSource: "template"`). */
  templateName?: string;
}

export function emptyGovernance(): AgentGovernance {
  return { connectors: [], secrets: [], skills: [], kortix_permissions: [] };
}

/** Unique non-empty strings; anything else (including the `all` wildcard) is dropped. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && s !== "all" && !out.includes(s)) out.push(s);
  }
  return out;
}

function governanceFrom(raw: unknown): AgentGovernance {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const g = emptyGovernance();
  for (const kind of AGENT_GRANT_KINDS) g[kind] = stringList(obj[kind]);
  return g;
}

function mergeGovernance(a: AgentGovernance, b: AgentGovernance): AgentGovernance {
  const g = emptyGovernance();
  for (const kind of AGENT_GRANT_KINDS) g[kind] = [...new Set([...a[kind], ...b[kind]])];
  return g;
}

function hasAnyGrant(g: AgentGovernance): boolean {
  return AGENT_GRANT_KINDS.some((kind) => g[kind].length > 0);
}

function agentFileOf(item: RegistryItem): string | null {
  const file = (item.files ?? []).find((f) =>
    /(?:^|\/)[^/]+\.md$/i.test(f.target ?? f.path),
  );
  return file ? (file.target ?? file.path) : null;
}

/** The agent's kortix.yaml name: the agent file's basename (`@agents/x.md` → `x`). */
export function agentNameOf(item: RegistryItem): string {
  const file = agentFileOf(item);
  const base = file?.split("/").pop()?.replace(/\.md$/i, "");
  return base || item.name;
}

export function deriveAgentProfile(
  item: RegistryItem,
  siblings: readonly RegistryItem[],
): AgentProfile {
  const name = agentNameOf(item);
  const file = agentFileOf(item);
  const meta = (item.meta ?? {}) as Record<string, unknown>;
  const caps = (meta.capabilities ?? {}) as Record<string, unknown>;

  const declared = mergeGovernance(
    governanceFrom(meta.agent),
    governanceFrom({
      connectors: caps.connectors,
      secrets: [...Object.keys(item.envVars ?? {}), ...stringList(caps.secrets)],
    }),
  );
  if (hasAnyGrant(declared)) {
    return { name, file, governance: declared, governanceSource: "declared" };
  }

  for (const sib of siblings) {
    if (sib.type !== "registry:template") continue;
    if (!(sib.registryDependencies ?? []).includes(item.name)) continue;
    const agents = ((sib.meta?.template ?? {}) as { agents?: Record<string, unknown> }).agents;
    const grant = agents?.[name];
    if (!grant) continue;
    return {
      name,
      file,
      governance: governanceFrom(grant),
      governanceSource: "template",
      templateName: sib.name,
    };
  }

  return { name, file, governance: emptyGovernance(), governanceSource: "none" };
}

/** The exact `agents:` block the install adds to kortix.yaml. Empty grants are
 *  omitted — omission means "none" under v2's deny-by-default. */
export function governanceYaml(name: string, governance: AgentGovernance): string {
  const entry: Record<string, string[]> = {};
  for (const kind of AGENT_GRANT_KINDS) {
    if (governance[kind].length) entry[kind] = governance[kind];
  }
  return stringifyYaml({ agents: { [name]: entry } });
}

/** Split an OpenCode agent file into its YAML frontmatter and its prompt body. */
export function splitAgentMarkdown(raw: string): {
  frontmatter: Record<string, unknown>;
  prompt: string;
} {
  if (!raw.startsWith("---")) return { frontmatter: {}, prompt: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, prompt: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(raw.slice(3, end));
    if (parsed && typeof parsed === "object") frontmatter = parsed as Record<string, unknown>;
  } catch {
    frontmatter = {};
  }
  const nl = raw.indexOf("\n", end + 1);
  const prompt = nl === -1 ? "" : raw.slice(nl + 1).replace(/^\s*\n/, "");
  return { frontmatter, prompt };
}

export type GrantValidation =
  | { ok: true; grants: AgentGovernance }
  | { ok: false; error: string };

/**
 * Validate the capability set a user approved in the install dialog against
 * what the agent declares. `undefined` approves the full declared set (callers
 * that predate the review dialog, e.g. the CLI). Any grant outside the declared
 * set is rejected: approval can only narrow, never widen.
 */
export function validateAgentGrants(
  requested: unknown,
  declared: AgentGovernance,
): GrantValidation {
  if (requested === undefined || requested === null) {
    return { ok: true, grants: declared };
  }
  if (typeof requested !== "object" || Array.isArray(requested)) {
    return { ok: false, error: "grants must be an object" };
  }
  const grants = emptyGovernance();
  for (const [kind, value] of Object.entries(requested as Record<string, unknown>)) {
    if (!(AGENT_GRANT_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, error: `grants.${kind} is not a supported grant kind` };
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: `grants.${kind} must be an array of strings` };
    }
    const k = kind as AgentGrantKind;
    for (const v of value as string[]) {
      if (!declared[k].includes(v)) {
        return {
          ok: false,
          error: `grants.${kind} contains "${v}", which this agent does not declare`,
        };
      }
      if (!grants[k].includes(v)) grants[k].push(v);
    }
  }
  return { ok: true, grants };
}
