// Gets a stock of exercises from the Creao Practice Coach agent, without ever
// making the player wait on it.
//
//   app --> your proxy server (holds the Creao key) --> Creao (async: run id, then poll)
//
// "Buffering" means: build the rules-made queue (instant), ask the agent for its
// exercises, and show "Preparing…" for at most maxWaitMs. Whatever the agent returns
// is checked and added; anything late is added when it arrives. If the agent is slow
// or down, the app plays from the rules-made queue and nobody notices.

import { type Instrument, writtenRange } from './instruments'
import { MAX_LEVEL, seedFrom, validateExercise, type PracticeExercise } from './generator'
import { ExerciseQueue, type KeyValueStorage } from './queue'
import type { StaffNote } from './staff'

export interface CreaoOptions {
  /** Base URL of your proxy server, e.g. https://abc123.ngrok.app (add it to app.json's network whitelist). */
  proxyUrl?: string
  /** Call Creao directly from the app (the key ships inside the app - use a capped, throwaway key). */
  direct?: { key: string; appId: string; base?: string; userField?: string; payloadField?: string }
  /** How long the "Preparing…" screen may last. Default 20 s. */
  maxWaitMs?: number
  /** Stop waiting for the agent altogether after this long. Default 120 s. */
  giveUpMs?: number
  pollMs?: number
  perLevel?: number
  /** Called about once a second while buffering. */
  onBuffering?: (elapsedMs: number, maxWaitMs: number) => void
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 8000)
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ── checking what the agent sends back ───────────────────────────────────

function toNotes(raw: unknown): StaffNote[] | null {
  if (!Array.isArray(raw)) return null
  const out: StaffNote[] = []
  for (const n of raw) {
    const midi = Array.isArray(n) ? Number(n[0]) : Number((n as any)?.midi)
    const beats = Array.isArray(n) ? Number(n[1]) : Number((n as any)?.beats)
    if (!Number.isFinite(midi) || !Number.isFinite(beats)) return null
    out.push({ midi: Math.round(midi), beats })
  }
  return out
}

/** Move a whole exercise up/down by octaves until it fits the instrument's range. Null if it cannot. */
function fitOctave(notes: StaffNote[], lo: number, hi: number): StaffNote[] | null {
  const mn = Math.min(...notes.map(n => n.midi))
  const mx = Math.max(...notes.map(n => n.midi))
  for (const shift of [0, -12, 12, -24, 24]) {
    if (mn + shift >= lo && mx + shift <= hi) return notes.map(n => ({ ...n, midi: n.midi + shift }))
  }
  return null
}

/**
 * Turn the agent's raw list into exercises we trust. Anything that does not pass the
 * same checks as our own generator (range, note lengths, key, 8-note limit) is dropped.
 */
export function sanitizeAgentExercises(raw: unknown, inst: Instrument): PracticeExercise[] {
  if (!Array.isArray(raw)) return []
  const [lo, hi] = writtenRange(inst)
  const out: PracticeExercise[] = []
  const seen = new Set<string>()
  for (const r of raw as any[]) {
    const level = Number(r?.level)
    if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) continue
    const parsed = toNotes(r?.notes)
    const key = Number(r?.key)
    if (!parsed || !parsed.length || !Number.isInteger(key)) continue
    const notes = fitOctave(parsed, lo, hi)
    if (!notes) continue
    const title = String(r?.title ?? 'PracticeExercise').slice(0, 40)
    const tempo = Number(r?.tempoBpm)
    const ex: PracticeExercise = {
      id: `${inst.id}-L${level}-c-${seedFrom(title + notes.map(n => `${n.midi}/${n.beats}`).join(',')).toString(36)}`,
      instrumentId: inst.id,
      level,
      title,
      key,
      timeSig: [4, 4],
      tempoBpm: tempo >= 40 && tempo <= 120 ? Math.round(tempo) : 60 + 2 * level,
      notes,
      transpose: inst.transpose,
      source: 'creao',
    }
    if (seen.has(ex.id) || validateExercise(ex, inst).length) continue
    seen.add(ex.id)
    out.push(ex)
  }
  return out
}

// ── talking to the proxy ─────────────────────────────────────────────────

/** Ask the agent for exercises and wait (politely) for the run to finish. Throws on failure or give-up. */
function parseLoose(text: unknown): unknown {
  if (typeof text !== 'string') return null
  const tries = [text.trim()]
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) tries.push(fence[1].trim())
  const a = text.indexOf('['), b = text.lastIndexOf(']')
  if (a !== -1 && b > a) tries.push(text.slice(a, b + 1))
  const c = text.indexOf('{'), d = text.lastIndexOf('}')
  if (c !== -1 && d > c) tries.push(text.slice(c, d + 1))
  for (const t of tries) {
    try { return JSON.parse(t) } catch {}
  }
  return null
}

function toList(data: any): any[] {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data.exercises)) return data.exercises
  if (Array.isArray(data.library)) return data.library
  const out: any[] = []
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v) && /^\d+$/.test(k)) for (const e of v) out.push({ level: Number(k), ...(e as object) })
  }
  return out
}

async function extractDirect(result: any, auth: Record<string, string>): Promise<any[]> {
  if (!result) return []
  for (const text of [result.text, result.chatText]) {
    const list = toList(parseLoose(text))
    if (list.length) return list
  }
  for (const art of result.artifacts ?? []) {
    const url = typeof art === 'string' ? art : art?.url
    if (!url) continue
    try {
      const r = await fetch(url, { headers: auth })
      const list = toList(parseLoose(await r.text()))
      if (list.length) return list
    } catch {}
  }
  return []
}

/** Same job as the proxy, run inside the app. */
async function fetchDirect(inst: Instrument, opts: CreaoOptions): Promise<PracticeExercise[]> {
  const d = opts.direct!
  const base = `${(d.base ?? 'https://agent.creao.ai').replace(/\/+$/, '')}/api/v1/apps/${d.appId}/runs`
  const auth = { Authorization: `Bearer ${d.key}` }
  const payload = {
    action: 'library',
    instrumentId: inst.id,
    levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    perLevel: Math.max(1, Math.min(6, opts.perLevel ?? 4)),
    format: 'JSON array of {level,title,key,timeSig,tempoBpm,notes:[{midi,beats}]}',
  }
  const started = await http(base, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: { [d.userField ?? 'userId']: `tunein-${inst.id}`, [d.payloadField ?? 'payload']: JSON.stringify(payload) },
    }),
  })
  const runId = String(started?.id ?? '')
  if (!runId) throw new Error('creao did not return a run id')
  const deadline = Date.now() + (opts.giveUpMs ?? 120_000)
  let wait = opts.pollMs ?? 1500
  while (Date.now() < deadline) {
    await sleep(wait)
    wait = Math.min(wait * 1.3, 5000)
    const r = await http(`${base}/${encodeURIComponent(runId)}`, { headers: auth })
    if (r?.status === 'completed') return sanitizeAgentExercises(await extractDirect(r.result, auth), inst)
    if (r?.status === 'failed' || r?.status === 'cancelled') throw new Error(`agent run ${r.status}`)
  }
  throw new Error('agent took too long')
}

export async function fetchAgentExercises(inst: Instrument, opts: CreaoOptions): Promise<PracticeExercise[]> {
  if (opts.direct) return fetchDirect(inst, opts)
  if (!opts.proxyUrl) throw new Error('no agent address set')
  const base = opts.proxyUrl.replace(/\/+$/, '')
  const started = await http(`${base}/library`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instrumentId: inst.id, perLevel: opts.perLevel ?? 4 }),
  })
  const runId = String(started?.runId ?? '')
  if (!runId) throw new Error('proxy did not return a run id')

  const deadline = Date.now() + (opts.giveUpMs ?? 120_000)
  let wait = opts.pollMs ?? 1500
  while (Date.now() < deadline) {
    await sleep(wait)
    wait = Math.min(wait * 1.3, 5000) // gentle back-off
    const r = await http(`${base}/library/${encodeURIComponent(runId)}`)
    if (r?.status === 'completed') return sanitizeAgentExercises(r.exercises, inst)
    if (r?.status === 'failed' || r?.status === 'cancelled') throw new Error(`agent run ${r.status}`)
  }
  throw new Error('agent took too long')
}

export interface BuildResult {
  queue: ExerciseQueue
  /** How many agent exercises were in the queue when the buffer screen ended. */
  agentExercises: number
  /** True if the agent was still working when the buffer ended (its exercises will be added if it finishes). */
  agentStillWorking: boolean
  /** Resolves when the background work (rest of the levels, late agent results) is done. Never rejects. */
  background: Promise<void>
}

/**
 * Call this once the instrument is known. Show "Preparing…" until it resolves,
 * then start playing; the queue is already stocked.
 */
export async function buildQueueWithAgent(
  inst: Instrument,
  storage: KeyValueStorage,
  opts: CreaoOptions,
): Promise<BuildResult> {
  // Already have a queue with the agent's exercises saved (app restarted)? Use it as is.
  const saved = await ExerciseQueue.load(storage, inst.id)
  if (saved?.hasCreao) {
    return { queue: saved, agentExercises: 1, agentStillWorking: false, background: Promise.resolve() }
  }

  const queue = saved ?? (await ExerciseQueue.create(inst, storage))
  let added = 0
  const agent = fetchAgentExercises(inst, opts)
    .then(async list => {
      added = await queue.addExercises(list)
    })
    .catch(err => console.warn('agent unavailable, using built-in exercises:', (err as Error)?.message ?? err))

  // The buffer: wait for the agent, but never longer than maxWaitMs.
  const maxWait = opts.maxWaitMs ?? 20_000
  const t0 = Date.now()
  let finished = false
  void agent.then(() => { finished = true })
  const tick = setInterval(() => opts.onBuffering?.(Date.now() - t0, maxWait), 1000)
  try {
    while (!finished && Date.now() - t0 < maxWait) await sleep(100)
  } finally {
    clearInterval(tick)
  }

  return {
    queue,
    agentExercises: added,
    agentStillWorking: !finished,
    background: Promise.all([queue.background, agent]).then(() => undefined),
  }
}
