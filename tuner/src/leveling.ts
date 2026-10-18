// The level ladder rules (same thresholds as the Practice Coach agent prompt).

import { MAX_LEVEL } from './generator'

export const PASS_AT = 0.6 // a run must reach this to unlock the next exercise
export const MAX_TRIES = 3 // after this many misses on one exercise, drop a level so you're never stuck
export const UP_AT = 0.85 // two runs at or above this percentage move you up
export const DOWN_BELOW = 0.5 // two runs below this move you down
export const RUNS_NEEDED = 1 // runs at UP_AT or better needed to move up
export const RUNS_NEEDED_DOWN = 2 // runs below DOWN_BELOW needed to move down

export interface LevelState {
  level: number
  upStreak: number
  downStreak: number
}
export const initialLevel = (): LevelState => ({ level: 1, upStreak: 0, downStreak: 0 })

/** A run's score as a 0-1 share of the most it could earn: 10 pitch + 5 rhythm points per note, plus the 20 perfect bonus. */
export function scorePercent(points: number, noteCount: number): number {
  return noteCount > 0 ? Math.min(1, points / (15 * noteCount + 20)) : 0
}

export type Change = 'up' | 'same' | 'down'

export function applyRun(state: LevelState, pct: number): { state: LevelState; change: Change } {
  let { level, upStreak, downStreak } = state
  if (pct >= UP_AT) { upStreak++; downStreak = 0 }
  else if (pct < DOWN_BELOW) { downStreak++; upStreak = 0 }
  else { upStreak = 0; downStreak = 0 }

  let change: Change = 'same'
  if (upStreak >= RUNS_NEEDED && level < MAX_LEVEL) { level++; change = 'up'; upStreak = 0; downStreak = 0 }
  else if (downStreak >= RUNS_NEEDED_DOWN && level > 1) { level--; change = 'down'; upStreak = 0; downStreak = 0 }
  else if (level === MAX_LEVEL) upStreak = Math.min(upStreak, RUNS_NEEDED)
  return { state: { level, upStreak, downStreak }, change }
}

/** A short coaching line (40 characters max) from one run's per-note results. */
export function coachTip(results: { centsError: number; wrongNotes: number }[]): string {
  if (!results.length) return ''
  const avg = results.reduce((a, r) => a + r.centsError, 0) / results.length
  const wrong = results.reduce((a, r) => a + r.wrongNotes, 0)
  if (wrong >= 3) return 'Slow down and check each note.'
  if (avg <= -8) return 'Running flat. Aim a touch higher.'
  if (avg >= 8) return 'Running sharp. Ease the pitch down.'
  if (results.every(r => Math.abs(r.centsError) <= 10)) return 'Nice and steady. Keep it up!'
  return 'Hold each note a bit longer.'
}
