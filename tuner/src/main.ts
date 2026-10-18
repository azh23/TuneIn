import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { detectPitch, rms } from './pitch/detector'
import { freqToNote } from './pitch/notes'
import { mountUi, setStatus, setNote, setDebug, setProgress, setLastRun, setBeat } from './ui'
import { BOX_W, BOX_PAD, BEAT_BOX_W, tunerText, countInText, resultsText, beatText } from './glasses'
import { SheetDisplay, sheetBox } from './sheet'
import { RHYTHM_TEST } from './exercises'
import { Session, applySession, loadProgress, saveProgress, type Summary } from './scoring'
import { midiName } from './pitch/notes'
import { CountIn } from './metronome'

const SAMPLE_RATE = 16000 // G2 mic: PCM s16le @ 16 kHz mono
const WINDOW = 2048 // ~128 ms; covers 2+ periods down to ~60 Hz
// Hysteresis: strict to lock onto a new note, lenient to keep one, so a
// sustained note that wavers or fades doesn't drop out halfway through.
const ACQUIRE_RMS = 0.01
const ACQUIRE_CLARITY = 0.85
const SUSTAIN_RMS = 0.004
const SUSTAIN_CLARITY = 0.6
const HOLD_MS = 1000 // keep the last note on screen briefly after the sound stops
const CENTS_SMOOTHING = 0.35 // EMA weight of the newest reading; lower is steadier
const COUNT_IN_BEATS = 4
const BPM_STEP = 5
const BPM_MIN = 40
const BPM_MAX = 160
// null = free tempo: no count-in or beat, and rhythm is graded on note
// proportions at whatever tempo the player picks. It sits one step below
// BPM_MIN on the swipe scale: … 45 · 40 · Free.
let bpm: number | null = 60
const tempoLabel = () => (bpm === null ? 'free tempo' : `${bpm} bpm`)
const readyHint = () => `Tap to start · ${tempoLabel()}`
const IDLE_TEXT = tunerText(null, null, readyHint())

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

// Small one-line box in the top-right corner (beside the staff image) that
// pulses the beat while playing.
const beatBox = new TextContainerProperty({
  xPosition: 576 - BEAT_BOX_W - 4,
  yPosition: 4,
  width: BEAT_BOX_W,
  height: 27 + 2 * BOX_PAD,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: BOX_PAD,
  containerID: 3,
  containerName: 'beat',
  content: ' ',
  isEventCapture: 0,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 3, textObject: [noteBox, beatBox], imageObject: [sheetBox] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

// ── Sheet music + scoring ────────────────────────────────────────────────
// The piece to practice. Swap in C_MAJOR_SCALE (or add your own in
// exercises.ts) to change it.
const EXERCISE = RHYTHM_TEST
// Match pitch class only while testing with voice (lower voices sing the
// scale an octave down). Set false to require the written octave.
const IGNORE_OCTAVE = true
// ready → (tap) → countIn → playing → results → (tap) → countIn …
type Phase = 'ready' | 'countIn' | 'playing' | 'results'
let phase: Phase = 'ready'
const newSession = () => new Session(EXERCISE.notes, IGNORE_OCTAVE, bpm === null ? undefined : 60000 / bpm)
let session = newSession()
let resultsContent = ''
let countInContent = ''
const countIn = new CountIn()
let progress = await loadProgress(bridge)

const sheet = new SheetDisplay(bridge)
sheet.onError = msg => setStatus('error', msg)

function drawSheet() {
  // The marker stays on a note while it's being held (filled) and moves on
  // when the next note starts. marker = notes.length dims every note (done).
  const { notes, key, timeSig, showTimeSig } = EXERCISE
  sheet.show(notes, { key, timeSig, showTimeSig, current: session.marker, currentHeld: session.holding, letters: true })
  setProgress(progress, session.marker, notes.length)
}
if (created === 0) drawSheet()
else setProgress(progress, session.step, EXERCISE.notes.length)

function finishSession() {
  const s = session.summary()
  progress = applySession(progress, s)
  void saveProgress(bridge, progress)
  countIn.cancel()
  showBeat(null)
  resultsContent = resultsText(s)
  setLastRun(lastRunText(s))
  setPhase('results')
}

function lastRunText(s: Summary): string {
  const r = s.rhythm
  const pts = `+${s.points} pts (pitch ${s.pitchPoints} + rhythm ${s.rhythmPoints}${s.perfect ? ' + perfect 20' : ''})`
  if (!r) return `${pts} · avg ${s.avgCents}¢ off · ${s.wrongNotes} wrong`
  let text = `${pts} · avg ${s.avgCents}¢ off · ${s.wrongNotes} wrong · rhythm ${r.score}% (played ~${r.bpm} BPM${bpm === null ? '' : `, target ${bpm}`})`
  if (r.worst !== null) {
    const n = r.notes[r.worst]
    const name = midiName(EXERCISE.notes[r.worst].midi)
    text += ` · ${name} held ${n.played.toFixed(1)} beats (written ${n.expected})`
  }
  return text
}

const HINTS: Record<Phase, () => string> = {
  ready: () => `Ready · ${tempoLabel()} · tap to start · swipe to change tempo · double-tap to exit`,
  countIn: () => 'Count-in… · tap to cancel',
  playing: () => 'Playing · tap to stop · double-tap to restart',
  results: () => `Done · tap to go again (${tempoLabel()}) · swipe to change tempo`,
}

function setPhase(p: Phase) {
  phase = p
  setStatus(p === 'countIn' || p === 'playing' ? 'listening' : 'paused', HINTS[p]())
}

let lastBeat = ' '
/** Show beat `n` of the bar in the corner (glasses + phone); null clears it.
 *  Sent right away, not debounced, so it lands on the beat. */
function showBeat(n: number | null) {
  const beats = EXERCISE.timeSig[0]
  setBeat(n, beats)
  const content = beatText(n, beats)
  if (content === lastBeat) return
  lastBeat = content
  void bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 3, containerName: 'beat', content }))
}

/** Back to the start: fresh run, waiting for a tap. */
function resetToReady() {
  countIn.cancel()
  showBeat(null)
  session = newSession()
  setLastRun(null)
  setPhase('ready')
  drawSheet()
  updateGlassesText()
}

function startCountIn() {
  session = newSession()
  setLastRun(null)
  drawSheet()
  if (bpm === null) {
    // Free tempo: no count-in, just start listening.
    setPhase('playing')
    updateGlassesText(true)
    return
  }
  const tempo = bpm
  setPhase('countIn')
  countIn.start(
    tempo,
    COUNT_IN_BEATS,
    n => {
      countInContent = countInText(n, COUNT_IN_BEATS, tempo)
      setStatus('listening', `Count-in · ${n}`)
      updateGlassesText(true)
    },
    () => {
      setPhase('playing')
      updateGlassesText(true)
    },
    n => showBeat(n),
  )
}

function changeTempo(delta: number) {
  if (bpm === null) bpm = delta > 0 ? BPM_MIN : null
  else if (bpm + delta < BPM_MIN) bpm = null
  else bpm = Math.min(BPM_MAX, bpm + delta)
  session = newSession() // the tempo is baked into grading
  setStatus('paused', HINTS[phase]())
  updateGlassesText()
}

function onPitch(midi: number, cents: number, now: number) {
  if (phase !== 'playing') return
  if (session.feed(midi, cents, now)) onSessionChange()
}

function onSessionChange() {
  if (session.done) finishSession()
  drawSheet()
}

let lastRender = IDLE_TEXT
let renderTimer: number | null = null
let currentContent = IDLE_TEXT

function renderGlasses() {
  if (currentContent === lastRender) return
  lastRender = currentContent
  void bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'note',
      content: currentContent,
    }),
  )
}

function scheduleGlassesRender() {
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(() => {
    renderTimer = null
    renderGlasses()
  }, 120) // debounce display writes — BLE render queue is slow
}

/** Pick the text-box content for the current phase. `now` skips the debounce
 *  (count-in beats should land on time). */
function updateGlassesText(now = false) {
  const cents = smoothCents === null ? null : Math.round(smoothCents)
  currentContent =
    phase === 'results' ? resultsContent
    : phase === 'countIn' ? countInContent
    : tunerText(shownNote, cents, phase === 'ready' ? readyHint() : 'Play a note')
  if (now) {
    if (renderTimer !== null) clearTimeout(renderTimer)
    renderTimer = null
    renderGlasses()
  } else scheduleGlassesRender()
}

// Sliding window of the most recent WINDOW samples, as floats in [-1, 1].
const window_ = new Float32Array(WINDOW)

// Audio clock: milliseconds of audio received so far. Rhythm timing uses this
// instead of wall-clock time, so Bluetooth delivery jitter doesn't skew it.
let audioMs = 0

function pushPcm(chunk: Uint8Array) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  const n = Math.floor(chunk.byteLength / 2)
  audioMs += (n / SAMPLE_RATE) * 1000
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
  const minRms = shownNote === null ? ACQUIRE_RMS : SUSTAIN_RMS
  const minClarity = shownNote === null ? ACQUIRE_CLARITY : SUSTAIN_CLARITY
  const raw = level >= minRms ? detectPitch(window_, { sampleRate: SAMPLE_RATE }) : null
  // While sustaining, only the current note may pass the lenient gate; a
  // different note still has to meet the strict one.
  const rawNote = raw && freqToNote(raw.freq).name
  const gate = rawNote !== null && rawNote === shownNote ? minClarity : ACQUIRE_CLARITY
  const pitch = raw && raw.clarity >= gate ? raw : null
  frames++
  setDebug(
    `mic frames: ${frames} · level ${level.toFixed(3)} (need ≥ ${minRms})` +
      ` · clarity ${raw ? raw.clarity.toFixed(2) : '–'} (need ≥ ${minClarity})`,
  )

  if (!pitch && phase === 'playing' && session.silence(audioMs)) onSessionChange()
  if (pitch) {
    const note = freqToNote(pitch.freq)
    onPitch(note.midi, note.cents, audioMs)
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

  updateGlassesText()
}

// The mic stays on in every phase: the tuner works while you're getting
// ready, and only the playing phase feeds the grader.
await bridge.audioControl(true)
setPhase('ready')

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  countIn.cancel()
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
//   • Tap = start (count-in) / stop. Swipe up/down = tempo ±5 BPM when not
//     playing; one step below the minimum is free tempo (no metronome).
//   • Double-tap goes back to ready. When already ready it calls
//     `shutDownPageContainer(1)` instead, so double-tapping twice always
//     exits. It's a root-level check: it must fire no matter which envelope
//     the event arrives in. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    pushPcm(pcm)
    analyze()
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    // Back to ready; if already ready there's nothing to restart, so exit.
    if (phase !== 'ready') resetToReady()
    else bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    if (phase === 'ready' || phase === 'results') startCountIn()
    else resetToReady() // tap during count-in or playing = stop
    return
  }

  const up = sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT
  const down = sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  if ((up || down) && (phase === 'ready' || phase === 'results')) {
    changeTempo(up ? BPM_STEP : -BPM_STEP)
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)
