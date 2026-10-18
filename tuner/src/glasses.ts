// Text layout for the glasses display.
//
// The firmware font is proportional, but the box-drawing and shape glyphs
// used here (─ ┼ █ ♭ ♯) are all exactly 20 px wide, so the scale is a fixed
// width no matter where the needle sits. Lines are centered with spaces
// (5 px each), measured with @evenrealities/pretext.

import { getTextWidth } from '@evenrealities/pretext'

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

/** Three lines: note name, needle scale, cents readout. */
export function tunerText(note: string | null, cents: number | null): string {
  if (note === null || cents === null) {
    return [center('–'), center(scale(null)), center('Play a note')].join('\n')
  }
  const inTune = Math.abs(cents) <= IN_TUNE_CENTS
  const label = inTune ? `[ ${note} ]` : note
  const readout = inTune ? 'in tune' : cents > 0 ? `+${cents}¢  sharp` : `${cents}¢  flat`
  return [center(label), center(scale(cents)), center(readout)].join('\n')
}

export function pausedText(): string {
  return [center('Paused'), center(scale(null)), center('Tap to resume')].join('\n')
}

/** Shown on the glasses when a run is finished. Three short lines. */
export function resultsText(avgCents: number, wrongNotes: number, points: number): string {
  return [
    center('Scale done!'),
    center(`avg ${avgCents}¢ off  ·  ${wrongNotes} wrong`),
    center(`+${points} pts  ·  tap to retry`),
  ].join('\n')
}
