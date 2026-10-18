// Scoring for a practice run: records how well each note was played, turns
// that into points, and keeps a running progress record (points, streak).

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { StaffNote } from './staff'
import { gradeRhythm, msPerBeat, type RhythmSummary } from './rhythm'

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
  /** Median error in cents over the whole time the note was held
   *  (negative = flat, positive = sharp). */
  centsError: number
  /** Milliseconds since the previous note (kept for beat scoring later). */
  gapMs: number
  /** When the right note started sounding (same clock as `feed`'s `now`). */
  onsetMs: number
  /** Wrong notes heard while trying to play this one. */
  wrongNotes: number
}

export interface Summary {
  total: number
  avgCents: number // average absolute error
  wrongNotes: number
  /** Total = pitchPoints + rhythmPoints (+ perfect bonus). */
  points: number
  pitchPoints: number
  rhythmPoints: number
  perfect: boolean
  durationMs: number
  /** Null until at least 3 notes are played (needs 2+ intervals). */
  rhythm: RhythmSummary | null
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

/** Up to this many points per note for timing (all notes but the last are graded). */
const RHYTHM_POINTS_PER_NOTE = 5
/** Rhythm score needed (when there is one) for the perfect bonus. */
const PERFECT_RHYTHM = 85

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
  private targetSince: number | null = null // onset of the current attempt at the target note
  private finished = false
  private samples: number[][] = [] // every cents reading per completed note, incl. while held

  constructor(
    readonly exercise: StaffNote[],
    /** Match pitch class only, so playing/singing an octave off still counts. */
    private readonly ignoreOctave = false,
    /** Metronome tempo; rhythm is graded against it when set. */
    private readonly fixedMsPerBeat?: number,
  ) {}

  /** True once the last note has been played AND let go (or held long enough). */
  get done(): boolean {
    return this.finished
  }

  /** True while the note just completed is still sounding. The display keeps
   *  pointing at it until the player moves on, instead of jumping ahead. */
  get holding(): boolean {
    return this.heldMidi !== null && !this.finished
  }

  /** Index of the note the display should point at. */
  get marker(): number {
    if (this.finished) return this.exercise.length
    return this.holding ? this.step - 1 : this.step
  }

  /** True once anything has been played, so a restart would lose progress. */
  get started(): boolean {
    return this.startedAt !== null
  }

  private same(a: number, b: number): boolean {
    return this.ignoreOctave ? (((a - b) % 12) + 12) % 12 === 0 : a === b
  }

  private finish(now: number) {
    this.finished = true
    this.heldMidi = null
    this.endedAt = now
  }

  /** True once the final note has sounded for its written length at the
   *  tempo the player has been using. */
  private lastNoteLongEnough(now: number): boolean {
    const beats = this.exercise.map(n => n.beats)
    const tempo = this.fixedMsPerBeat ?? msPerBeat(this.results.map(r => r.onsetMs), beats)
    const last = this.results[this.results.length - 1]
    return tempo !== null && last !== undefined && now - last.onsetMs >= beats[beats.length - 1] * tempo
  }

  /** Call on every reading where no clear pitch was heard. Returns true when
   *  the display should update (a held note was let go). */
  silence(now: number): boolean {
    if (this.finished) return false
    if (this.silentSince === null) {
      this.silentSince = now
      return false
    }
    if (now - this.silentSince < RELEASE_MS || this.heldMidi === null) return false
    this.heldMidi = null
    if (this.step >= this.exercise.length) this.finish(this.silentSince)
    return true
  }

  /** Feed one pitch reading. Returns true when the display should update:
   *  a note was completed, a held note gave way to the next one, or the run
   *  finished. */
  feed(midi: number, cents: number, now: number): boolean {
    if (this.finished) return false
    this.silentSince = null

    // The note we just finished is usually still ringing: it is neither right nor wrong.
    let changed = false
    if (this.heldMidi !== null) {
      if (this.same(midi, this.heldMidi)) {
        // Still holding the completed note: keep judging its intonation.
        const i = this.results.length - 1
        this.samples[i].push(cents)
        this.results[i].centsError = Math.round(median(this.samples[i]))
        // Last note: finish once it has been held for its written length.
        if (this.step >= this.exercise.length && this.lastNoteLongEnough(now)) {
          this.finish(now)
          return true
        }
        return false
      }
      // A different pitch: the player has moved on.
      this.heldMidi = null
      changed = true
      if (this.step >= this.exercise.length) {
        this.finish(now)
        return true
      }
    }
    // Brief settling time right after a completed note.
    const target = this.exercise[this.step].midi
    if (this.lastAt !== null && now - this.lastAt < GRACE_MS && !this.same(midi, target)) return changed

    if (this.startedAt === null) this.startedAt = now

    if (this.same(midi, target)) {
      if (this.targetSince === null) this.targetSince = now
      this.wrongRun = 0
      if (Math.abs(cents) <= MATCH_CENTS) this.good.push(cents)
      else this.good = [] // right note but too far out: start the streak again
    } else {
      this.good = []
      this.targetSince = null
      this.wrongRun++
      // Count a wrong note once it lasts two readings, so one noisy frame is ignored.
      if (this.wrongRun === 2) this.wrongNow++
      return changed
    }

    if (this.good.length < HITS_NEEDED) return changed

    this.samples.push([...this.good])
    this.results.push({
      midi: target,
      centsError: Math.round(median(this.good)),
      gapMs: this.lastAt === null ? 0 : Math.round(now - this.lastAt),
      onsetMs: this.targetSince ?? now,
      wrongNotes: this.wrongNow,
    })
    this.targetSince = null
    this.lastAt = now
    this.heldMidi = midi
    this.good = []
    this.wrongNow = 0
    this.step++
    return true
  }

  summary(): Summary {
    const total = this.results.length
    const avgCents = total ? Math.round(this.results.reduce((a, r) => a + Math.abs(r.centsError), 0) / total) : 0
    const wrongNotes = this.results.reduce((a, r) => a + r.wrongNotes, 0)
    const pitchPoints = this.results.reduce((a, r) => a + notePoints(Math.abs(r.centsError), r.wrongNotes), 0)
    const rhythm = gradeRhythm(
      this.results.map(r => r.onsetMs),
      this.exercise.slice(0, total).map(n => n.beats),
      this.fixedMsPerBeat,
    )
    const rhythmPoints = rhythm ? Math.round(rhythm.notes.reduce((a, n) => a + n.credit * RHYTHM_POINTS_PER_NOTE, 0)) : 0
    const perfect =
      total === this.exercise.length && wrongNotes === 0 && avgCents <= 15 && (!rhythm || rhythm.score >= PERFECT_RHYTHM)
    const points = pitchPoints + rhythmPoints + (perfect ? 20 : 0)
    const durationMs = this.startedAt !== null && this.endedAt !== null ? Math.round(this.endedAt - this.startedAt) : 0
    return { total, avgCents, wrongNotes, points, pitchPoints, rhythmPoints, perfect, durationMs, rhythm }
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
