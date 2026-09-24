import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeConfig as Config } from '../harness/open-code/config'
import { createOpencodeLifecycle } from '../harness/open-code/lifecycle'

// A wedged opencode: the process is alive and its port stays bound, but no
// request gets an answer. SIGSTOP produces exactly that — the kernel still
// accepts connections into the listen backlog, nothing reads them. The
// lifecycle must SIGKILL the child, respawn it through the ordinary exit
// path, and run onUnplannedRespawn so the orphaned turn is finalized.

let root: string
let lifecycle: ReturnType<typeof createOpencodeLifecycle> | null
const stoppedPids: number[] = []

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('reserved') })
  const port = server.port
  server.stop(true)
  if (typeof port !== 'number') throw new Error('Bun did not assign a port')
  return port
}

function writeHealthyBinary(path: string) {
  writeFileSync(
    path,
    `#!/usr/bin/env bun
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1])
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/session') return Response.json([])
    return new Response('not found', { status: 404 })
  },
})
console.log('opencode server listening on http://127.0.0.1:' + port)
setInterval(() => {}, 60_000)
`,
  )
  chmodSync(path, 0o755)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-wedge-kill-'))
  lifecycle = null
})

afterEach(async () => {
  for (const pid of stoppedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await lifecycle?.stop()
  rmSync(root, { recursive: true, force: true })
})

function makeCfg(): Config {
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  return {
    workspace,
    projectTarget: workspace,
    opencodeInternalPort: reservePort(),
    opencodeStandbyPort: reservePort(),
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
  } as Config
}

function startLifecycle(wedgeKillEnabled: boolean, onRespawn: () => void) {
  const configDir = join(root, 'config')
  const binary = join(root, 'opencode')
  mkdirSync(configDir)
  writeHealthyBinary(binary)
  return createOpencodeLifecycle(makeCfg(), configDir, undefined, {
    binaryPathOverride: binary,
    configPathOverride: join(root, 'runtime-config.json'),
    readyLivenessMs: 200,
    wedgeKill: { enabled: wedgeKillEnabled, thresholdMs: 1_000, minFailures: 2, probeTimeoutMs: 500 },
    onUnplannedRespawn: onRespawn,
  })
}

describe('OpenCode wedge kill (real child process)', () => {
  test('a SIGSTOPped child is SIGKILLed, respawned, and its turn finalized', async () => {
    let respawnHookCalls = 0
    lifecycle = startLifecycle(true, () => {
      respawnHookCalls += 1
    })
    await lifecycle.start()
    await until(() => lifecycle!.getState() === 'ok', 10_000, 'first ready')
    const wedgedPid = lifecycle.getPid()!
    expect(wedgedPid).toBeGreaterThan(0)

    process.kill(wedgedPid, 'SIGSTOP')
    stoppedPids.push(wedgedPid)

    await until(() => !alive(wedgedPid), 20_000, 'wedged child killed')
    await until(() => respawnHookCalls === 1, 10_000, 'onUnplannedRespawn after respawn')

    // The hook fires once the replacement answers; the readiness loop flips
    // the state on its next tick.
    await until(() => lifecycle!.getState() === 'ok', 5_000, 'replacement ready')
    const replacementPid = lifecycle.getPid()
    expect(replacementPid).not.toBeNull()
    expect(replacementPid).not.toBe(wedgedPid)
    expect(alive(replacementPid!)).toBe(true)
    const stats = lifecycle.getWedgeKillStats!()
    expect(stats.kills).toBe(1)
    expect(stats.lastKillAt).not.toBeNull()
    expect(stats.enabled).toBe(true)
  }, 40_000)

  test('kill switch off: the SIGSTOPped child is gated off but left alive', async () => {
    let respawnHookCalls = 0
    lifecycle = startLifecycle(false, () => {
      respawnHookCalls += 1
    })
    await lifecycle.start()
    await until(() => lifecycle!.getState() === 'ok', 10_000, 'first ready')
    const wedgedPid = lifecycle.getPid()!

    process.kill(wedgedPid, 'SIGSTOP')
    stoppedPids.push(wedgedPid)

    // Long enough for the enabled case above to have killed it (~5-7 s).
    await new Promise((r) => setTimeout(r, 9_000))
    expect(alive(wedgedPid)).toBe(true)
    expect(lifecycle.getPid()).toBe(wedgedPid)
    expect(respawnHookCalls).toBe(0)
    const stats = lifecycle.getWedgeKillStats!()
    expect(stats.kills).toBe(0)
    expect(stats.enabled).toBe(false)
    expect(stats.unresponsiveMs).toBeGreaterThan(1_000)
  }, 40_000)
})
