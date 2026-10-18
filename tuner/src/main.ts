import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { detectPitch, rms } from './pitch/detector'
import { freqToNote } from './pitch/notes'
import { mountUi, setStatus, setNote, setDebug } from './ui'
import { BOX_W, BOX_PAD, tunerText, pausedText } from './glasses'
import { SheetDisplay, sheetBox } from './sheet'
import { majorScale } from './staff'

const SAMPLE_RATE = 16000 // G2 mic: PCM s16le @ 16 kHz mono
const WINDOW = 2048 // ~128 ms; covers 2+ periods down to ~60 Hz
const MIN_RMS = 0.01 // below this, treat as silence
const MIN_CLARITY = 0.85
const HOLD_MS = 600 // keep the last note on screen briefly after the sound stops
const CENTS_SMOOTHING = 0.35 // EMA weight of the newest reading; lower is steadier
const IDLE_TEXT = tunerText(null, null)

mountUi()

const bridge = await waitForEvenAppBridge()

// Full-width box, vertically centered: three 27 px lines (note, scale, cents).
const BOX_H = 3 * 27 + 2 * BOX_PAD
const noteBox = new TextContainerProperty({
  xPosition: 0,
  yPosition: 288 - BOX_H - 4, // sits under the staff image
  width: BOX_W,
  height: BOX_H,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: BOX_PAD,
  containerID: 1,
  containerName: 'note',
  content: IDLE_TEXT,
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [noteBox], imageObject: [sheetBox] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

// ── Sheet music ──────────────────────────────────────────────────────────
// The exercise: C major scale, one octave, quarter notes. `step` is the note
// the player should play next.
const EXERCISE = majorScale(60, 1)
let step = 0
let hits = 0 // consecutive analysis frames that matched the expected note
const HITS_NEEDED = 3

const sheet = new SheetDisplay(bridge)
sheet.onError = msg => setStatus('error', msg)
if (created === 0) sheet.show(EXERCISE, { key: 0, current: step, letters: true })

function advanceIfCorrect(midi: number, cents: number) {
  if (step >= EXERCISE.length) return
  if (midi === EXERCISE[step].midi && Math.abs(cents) <= 30) hits++
  else hits = 0
  if (hits >= HITS_NEEDED) {
    hits = 0
    step++
    sheet.show(EXERCISE, { key: 0, current: Math.min(step, EXERCISE.length - 1), letters: true })
  }
}

let lastRender = IDLE_TEXT
let renderTimer: number | null = null
let currentContent = IDLE_TEXT

function scheduleGlassesRender() {
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    if (currentContent === lastRender) return
    lastRender = currentContent
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'note',
        content: currentContent,
      }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

// Sliding window of the most recent WINDOW samples, as floats in [-1, 1].
const window_ = new Float32Array(WINDOW)

function pushPcm(chunk: Uint8Array) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const n = Math.floor(chunk.byteLength / 2)
  const keep = Math.max(0, WINDOW - n)
  window_.copyWithin(0, WINDOW - keep)
  const start = WINDOW - Math.min(n, WINDOW)
  const skip = n - (WINDOW - start)
  for (let i = start, j = skip; i < WINDOW; i++, j++) {
    window_[i] = view.getInt16(j * 2, true) / 32768
  }
}

// A new note has to show up twice in a row before it replaces the current
// one, so a single noisy frame can't flash the wrong note.
let shownNote: string | null = null
let candidate: string | null = null
let smoothCents: number | null = null
let lastHeard = 0
let frames = 0

function analyze() {
  const now = performance.now()
  const level = rms(window_)
  const pitch = level >= MIN_RMS ? detectPitch(window_, { sampleRate: SAMPLE_RATE }) : null
  frames++
  setDebug(
    `mic frames: ${frames} · level ${level.toFixed(3)} (need ≥ ${MIN_RMS})` +
      ` · clarity ${pitch ? pitch.clarity.toFixed(2) : '–'} (need ≥ ${MIN_CLARITY})`,
  )

  if (pitch && pitch.clarity >= MIN_CLARITY) {
    const note = freqToNote(pitch.freq)
    advanceIfCorrect(note.midi, note.cents)
    lastHeard = now
    if (note.name === shownNote || note.name === candidate) {
      // Smooth in cents, and start fresh on a note change so A and A# never
      // get averaged together.
      smoothCents =
        note.name === shownNote && smoothCents !== null
          ? smoothCents + CENTS_SMOOTHING * (note.cents - smoothCents)
          : note.cents
      shownNote = note.name
      setNote(note.name, Math.round(smoothCents), `${note.name}${note.octave} · ${pitch.freq.toFixed(1)} Hz`)
    }
    candidate = note.name
  } else if (shownNote !== null && now - lastHeard > HOLD_MS) {
    shownNote = null
    candidate = null
    smoothCents = null
    setNote(null)
  }

  currentContent = tunerText(shownNote, smoothCents === null ? null : Math.round(smoothCents))
  scheduleGlassesRender()
}

await bridge.audioControl(true)
let micOn = true
setStatus('listening', 'Listening · tap to pause · double-tap to exit')

// Tap toggles capture. `audioControl(false)` stops the host pushing PCM.
function toggleMic() {
  micOn = !micOn
  bridge.audioControl(micOn)
  if (!micOn) {
    shownNote = null
    candidate = null
    smoothCents = null
    setNote(null)
  }
  currentContent = micOn ? IDLE_TEXT : pausedText()
  scheduleGlassesRender()
  setStatus(
    micOn ? 'listening' : 'paused',
    micOn ? 'Listening · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
  )
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge.audioControl(false)
  unsubscribe()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all — and in this app
// that means every incoming audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing, critical details:
//   • Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Audio PCM frames come through `event.audioEvent` — separate branch.
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm && micOn) {
    pushPcm(pcm)
    analyze()
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    toggleMic()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
