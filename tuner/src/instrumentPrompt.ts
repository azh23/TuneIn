import { OsEventTypeList, type waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { parseInstrument, retryMessage, type Instrument } from './instruments'
import { VOICE_SERVER_URL } from './config'

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

const SAMPLE_RATE = 16000 // G2 mic: PCM s16le, 16 kHz, mono
const RECORD_MS = 4000
const SHOW_RESULT_MS = 1000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Wrap raw PCM in a WAV header so ElevenLabs can read it. */
function toWav(chunks: Uint8Array[]): Blob {
  const size = chunks.reduce((n, c) => n + c.length, 0)
  const h = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)) }
  tag(0, 'RIFF'); h.setUint32(4, 36 + size, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true)
  h.setUint32(24, SAMPLE_RATE, true); h.setUint32(28, SAMPLE_RATE * 2, true)
  h.setUint16(32, 2, true); h.setUint16(34, 16, true)
  tag(36, 'data'); h.setUint32(40, size, true)
  return new Blob([h.buffer, ...(chunks as BlobPart[])], { type: 'audio/wav' })
}

async function transcribe(wav: Blob): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(`${VOICE_SERVER_URL}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'ngrok-skip-browser-warning': 'true' },
      body: wav,
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return String((await res.json()).text ?? '')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Asks the player to say their instrument. Returns it, or null after maxTries
 * failures (the caller then falls back to the saved/default instrument).
 */
export async function askInstrumentByVoice(
  bridge: Bridge,
  show: (text: string) => void,
  maxTries = 3,
): Promise<Instrument | null> {
  if (!VOICE_SERVER_URL) { console.warn('voice: VITE_VOICE_SERVER_URL is empty'); return null }

  let chunks: Uint8Array[] | null = null
  let onTap: (() => void) | null = null

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm && chunks) chunks.push(pcm.slice()) // copy: the buffer may be reused

    // A single tap has eventType undefined (CLICK is 0), so default it only inside an envelope.
    const env = event.sysEvent ?? event.textEvent
    const type = env ? (env.eventType ?? OsEventTypeList.CLICK_EVENT) : null
    if (type === OsEventTypeList.CLICK_EVENT && onTap) {
      const fn = onTap
      onTap = null
      fn()
    }
  })

  try {
    await bridge.audioControl(true)
    let message = 'What do you play?\nTap, then say it'

    for (let attempt = 0; attempt < maxTries; attempt++) {
      show(message)
      await new Promise<void>(resolve => { onTap = resolve })

      chunks = []
      const start = Date.now()
      while (Date.now() - start < RECORD_MS) {
        show(`Listening… ${Math.ceil((RECORD_MS - (Date.now() - start)) / 1000)}`)
        await sleep(500)
      }
      const recorded = chunks
      chunks = null

      if (!recorded.length) { message = 'No audio heard\nTap to try again'; continue }

      show('Understanding…')
      try {
        const text = await transcribe(toWav(recorded))
        console.log('voice: heard', text)
        const match = parseInstrument(text)
        if (match.status === 'ok') {
            show(`Got it:\n${match.instrument.label}`)
            await sleep(SHOW_RESULT_MS)
            return match.instrument
        }
        message = `${retryMessage(match)}\nTap to try again`
      } catch (err) {
        console.warn('voice: transcription failed', err)
        message = "Couldn't reach the server\nTap to try again"
      }
    }
    return null
  } finally {
    unsubscribe()
  }
}