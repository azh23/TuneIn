// Instrument profiles + turning a spoken/typed sentence into an instrument.
//
// ElevenLabs (or any speech-to-text) only has to produce a STRING like
// "I play the trumpet". Everything after that is plain code in this file.

export type InstrumentId =
  | 'voice' | 'violin' | 'flute' | 'clarinet' | 'trumpet' | 'altosax' | 'guitar' | 'piano'

export interface Instrument {
  id: InstrumentId
  label: string
  /** Beginner-friendly range, in WRITTEN pitch (what is printed on the staff). 60 = middle C. */
  lowWritten: number
  highWritten: number
  /** sounding pitch minus written pitch. Bb trumpet/clarinet = -2, alto sax = -9, guitar = -12. */
  transpose: number
}

export const INSTRUMENTS: Instrument[] = [
  { id: 'voice', label: 'Voice', lowWritten: 55, highWritten: 77, transpose: 0 },
  { id: 'violin', label: 'Violin', lowWritten: 55, highWritten: 81, transpose: 0 },
  { id: 'flute', label: 'Flute', lowWritten: 60, highWritten: 81, transpose: 0 },
  { id: 'clarinet', label: 'Clarinet', lowWritten: 55, highWritten: 79, transpose: -2 },
  { id: 'trumpet', label: 'Trumpet', lowWritten: 55, highWritten: 77, transpose: -2 },
  { id: 'altosax', label: 'Alto sax', lowWritten: 58, highWritten: 81, transpose: -9 },
  { id: 'guitar', label: 'Guitar', lowWritten: 55, highWritten: 76, transpose: -12 },
  { id: 'piano', label: 'Piano', lowWritten: 60, highWritten: 81, transpose: 0 },
]

/** staff.ts draws G3 (55) up to A5 (81) comfortably. */
export const STAFF_MIN = 55
export const STAFF_MAX = 81
/** The pitch detector searches 60-1200 Hz; keep sounding notes well inside that. */
export const MIC_MIN = 40
export const MIC_MAX = 84

export function byId(id: string): Instrument | undefined {
  return INSTRUMENTS.find(i => i.id === id)
}

/** Written range that is safe for the staff renderer AND for the mic. */
export function writtenRange(i: Instrument): [number, number] {
  const lo = Math.max(i.lowWritten, STAFF_MIN, MIC_MIN - i.transpose)
  const hi = Math.min(i.highWritten, STAFF_MAX, MIC_MAX - i.transpose)
  return [lo, hi]
}

// ── Understanding "what do you play?" ─────────────────────────────────────

const ALIASES: Record<InstrumentId, string[]> = {
  voice: ['voice', 'vocal', 'vocals', 'sing', 'singing', 'singer', 'choir'],
  violin: ['violin', 'fiddle'],
  flute: ['flute'],
  clarinet: ['clarinet'],
  trumpet: ['trumpet', 'cornet'],
  altosax: ['alto sax', 'alto saxophone', 'saxophone', 'sax'],
  guitar: ['guitar'],
  piano: ['piano', 'keyboard', 'keys'],
}

// Real instruments we cannot draw yet (bass clef / alto clef / percussion).
const UNSUPPORTED = [
  'bass guitar', 'double bass', 'upright bass', 'bass', 'cello', 'trombone', 'tuba', 'viola',
  'french horn', 'horn', 'bassoon', 'euphonium', 'baritone', 'drum', 'drums', 'percussion',
]

export type InstrumentMatch =
  | { status: 'ok'; instrument: Instrument }
  | { status: 'ambiguous'; candidates: Instrument[] }
  | { status: 'unsupported'; word: string }
  | { status: 'unknown' }

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

function has(text: string, phrase: string): boolean {
  if (text.includes(` ${phrase} `)) return true
  // Tolerate one typo / speech-to-text slip in longer single words ("clarinette", "trumpit").
  if (!phrase.includes(' ') && phrase.length >= 6) {
    const maxDist = phrase.length >= 8 ? 2 : 1
    return text.trim().split(' ').some(w => Math.abs(w.length - phrase.length) <= maxDist && editDistance(w, phrase) <= maxDist)
  }
  return false
}

export function parseInstrument(transcript: string): InstrumentMatch {
  let text = normalize(transcript)
  // "bass guitar" must not be read as "guitar".
  const unsupportedHit = UNSUPPORTED.find(w => has(text, w))
  if (unsupportedHit && unsupportedHit.includes('bass')) {
    text = text.replace(/ (bass guitar|double bass|upright bass|bass) /g, ' ')
  }

  const found = INSTRUMENTS.filter(inst => ALIASES[inst.id].some(a => has(text, a)))
  if (found.length === 1) return { status: 'ok', instrument: found[0] }
  if (found.length > 1) return { status: 'ambiguous', candidates: found }
  if (unsupportedHit) return { status: 'unsupported', word: unsupportedHit }
  return { status: 'unknown' }
}

/**
 * Where the ElevenLabs transcript plugs in. Implement one of these and pass it to
 * askInstrument(). `typedFallback` is a stand-in until ElevenLabs is wired up.
 */
export type TranscriptSource = () => Promise<string>

export async function askInstrument(
  getTranscript: TranscriptSource,
  maxTries = 3,
): Promise<{ instrument: Instrument | null; lastMatch: InstrumentMatch }> {
  let last: InstrumentMatch = { status: 'unknown' }
  for (let i = 0; i < maxTries; i++) {
    last = parseInstrument(await getTranscript())
    if (last.status === 'ok') return { instrument: last.instrument, lastMatch: last }
  }
  return { instrument: null, lastMatch: last }
}

/** One short line for the lens/phone describing why we could not pick yet. */
export function retryMessage(m: InstrumentMatch): string {
  switch (m.status) {
    case 'ambiguous': return `Which one: ${m.candidates.map(c => c.label).join(' or ')}?`
    case 'unsupported': return `${m.word} is not supported yet`
    case 'unknown': return 'Say the instrument you play'
    default: return ''
  }
}
