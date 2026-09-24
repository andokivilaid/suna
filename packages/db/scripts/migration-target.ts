export function migrationCheckOrder(command: string, databaseUrl: string, previewMarker?: string): boolean {
  if (command !== 'local-up' && command !== 'preview-up') return true;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error(command === 'local-up'
      ? 'local-up requires a valid loopback DATABASE_URL'
      : 'preview-up requires a valid DATABASE_URL');
  }
  if (command === 'preview-up') {
    if (previewMarker !== '1' || hostname !== 'supabase-db') {
      throw new Error('preview-up requires the preview marker and supabase-db host');
    }
    return false;
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
    throw new Error(`local-up refuses non-loopback database host: ${hostname}`);
  }
  return false;
}

export function migrationBootstrapsPrerequisites(command: string): boolean {
  return command === 'bootstrap' || command === 'local-up' || command === 'preview-up';
}

const LOCAL_BOOTSTRAP_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', 'supabase-db']);

/**
 * `bootstrap` installs the non-kortix prerequisites (credit RPCs, a trigger on
 * auth.users, a basejump stub) into a fresh database. That is right for the
 * self-host compose stack (`supabase-db`) and a local database, and wrong for
 * anything else reached by accident. Refuse any other host unless the operator
 * passes `--allow-remote` (e.g. a deliberate fresh Supabase Cloud project).
 */
export function assertBootstrapTarget(command: string, databaseUrl: string, allowRemote: boolean): void {
  if (command !== 'bootstrap') return;
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('bootstrap requires a valid DATABASE_URL');
  }
  if (LOCAL_BOOTSTRAP_HOSTS.has(hostname) || allowRemote) return;
  throw new Error(`bootstrap refuses non-local database host: ${hostname} (pass --allow-remote to run it anyway)`);
}
