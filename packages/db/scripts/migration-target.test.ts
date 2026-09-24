import { describe, expect, test } from 'bun:test';
import { assertBootstrapTarget, migrationCheckOrder, migrationBootstrapsPrerequisites } from './migration-target';

describe('migration target mode', () => {
  test('keeps migration ordering strict for normal commands', () => {
    expect(migrationCheckOrder('up', 'postgresql://user:pass@db.example.com/app')).toBe(true);
    expect(migrationCheckOrder('status', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(true);
  });

  test('allows out-of-order migrations only for a loopback local-up target', () => {
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@127.0.0.1:5432/app')).toBe(false);
    expect(migrationCheckOrder('local-up', 'postgresql://user:pass@localhost:5432/app')).toBe(false);
  });

  test('rejects local-up for remote and invalid database URLs', () => {
    expect(() => migrationCheckOrder('local-up', 'postgresql://user:pass@db.example.com/app')).toThrow(
      'local-up refuses non-loopback database host: db.example.com',
    );
    expect(() => migrationCheckOrder('local-up', 'not-a-url')).toThrow(
      'local-up requires a valid loopback DATABASE_URL',
    );
  });

  test('allows preview-up only inside the preview database network', () => {
    expect(migrationCheckOrder('preview-up', 'postgresql://user:pass@supabase-db:5432/app', '1')).toBe(false);
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@supabase-db:5432/app')).toThrow();
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@db.example.com/app', '1')).toThrow();
    expect(() => migrationCheckOrder('preview-up', 'postgresql://user:pass@127.0.0.1:5432/app', '1')).toThrow();
  });

  test('bootstraps platform prerequisites for fresh local and self-host databases', () => {
    expect(migrationBootstrapsPrerequisites('local-up')).toBe(true);
    expect(migrationBootstrapsPrerequisites('preview-up')).toBe(true);
    expect(migrationBootstrapsPrerequisites('bootstrap')).toBe(true);
    expect(migrationBootstrapsPrerequisites('up')).toBe(false);
    expect(migrationBootstrapsPrerequisites('status')).toBe(false);
  });

  test('allows bootstrap on loopback and the self-host supabase-db host', () => {
    for (const url of [
      'postgresql://user:pass@127.0.0.1:5432/app',
      'postgresql://user:pass@localhost:5432/app',
      'postgresql://user:pass@[::1]:5432/app',
      'postgresql://postgres:pass@supabase-db:5432/postgres',
    ]) {
      expect(() => assertBootstrapTarget('bootstrap', url, false)).not.toThrow();
    }
  });

  test('refuses bootstrap against a remote database without --allow-remote', () => {
    expect(() => assertBootstrapTarget('bootstrap', 'postgresql://user:pass@db.example.com:5432/app', false)).toThrow(
      'bootstrap refuses non-local database host: db.example.com (pass --allow-remote to run it anyway)',
    );
    expect(() => assertBootstrapTarget('bootstrap', 'not-a-url', false)).toThrow(
      'bootstrap requires a valid DATABASE_URL',
    );
  });

  test('--allow-remote permits bootstrap against a remote database', () => {
    expect(() => assertBootstrapTarget('bootstrap', 'postgresql://user:pass@db.example.com:5432/app', true)).not.toThrow();
  });

  test('the bootstrap guard ignores every other command', () => {
    for (const cmd of ['up', 'status', 'down', 'fake']) {
      expect(() => assertBootstrapTarget(cmd, 'postgresql://user:pass@db.example.com:5432/app', false)).not.toThrow();
    }
  });
});
