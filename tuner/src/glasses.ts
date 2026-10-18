// Text layout for the glasses display.
//
// The firmware font is proportional, but the box-drawing and shape glyphs
// used here (─ ┼ █ ♭ ♯) are all exactly 20 px wide, so the scale is a fixed
// width no matter where the needle sits. Lines are centered with spaces
// (5 px each), measured with @evenrealities/pretext.

import { getTextWidth } from '@evenrealities/pretext'
import type { Summary } from './scoring'

export const BOX_W = 576
export const BOX_PAD = 4
const INNER_W = BOX_W - 2 * BOX_PAD
const SPACE_W = getTextWidth(' ')

/** Slots on each side of center. Each slot is 50 / SLOTS cents. */
const SLOTS = 10
export const IN_TUNE_CENTS = 5

function center(line: string): string {
  const pad = Math.max(0, Math.round((INNER_W - getTextWidth(line)) / 2 / SPACE_W))
  return ' '.repeat(pad) + line
}

function scale(cents: number | null): string {
  const slots: string[] = []
  for (let i = -SLOTS; i <= SLOTS; i++) slots.push(i === 0 ? '┼' : '─')
  if (cents !== null) {
    const pos =
      Math.abs(cents) <= IN_TUNE_CENTS ? 0 : Math.max(-SLOTS, Math.min(SLOTS, Math.round((cents / 50) * SLOTS)))
    slots[pos + SLOTS] = '█'
  }
  return `♭ ${slots.join('')} ♯`
}

/** Three lines: note name, needle scale, cents readout. `idleHint` replaces
 *  the bottom line while nothing is playing. */
export function tunerText(note: string | null, cents: number | null, idleHint = 'Play a note'): string {
  if (note === null || cents === null) {
    return [center('–'), center(scale(null)), center(idleHint)].join('\n')
  }
  const inTune = Math.abs(cents) <= IN_TUNE_CENTS
  const label = inTune ? `[ ${note} ]` : note
  const readout = inTune ? 'in tune' : cents > 0 ? `+${cents}¢  sharp` : `${cents}¢  flat`
  return [center(label), center(scale(cents)), center(readout)].join('\n')
}

/** Count-in beat `n` of `beats`: the number, a row of beat dots, the tempo. */
export function countInText(n: number, beats: number, bpm: number): string {
  const dots = Array.from({ length: beats }, (_, i) => (i < n ? '●' : '○')).join('   ')
  return [center(String(n)), center(dots), center(`${bpm} bpm`)].join('\n')
}

/** Corner beat indicator: one dot per beat in the bar, current one filled. */
export const BEAT_BOX_W = 112
export function beatText(n: number | null, beats: number): string {
  if (n === null) return ' ' // a text container can't be empty
  return Array.from({ length: beats }, (_, i) => (i === n - 1 ? '●' : '○')).join(' ')
}

export function pausedText(): string {
  return [center('Paused'), center(scale(null)), center('Tap to resume')].join('\n')
}

/** "Getting your music ready" screen while the agent works. */
export function bufferText(seconds: number, maxSeconds: number): string {
  const dots = '.'.repeat(1 + (seconds % 3))
  return [center('Getting your music ready' + dots), center(scale(null)), center(`${Math.min(seconds, maxSeconds)} s`)].join('\n')
}

/** Shown on the glasses when a run is finished. Three short lines.
 *  `headline` and `footer` override the first and last line (pass/level info). */
export function resultsText(s: Summary, headline?: string, footer?: string): string {
  const rhythm = s.rhythm ? `rhythm ${s.rhythm.score}%  ·  ~${s.rhythm.bpm} bpm` : 'tap to retry'
  return [
    center(headline ?? `Done!  +${s.points} pts`),
    center(`avg ${s.avgCents}¢ off  ·  ${s.wrongNotes} wrong  ·  ${rhythm.split('  ·')[0]}`),
    center(footer ?? rhythm),
  ].join('\n')
}
