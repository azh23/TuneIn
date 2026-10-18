// Builds practice exercises from rules (never free-written by a model).
// Notes are in WRITTEN pitch, which is what staff.ts draws. For scoring, use
// toSounding(), because the mic hears sounding pitch (trumpet/clarinet/sax/guitar differ).

import type { StaffNote } from './staff'
import { type Instrument, writtenRange, MIC_MIN, MIC_MAX, CLEF_STAFF, type Clef } from './instruments'

export interface PracticeExercise {
  id: string
  instrumentId: string
  level: number
  title: string
  key: number // + sharps, - flats (written)
  timeSig: [number, number]
  tempoBpm: number
  notes: StaffNote[] // written pitch
  transpose: number // sounding - written
  /** Where it came from. Missing means generated locally by the rules. */
  source?: 'creao' | 'local'
  clef?: Clef
}

export const MAX_LEVEL = 3
const ALLOWED_BEATS = [0.5, 1, 2, 4]

/** Notes the player is expected to SOUND (what the mic should hear). */
export function toSounding(ex: PracticeExercise): StaffNote[] {
  return ex.notes.map(n => ({ ...n, midi: n.midi + ex.transpose }))
}

// ── random numbers (seeded, so a batch is reproducible) ──────────────────

export function seedFrom(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

export type Rng = () => number
export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)]

// ── keys and scales ──────────────────────────────────────────────────────

interface KeyDef { name: string; key: number; pc: number; minor: boolean }
const KEYS: Record<string, KeyDef> = {
  C: { name: 'C major', key: 0, pc: 0, minor: false },
  G: { name: 'G major', key: 1, pc: 7, minor: false },
  F: { name: 'F major', key: -1, pc: 5, minor: false },
  D: { name: 'D major', key: 2, pc: 2, minor: false },
  Bb: { name: 'Bb major', key: -2, pc: 10, minor: false },
  A: { name: 'A major', key: 3, pc: 9, minor: false },
  Eb: { name: 'Eb major', key: -3, pc: 3, minor: false },
  Am: { name: 'A minor', key: 0, pc: 9, minor: true },
  Em: { name: 'E minor', key: 1, pc: 4, minor: true },
  Dm: { name: 'D minor', key: -1, pc: 2, minor: true },
  Bm: { name: 'B minor', key: 2, pc: 11, minor: true },
  Gm: { name: 'G minor', key: -2, pc: 7, minor: true },
}
const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]

function degree(minor: boolean, d: number): number {
  const s = minor ? MINOR : MAJOR
  return s[d % 7] + 12 * Math.floor(d / 7)
}

/** Pitch classes allowed by a written key signature (major scale of that key). */
const KEY_ROOT_PC: Record<number, number> = { 0: 0, 1: 7, 2: 2, 3: 9, [-1]: 5, [-2]: 10, [-3]: 3 }
function diatonicPcs(key: number): Set<number> {
  const root = KEY_ROOT_PC[key]
  return new Set(MAJOR.map(o => (root + o) % 12))
}

/** Choose a root so every note of the pattern fits in [lo, hi]; null if it cannot. */
function place(offsets: number[], pc: number, lo: number, hi: number, rng: Rng): number | null {
  const mn = Math.min(...offsets)
  const mx = Math.max(...offsets)
  const roots: number[] = []
  for (let r = pc; r <= hi; r += 12) if (r + mn >= lo && r + mx <= hi) roots.push(r)
  return roots.length ? pick(rng, roots) : null
}

// ── recipes ──────────────────────────────────────────────────────────────

type Kind = 'scale' | 'arpeggio' | 'thirds' | 'rhythm'
interface Recipe { kind: Kind; keys: string[]; beat: number; dir?: 'up' | 'down' | 'either' }

const LEVELS: Record<number, Recipe[]> = {
  1: [{ kind: 'scale', keys: ['C'], beat: 1, dir: 'up' }],
  2: [{ kind: 'scale', keys: ['C'], beat: 1, dir: 'down' }, { kind: 'scale', keys: ['Am'], beat: 1, dir: 'up' }],
  3: [{ kind: 'scale', keys: ['G', 'F'], beat: 1, dir: 'either' }],
  4: [{ kind: 'scale', keys: ['D', 'Bb'], beat: 1, dir: 'either' }],
  5: [{ kind: 'arpeggio', keys: ['C', 'G', 'F', 'D'], beat: 1 }],
  6: [{ kind: 'thirds', keys: ['C', 'G', 'F', 'D'], beat: 1 }],
  7: [{ kind: 'scale', keys: ['A', 'Eb', 'Em', 'Dm', 'Bm', 'Gm'], beat: 1, dir: 'either' }],
  8: [{ kind: 'scale', keys: ['C', 'G', 'F', 'D', 'Bb'], beat: 0.5, dir: 'either' }],
  9: [{ kind: 'rhythm', keys: ['C', 'G', 'F', 'D', 'Bb'], beat: 1 }],
  10: [
    { kind: 'arpeggio', keys: ['A', 'Eb', 'D', 'Bb'], beat: 0.5 },
    { kind: 'thirds', keys: ['A', 'Eb', 'D', 'Bb'], beat: 0.5 },
  ],
}

const RHYTHMS = [
  [2, 1, 0.5, 0.5], [1, 1, 2], [0.5, 0.5, 1, 2], [1, 0.5, 0.5, 1, 1], [1, 1, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 0.5, 2],
]

interface Draft { title: string; offsets: number[]; beats: number[] }

function draft(r: Recipe, k: KeyDef, rng: Rng): Draft {
  const uniform = (n: number) => new Array<number>(n).fill(r.beat)
  if (r.kind === 'scale') {
    const up = Array.from({ length: 8 }, (_, d) => degree(k.minor, d))
    const dir = r.dir === 'either' || !r.dir ? pick(rng, ['up', 'down'] as const) : r.dir
    return dir === 'up'
      ? { title: `${k.name} scale`, offsets: up, beats: uniform(8) }
      : { title: `${k.name} scale, down`, offsets: [...up].reverse(), beats: uniform(8) }
  }
  if (r.kind === 'arpeggio') {
    const offs = [0, 4, 7, 12, 7, 4, 0]
    const beats = r.beat === 0.5 ? [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1] : [1, 1, 1, 1, 1, 1, 2]
    return { title: `${k.name} arpeggio`, offsets: offs, beats }
  }
  if (r.kind === 'thirds') {
    return { title: `${k.name} thirds`, offsets: [0, 2, 1, 3, 2, 4, 3, 5].map(d => degree(k.minor, d)), beats: uniform(8) }
  }
  // rhythm: a stepwise tune in the key with a mixed rhythm, no repeated neighbours
  const beats = pick(rng, RHYTHMS)
  const degs = [0]
  while (degs.length < beats.length) {
    const prev = degs[degs.length - 1]
    const next = Math.max(0, Math.min(7, prev + pick(rng, [1, 1, 2, -1, -1])))
    if (next !== prev) degs.push(next)
  }
  return { title: `${k.name} rhythm`, offsets: degs.map(d => degree(k.minor, d)), beats }
}

function fnv(text: string): string {
  return seedFrom(text).toString(36)
}

function buildOne(inst: Instrument, level: number, rng: Rng): PracticeExercise | null {
  const r = pick(rng, LEVELS[level])
  const k = KEYS[pick(rng, r.keys)]
  const d = draft(r, k, rng)
  const [lo, hi] = writtenRange(inst)
  const root = place(d.offsets, k.pc, lo, hi, rng)
  if (root === null) return null
  const notes: StaffNote[] = d.offsets.map((o, i) => ({ midi: root + o, beats: d.beats[i] }))
  const sig = notes.map(n => `${n.midi}/${n.beats}`).join(',')
  const eighths = d.beats.some(b => b === 0.5)
  console.log("instrument being generated:", inst)
  return {
    id: `${inst.id}-L${level}-${fnv(d.title + sig)}`,
    instrumentId: inst.id,
    level,
    title: d.title,
    key: k.key,
    timeSig: [4, 4],
    // eighth-note levels run slower so notes stay far enough apart for the mic and display
    tempoBpm: eighths && r.kind !== 'rhythm' ? 54 : 60 + 2 * level,
    notes,
    transpose: inst.transpose,
    clef: inst.clef,
  }
}

// ── validation ───────────────────────────────────────────────────────────

export function validateExercise(ex: PracticeExercise, inst: Instrument): string[] {
  const errs: string[] = []
  const [lo, hi] = writtenRange(inst)
  if (!ex.notes.length || ex.notes.length > 8) errs.push(`needs 1-8 notes, has ${ex.notes.length}`)
  const total = ex.notes.reduce((a, n) => a + n.beats, 0)
  if (total <= 0 || total > 8) errs.push(`total length ${total} beats is outside 1-8`)
  const pcs = diatonicPcs(ex.key)
  const [smin, smax] = CLEF_STAFF[ex.clef ?? inst.clef]
  ex.notes.forEach((n, i) => {
    if (!Number.isInteger(n.midi)) errs.push(`note ${i} is not a whole MIDI number`)
    if (n.midi < lo || n.midi > hi) errs.push(`note ${i} (${n.midi}) is outside ${inst.label} range ${lo}-${hi}`)
    const s = n.midi + ex.transpose
    if (s < MIC_MIN || s > MIC_MAX) errs.push(`note ${i} sounds at ${s}, outside the mic range`)
    if (!ALLOWED_BEATS.includes(n.beats)) errs.push(`note ${i} has length ${n.beats}`)
    if (!pcs.has(((n.midi % 12) + 12) % 12)) errs.push(`note ${i} (${n.midi}) is not in key ${ex.key}`)
    if (i > 0 && n.midi === ex.notes[i - 1].midi) errs.push(`note ${i} repeats the previous pitch`)
    if (n.midi < smin || n.midi > smax) errs.push(`note ${i} cannot be drawn on the staff`)
  })
  if (ex.transpose !== inst.transpose) errs.push('transposition does not match the instrument')
  return errs
}

/** Make up to `count` different valid exercises for one level. Fewer may come back if the range is tight. */
export function generateLevel(inst: Instrument, level: number, count: number, rng: Rng, used: Set<string>): PracticeExercise[] {
  const out: PracticeExercise[] = []
  for (let tries = 0; tries < count * 40 && out.length < count; tries++) {
    const ex = buildOne(inst, level, rng)
    if (!ex || used.has(ex.id)) continue
    if (validateExercise(ex, inst).length) continue
    used.add(ex.id)
    out.push(ex)
  }
  return out
}