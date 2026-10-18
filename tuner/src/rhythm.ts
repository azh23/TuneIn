// Tempo-free rhythm grading.
//
// Rhythm is judged by note onsets: the time from one note's start to the
// next note's start (inter-onset interval) should match the written length
// in beats. We don't use a metronome — the tempo is inferred from the
// player's own onsets, so any steady tempo is fine; only the proportions
// between notes are graded. The last note has no next onset, so it isn't
// graded.

export interface RhythmNote {
  /** Written length in beats. */
  expected: number
  /** Length actually played, in beats at the inferred tempo. */
  played: number
}

export interface RhythmSummary {
  /** 0–100. */
  score: number
  /** Inferred tempo. */
  bpm: number
  /** One entry per graded note (all but the last). */
  notes: RhythmNote[]
  /** Index of the note furthest off, if it was noticeably off. */
  worst: number | null
}

/** Within this fraction of the written length = full credit… */
const FULL_CREDIT = 0.15
/** …falling to zero credit at this fraction off. */
const ZERO_CREDIT = 0.5

/**
 * Tempo = median ms-per-beat across the intervals between onsets. The median
 * ignores a single badly timed note, so that note shows up as the error
 * instead of dragging the whole tempo estimate toward it. Null if there
 * aren't at least 2 intervals.
 */
export function msPerBeat(onsetsMs: number[], beats: number[]): number | null {
  const n = Math.min(onsetsMs.length, beats.length) - 1
  if (n < 2) return null
  const perBeat = Array.from({ length: n }, (_, i) => (onsetsMs[i + 1] - onsetsMs[i]) / beats[i]).sort((x, y) => x - y)
  const mid = Math.floor(n / 2)
  const ms = n % 2 ? perBeat[mid] : (perBeat[mid - 1] + perBeat[mid]) / 2
  return ms > 0 ? ms : null
}

/**
 * `fixedMsPerBeat` (from the metronome) grades against the set tempo;
 * without it, the player's own median tempo is used. `bpm` in the result is
 * always the tempo actually played.
 */
export function gradeRhythm(onsetsMs: number[], beats: number[], fixedMsPerBeat?: number): RhythmSummary | null {
  const n = Math.min(onsetsMs.length, beats.length) - 1
  const playedTempo = msPerBeat(onsetsMs, beats)
  if (playedTempo === null) return null
  const tempo = fixedMsPerBeat ?? playedTempo
  const iois = Array.from({ length: n }, (_, i) => onsetsMs[i + 1] - onsetsMs[i])

  const notes = iois.map((ioi, i) => ({ expected: beats[i], played: ioi / tempo }))
  const errors = notes.map(r => Math.abs(r.played / r.expected - 1))
  const credit = (e: number) => Math.max(0, Math.min(1, (ZERO_CREDIT - e) / (ZERO_CREDIT - FULL_CREDIT)))
  const worstIdx = errors.reduce((w, e, i) => (e > errors[w] ? i : w), 0)

  return {
    score: Math.round((100 * errors.reduce((a, e) => a + credit(e), 0)) / n),
    bpm: Math.round(60000 / playedTempo),
    notes,
    worst: errors[worstIdx] > FULL_CREDIT ? worstIdx : null,
  }
}
