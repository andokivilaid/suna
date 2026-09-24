/**
 * Wedge kill: an opencode whose process is alive but whose HTTP server no
 * longer answers must be replaced, not only gated off.
 *
 * The liveness hysteresis (opencode-liveness-hysteresis.test.ts) downgrades
 * such a child to `starting` and proxy.ts 503s every request, but respawn ran
 * only on process exit, so the session stayed wedged until a manual refresh.
 * `nextWedgeAction` decides when the readiness loop SIGKILLs the child; the
 * exit handler then respawns it.
 */
import { describe, expect, test } from 'bun:test'
import {
  EMPTY_WEDGE_WATCH,
  nextWedgeAction,
  wedgeKillAfterMs,
  wedgeKillEnabled,
  type WedgeDecisionInput,
  type WedgeWatch,
} from '../harness/open-code/lifecycle'

const T0 = 1_000_000
const BASE = {
  lastKillAt: null,
  enabled: true,
  thresholdMs: 60_000,
  cooldownMs: 300_000,
  minFailures: 3,
  maxProbeGapMs: 30_000,
} satisfies Omit<WedgeDecisionInput, 'watch' | 'probeFailed' | 'livenessProbeFailed' | 'now'>

/** Feed a run of fully-unresponsive probes `stepMs` apart; return every decision. */
function run(times: number[], overrides: Partial<WedgeDecisionInput> = {}, watch: WedgeWatch = EMPTY_WEDGE_WATCH) {
  const out = []
  let w = watch
  for (const now of times) {
    const d = nextWedgeAction({ ...BASE, ...overrides, watch: w, probeFailed: true, livenessProbeFailed: true, now })
    w = d.watch
    out.push(d)
  }
  return out
}

/** Probe times every `stepMs` from T0 through T0 + totalMs inclusive. */
function every(stepMs: number, totalMs: number): number[] {
  const times = []
  for (let t = 0; t <= totalMs; t += stepMs) times.push(T0 + t)
  return times
}

describe('nextWedgeAction', () => {
  test('no kill before the threshold, even with many failures', () => {
    const decisions = run(every(4_000, 56_000))
    expect(decisions.every((d) => !d.kill)).toBe(true)
    expect(decisions.at(-1)).toMatchObject({ reason: 'below-threshold', unresponsiveMs: 56_000 })
    expect(decisions.at(-1)?.watch.failures).toBe(15)
  })

  test('kills at the threshold and resets the watch', () => {
    const decisions = run(every(4_000, 60_000))
    expect(decisions.slice(0, -1).every((d) => !d.kill)).toBe(true)
    expect(decisions.at(-1)).toEqual({
      kill: true,
      reason: 'wedged',
      unresponsiveMs: 60_000,
      watch: { unresponsiveSince: null, failures: 0, lastObservedAt: T0 + 60_000 },
    })
  })

  test('the threshold alone is not enough: minFailures must also be met', () => {
    // Two probes 60 s apart would pass the time test with only 2 failures,
    // but a 60 s gap is itself a clock jump; use a wide gap limit to isolate
    // the failure-count rule.
    const decisions = run([T0, T0 + 60_000], { maxProbeGapMs: 120_000 })
    expect(decisions.at(-1)).toMatchObject({ kill: false, reason: 'below-threshold', unresponsiveMs: 60_000 })
    const third = run([T0, T0 + 60_000, T0 + 61_000], { maxProbeGapMs: 120_000 })
    expect(third.at(-1)).toMatchObject({ kill: true, reason: 'wedged' })
  })

  test('respects the cooldown after a kill, then kills again once it passes', () => {
    const lastKillAt = T0 - 60_000 // 60 s ago; cooldown is 300 s
    const inCooldown = run(every(4_000, 60_000), { lastKillAt })
    expect(inCooldown.some((d) => d.kill)).toBe(false)
    expect(inCooldown.at(-1)).toMatchObject({ reason: 'cooldown', unresponsiveMs: 60_000 })

    // Still wedged when the cooldown ends (T0 + 240 s): the run was kept, so
    // the next probe kills at once.
    let w = inCooldown.at(-1)!.watch
    let killedAt: number | null = null
    for (let now = T0 + 64_000; now <= T0 + 260_000; now += 4_000) {
      const d = nextWedgeAction({ ...BASE, lastKillAt, watch: w, probeFailed: true, livenessProbeFailed: true, now })
      w = d.watch
      if (d.kill) {
        killedAt = now
        break
      }
    }
    expect(killedAt).toBe(T0 + 240_000)
  })

  test('any answer resets the run (recovery)', () => {
    const almost = run(every(4_000, 56_000))
    const recovered = nextWedgeAction({
      ...BASE,
      watch: almost.at(-1)!.watch,
      probeFailed: false,
      livenessProbeFailed: false,
      now: T0 + 58_000,
    })
    expect(recovered).toEqual({
      kill: false,
      reason: 'responsive',
      unresponsiveMs: 0,
      watch: { unresponsiveSince: null, failures: 0, lastObservedAt: T0 + 58_000 },
    })
    // A fresh run needs the full threshold again.
    const after = run(every(4_000, 56_000).map((t) => t + 60_000), {}, recovered.watch)
    expect(after.some((d) => d.kill)).toBe(false)
  })

  test('a slow /session with a live HTTP server is busy, not wedged', () => {
    let w: WedgeWatch = EMPTY_WEDGE_WATCH
    for (const now of every(4_000, 120_000)) {
      const d = nextWedgeAction({ ...BASE, watch: w, probeFailed: true, livenessProbeFailed: false, now })
      expect(d).toMatchObject({ kill: false, reason: 'responsive' })
      w = d.watch
    }
  })

  test('kill switch off: never kills, but still measures the run', () => {
    const decisions = run(every(4_000, 120_000), { enabled: false })
    expect(decisions.some((d) => d.kill)).toBe(false)
    expect(decisions.at(-1)).toMatchObject({ reason: 'disabled', unresponsiveMs: 120_000 })
  })

  test('a wall-clock jump (snapshot restore) restarts the run instead of killing', () => {
    const before = run([T0, T0 + 4_000])
    // The VM was frozen for an hour; the first probe after resume fails.
    const resumed = run([T0 + 3_600_000, T0 + 3_604_000, T0 + 3_608_000], {}, before.at(-1)!.watch)
    expect(resumed.some((d) => d.kill)).toBe(false)
    expect(resumed.at(-1)).toMatchObject({ reason: 'below-threshold', unresponsiveMs: 8_000 })
    expect(resumed.at(-1)?.watch.failures).toBe(3)
  })
})

describe('wedge kill env', () => {
  test('KORTIX_OPENCODE_WEDGE_KILL defaults on; 0/false disable it', () => {
    expect(wedgeKillEnabled({})).toBe(true)
    expect(wedgeKillEnabled({ KORTIX_OPENCODE_WEDGE_KILL: '1' })).toBe(true)
    expect(wedgeKillEnabled({ KORTIX_OPENCODE_WEDGE_KILL: 'true' })).toBe(true)
    expect(wedgeKillEnabled({ KORTIX_OPENCODE_WEDGE_KILL: '0' })).toBe(false)
    expect(wedgeKillEnabled({ KORTIX_OPENCODE_WEDGE_KILL: ' FALSE ' })).toBe(false)
  })

  test('KORTIX_OPENCODE_WEDGE_KILL_AFTER_MS overrides the 60 s threshold; junk falls back', () => {
    expect(wedgeKillAfterMs({})).toBe(60_000)
    expect(wedgeKillAfterMs({ KORTIX_OPENCODE_WEDGE_KILL_AFTER_MS: '120000' })).toBe(120_000)
    expect(wedgeKillAfterMs({ KORTIX_OPENCODE_WEDGE_KILL_AFTER_MS: 'abc' })).toBe(60_000)
    expect(wedgeKillAfterMs({ KORTIX_OPENCODE_WEDGE_KILL_AFTER_MS: '0' })).toBe(60_000)
    expect(wedgeKillAfterMs({ KORTIX_OPENCODE_WEDGE_KILL_AFTER_MS: '-5' })).toBe(60_000)
  })
})
