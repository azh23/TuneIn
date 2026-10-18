import { parseInstrument, type Instrument } from './instruments'
import { VOICE_SERVER_URL } from './config'

const SEEN_KEY = 'tunein.lastCall.v1'

type Store = { get(k: string): Promise<string | null | undefined>; set(k: string, v: string): Promise<unknown> }

/** Returns an instrument only if there is a NEW call we haven't applied yet. */
export async function instrumentFromCall(storage: Store): Promise<Instrument | null> {
  if (!VOICE_SERVER_URL) return null
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(`${VOICE_SERVER_URL}/api/latest-instrument`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return null

    const d = await res.json()
    if (!d.conversationId) return null
    if ((await storage.get(SEEN_KEY)) === d.conversationId) return null // already applied

    const match = parseInstrument(d.instrument || d.userText || '')
    if (match.status !== 'ok') return null

    await storage.set(SEEN_KEY, d.conversationId)
    return match.instrument
  } catch {
    return null // server unreachable: fall back to the saved instrument
  }
}