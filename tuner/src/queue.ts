// The practice queue: after the player says what they play, build a stock of
// exercises up front (levels 1-3 first, so the wait is short), keep building the
// rest in the background, and save it all on the phone. After that, picking the
// next exercise is instant and needs no network.

import { INSTRUMENTS, byId, type Instrument } from './instruments'
import { MAX_LEVEL, generateLevel, makeRng, seedFrom, type PracticeExercise } from './generator'

/** Anything that can save a string by key. bridgeStorage() adapts the Even Hub bridge. */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export function bridgeStorage(bridge: {
  getLocalStorage(k: string): Promise<string>
  setLocalStorage(k: string, v: string): Promise<boolean>
}): KeyValueStorage {
  return {
    async get(key) {
      try { return (await bridge.getLocalStorage(key)) || null } catch { return null }
    },
    async set(key, value) {
      try { await bridge.setLocalStorage(key, value) } catch (err) { console.warn('save failed', err) }
    },
  }
}

const INSTRUMENT_KEY = 'tunein.instrument.v1'
const queueKey = (id: string) => `tunein.queue.v1.${id}`

export async function loadInstrument(storage: KeyValueStorage): Promise<Instrument | null> {
  const id = await storage.get(INSTRUMENT_KEY)
  return id ? byId(id) ?? null : null
}
export async function saveInstrument(storage: KeyValueStorage, inst: Instrument): Promise<void> {
  await storage.set(INSTRUMENT_KEY, inst.id)
}

interface Saved { version: 1; instrumentId: string; exercises: PracticeExercise[]; seen: string[]; batches: number }

export interface CreateOptions {
  perLevel?: number // exercises per level (default 4)
  firstLevels?: number // levels built before create() returns (default 3)
  onProgress?: (done: number, total: number) => void
  /** Pause between levels so the app stays responsive. Default: let the event loop breathe. */
  yieldFn?: () => Promise<void>
}

const breathe = () => new Promise<void>(r => setTimeout(r, 0))

export class ExerciseQueue {
  /** Resolves when every level has been built (levels past `firstLevels` finish in the background). */
  background: Promise<void> = Promise.resolve()

  private constructor(
    readonly instrument: Instrument,
    private storage: KeyValueStorage,
    private exercises: PracticeExercise[],
    private seen: string[],
    private batches: number,
  ) {}

  /** Restore a saved queue for this instrument, or null if there is none. */
  static async load(storage: KeyValueStorage, instrumentId: string): Promise<ExerciseQueue | null> {
    const inst = byId(instrumentId)
    const raw = await storage.get(queueKey(instrumentId))
    if (!inst || !raw) return null
    try {
      const s = JSON.parse(raw) as Saved
      if (s.version !== 1 || s.instrumentId !== instrumentId || !Array.isArray(s.exercises)) return null
      return new ExerciseQueue(inst, storage, s.exercises, s.seen ?? [], s.batches ?? 1)
    } catch {
      return null
    }
  }

  /** Build a fresh queue. Resolves after the first levels are ready (show "Preparing…" until then). */
  static async create(inst: Instrument, storage: KeyValueStorage, opts: CreateOptions = {}): Promise<ExerciseQueue> {
    const perLevel = opts.perLevel ?? 4
    const first = Math.min(opts.firstLevels ?? 3, MAX_LEVEL)
    const pause = opts.yieldFn ?? breathe
    const q = new ExerciseQueue(inst, storage, [], [], 1)
    const used = new Set<string>()

    const buildLevel = async (level: number) => {
      const rng = makeRng(seedFrom(`${inst.id}:${level}:1`))
      q.exercises.push(...generateLevel(inst, level, perLevel, rng, used))
      opts.onProgress?.(level, MAX_LEVEL)
      await pause()
    }

    for (let l = 1; l <= first; l++) await buildLevel(l)
    await q.save()

    q.background = (async () => {
      await pause() // let create() return first, so only the first levels are counted as the wait
      for (let l = first + 1; l <= MAX_LEVEL; l++) await buildLevel(l)
      await q.save()
    })()
    return q
  }

  /** The best exercise for this level: an unseen one if any, otherwise the one seen longest ago. */
  next(level: number): PracticeExercise {
    // If higher levels are still being built, fall back to the closest lower level that exists.
    let l = Math.min(Math.max(level, 1), MAX_LEVEL)
    while (l > 1 && !this.exercises.some(e => e.level === l)) l--
    // Agent-made exercises come first when there are any; the rules-made ones are the backup.
    const atLevel = this.exercises
      .filter(e => e.level === l)
      .sort((a, b) => Number(b.source === 'creao') - Number(a.source === 'creao'))
    const unseen = atLevel.find(e => !this.seen.includes(e.id))
    if (unseen) return unseen
    return [...atLevel].sort((a, b) => this.seen.lastIndexOf(a.id) - this.seen.lastIndexOf(b.id))[0]
  }

  async markSeen(id: string): Promise<void> {
    this.seen.push(id)
    if (this.seen.length > 200) this.seen = this.seen.slice(-100)
    await this.save()
  }

  /** How many unseen exercises remain at this level. */
  unseenAt(level: number): number {
    return this.exercises.filter(e => e.level === level && !this.seen.includes(e.id)).length
  }

  /** True once agent-made exercises have been added (so a restart need not ask again). */
  get hasCreao(): boolean {
    return this.exercises.some(e => e.source === 'creao')
  }

  /** Add exercises from outside (the agent). Duplicates are skipped. Returns how many were new. */
  async addExercises(list: PracticeExercise[]): Promise<number> {
    const have = new Set(this.exercises.map(e => e.id))
    const fresh = list.filter(e => e.instrumentId === this.instrument.id && !have.has(e.id))
    if (!fresh.length) return 0
    this.exercises.push(...fresh)
    await this.save()
    return fresh.length
  }

  get levelsReady(): number {
    return this.exercises.reduce((m, e) => Math.max(m, e.level), 0)
  }

  /** Add more exercises for a level when the player is running low (safe to ignore failures). */
  async topUp(level: number, count = 3): Promise<number> {
    if (this.unseenAt(level) >= 2) return 0
    this.batches++
    const used = new Set(this.exercises.map(e => e.id))
    const rng = makeRng(seedFrom(`${this.instrument.id}:${level}:${this.batches}`))
    const more = generateLevel(this.instrument, level, count, rng, used)
    this.exercises.push(...more)
    await this.save()
    return more.length
  }

  private async save(): Promise<void> {
    const s: Saved = { version: 1, instrumentId: this.instrument.id, exercises: this.exercises, seen: this.seen, batches: this.batches }
    await this.storage.set(queueKey(this.instrument.id), JSON.stringify(s))
  }
}

export const SUPPORTED_LABELS = INSTRUMENTS.map(i => i.label)
