// Scoring for a practice run: records how well each note was played, turns
// that into points, and keeps a running progress record (points, streak).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { StaffNote } from './staff'

/** Consecutive good readings needed before a note counts as played. */
export const HITS_NEEDED = 3
/** A reading only counts if it is within this many cents of the expected note. */
export const MATCH_CENTS = 30
/** After a note is completed, ignore other readings briefly while the player moves on. */
const GRACE_MS = 250
/** Silence this long means the player let go of the note (so the same note can be played again). */
const RELEASE_MS = 250

export interface NoteResult {
  midi: number
  /** Median error in cents (negative = flat, positive = sharp). */
  centsError: number
  /** Milliseconds since the previous note (kept for beat scoring later). */
  gapMs: number
  /** Wrong notes heard while trying to play this one. */
  wrongNotes: number
}

export interface Summary {
  total: number
  avgCents: number // average absolute error
  wrongNotes: number
  points: number
  perfect: boolean
  durationMs: number
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function notePoints(absCents: number, wrongNotes: number): number {
  const base = absCents <= 10 ? 10 : absCents <= 20 ? 8 : 6
  return Math.max(0, base - 3 * wrongNotes)
}

export class Session {
  step = 0
  results: NoteResult[] = []
  private good: number[] = [] // consecutive in-tolerance readings for the current note
  private wrongRun = 0 // consecutive readings of some other note
  private wrongNow = 0 // wrong notes heard for the current note
  private startedAt: number | null = null
  private lastAt: number | null = null
  private endedAt: number | null = null
  private heldMidi: number | null = null // note just completed and probably still ringing
  private silentSince: number | null = null

  constructor(
    readonly exercise: StaffNote[],
    /** Match pitch class only, so playing/singing an octave off still counts. */
    private readonly ignoreOctave = false,
  ) {}

  get done(): boolean {
    return this.step >= this.exercise.length
  }

  /** True once anything has been played, so a restart would lose progress. */
  get started(): boolean {
    return this.startedAt !== null
  }

  private same(a: number, b: number): boolean {
    return this.ignoreOctave ? (((a - b) % 12) + 12) % 12 === 0 : a === b
  }

  /** Call on every reading where no clear pitch was heard. */
  silence(now: number) {
    if (this.silentSince === null) this.silentSince = now
    else if (now - this.silentSince >= RELEASE_MS) this.heldMidi = null
  }

  /** Feed one pitch reading. Returns true when the current note was just completed. */
  feed(midi: number, cents: number, now: number): boolean {
    if (this.done) return false
    this.silentSince = null

    // The note we just finished is usually still ringing: it is neither right nor wrong.
    if (this.heldMidi !== null) {
      if (this.same(midi, this.heldMidi)) return false
      this.heldMidi = null
    }
    // Brief settling time right after a completed note.
    const target = this.exercise[this.step].midi
    if (this.lastAt !== null && now - this.lastAt < GRACE_MS && !this.same(midi, target)) return false

    if (this.startedAt === null) this.startedAt = now

    if (this.same(midi, target)) {
      this.wrongRun = 0
      if (Math.abs(cents) <= MATCH_CENTS) this.good.push(cents)
      else this.good = [] // right note but too far out: start the streak again
    } else {
      this.good = []
      this.wrongRun++
      // Count a wrong note once it lasts two readings, so one noisy frame is ignored.
      if (this.wrongRun === 2) this.wrongNow++
      return false
    }

    if (this.good.length < HITS_NEEDED) return false

    this.results.push({
      midi: target,
      centsError: Math.round(median(this.good)),
      gapMs: this.lastAt === null ? 0 : Math.round(now - this.lastAt),
      wrongNotes: this.wrongNow,
    })
    this.lastAt = now
    this.heldMidi = midi
    this.good = []
    this.wrongNow = 0
    this.step++
    if (this.done) this.endedAt = now
    return true
  }

  summary(): Summary {
    const total = this.results.length
    const avgCents = total ? Math.round(this.results.reduce((a, r) => a + Math.abs(r.centsError), 0) / total) : 0
    const wrongNotes = this.results.reduce((a, r) => a + r.wrongNotes, 0)
    let points = this.results.reduce((a, r) => a + notePoints(Math.abs(r.centsError), r.wrongNotes), 0)
    const perfect = total === this.exercise.length && wrongNotes === 0 && avgCents <= 15
    if (perfect) points += 20
    const durationMs = this.startedAt !== null && this.endedAt !== null ? Math.round(this.endedAt - this.startedAt) : 0
    return { total, avgCents, wrongNotes, points, perfect, durationMs }
  }
}

// ── Progress that survives restarts ───────────────────────────────────────

export interface Progress {
  points: number
  sessions: number
  streak: number // consecutive days with at least one finished run
  lastDay: string | null // YYYY-MM-DD of the last finished run
  lastPoints: number | null
  bestAvgCents: number | null
}

const STORAGE_KEY = 'tunein.progress.v1'

export const emptyProgress = (): Progress => ({
  points: 0,
  sessions: 0,
  streak: 0,
  lastDay: null,
  lastPoints: null,
  bestAvgCents: null,
})

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function applySession(p: Progress, s: Summary, today = new Date()): Progress {
  const day = dayKey(today)
  const yesterday = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))
  let streak = p.streak
  if (p.lastDay !== day) streak = p.lastDay === yesterday ? p.streak + 1 : 1
  return {
    points: p.points + s.points,
    sessions: p.sessions + 1,
    streak,
    lastDay: day,
    lastPoints: s.points,
    bestAvgCents: p.bestAvgCents === null ? s.avgCents : Math.min(p.bestAvgCents, s.avgCents),
  }
}

export async function loadProgress(bridge: EvenAppBridge): Promise<Progress> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (!raw) return emptyProgress()
    return { ...emptyProgress(), ...JSON.parse(raw) }
  } catch {
    return emptyProgress()
  }
}

export async function saveProgress(bridge: EvenAppBridge, p: Progress): Promise<void> {
  try {
    await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(p))
  } catch (err) {
    console.warn('could not save progress', err)
  }
}
