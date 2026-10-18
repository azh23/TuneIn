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
import { BOX_W, BOX_PAD, BEAT_BOX_W, STATS_BOX_W, statsText, tunerText, countInText, resultsText, beatText, bufferText } from './glasses'
import { SheetDisplay, sheetBox } from './sheet'
import { Session, applySession, loadProgress, saveProgress, type Summary } from './scoring'
import { midiName } from './pitch/notes'
import { CountIn } from './metronome'
import { LatestWriter } from './writer'
import { byId } from './instruments'
import { toSounding, type PracticeExercise } from './generator'
import { ExerciseQueue, bridgeStorage, loadInstrument } from './queue'
import { buildQueueWithAgent } from './creao'
import { applyRun, initialLevel, scorePercent, PASS_AT, MAX_TRIES, type LevelState } from './leveling'
import { PROXY_URL, CREAO_KEY, CREAO_APP_ID, DEFAULT_INSTRUMENT, BUFFER_MAX_MS } from './config'

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

// Full-width box, vertically centered: four 27 px lines (feedback, note, scale, cents).
const BOX_H = 4 * 27 + 2 * BOX_PAD
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

// Top-left corner (left of the staff image): level and best score.
const statsBox = new TextContainerProperty({
  xPosition: 4,
  yPosition: 4,
  width: STATS_BOX_W,
  height: 2 * 27 + 2 * BOX_PAD,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: BOX_PAD,
  containerID: 4,
  containerName: 'stats',
  content: ' ',
  isEventCapture: 0,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 4,
    textObject: [noteBox, beatBox, statsBox],
    imageObject: [sheetBox],
  }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

// One write in flight per text box, newest content wins (see writer.ts).
const textWriter = (containerID: number, containerName: string, gapMs = 0) =>
  new LatestWriter<string>(
    content => bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content })),
    containerName,
    gapMs,
  )
// The tuner text changes every audio frame; a short gap after each write
// keeps it from hogging the link the beat dots and sheet image also need.
const noteWriter = textWriter(1, 'note', 150)
const beatWriter = textWriter(3, 'beat')
const statsWriter = textWriter(4, 'stats')

// ── Instrument, exercise queue, level ────────────────────────────────────
const storage = bridgeStorage(bridge)
// The speech step saves the instrument with saveInstrument(); until then use the default.
const INSTRUMENT = (await loadInstrument(storage)) ?? byId(DEFAULT_INSTRUMENT) ?? byId('voice')!

const LEVEL_KEY = 'tunein.level.v1'
async function loadLevel(): Promise<LevelState> {
  try {
    const raw = await storage.get(LEVEL_KEY)
    if (raw) {
      const v = JSON.parse(raw) as LevelState
      if (Number.isFinite(v.level)) return { level: v.level, upStreak: v.upStreak | 0, downStreak: v.downStreak | 0 }
    }
  } catch {}
  return initialLevel()
}
const saveLevel = () => void storage.set(LEVEL_KEY, JSON.stringify(levelState))

// Buffer screen: stock the queue (and ask the agent) before the first exercise.
const bufferMs = (ms: number) => {
  const text = bufferText(Math.round(ms / 1000), Math.round(BUFFER_MAX_MS / 1000))
  noteWriter.write(text)
}
setStatus('paused', 'Getting your music ready…')
if (created === 0) bufferMs(0)
let queue: ExerciseQueue
if (PROXY_URL || CREAO_KEY) {
  const built = await buildQueueWithAgent(INSTRUMENT, storage, {
    proxyUrl: PROXY_URL,
    direct: !PROXY_URL && CREAO_KEY ? { key: CREAO_KEY, appId: CREAO_APP_ID } : undefined,
    maxWaitMs: BUFFER_MAX_MS,
    onBuffering: ms => bufferMs(ms),
  })
  queue = built.queue
} else {
  queue = (await ExerciseQueue.load(storage, INSTRUMENT.id)) ?? (await ExerciseQueue.create(INSTRUMENT, storage))
}
let levelState = await loadLevel()

// Best score (percent) per exercise id.
const BEST_KEY = 'tunein.best.v1'
async function loadBest(): Promise<Record<string, number>> {
  try {
    const raw = await storage.get(BEST_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return {}
}
const best = await loadBest()
const saveBest = () => void storage.set(BEST_KEY, JSON.stringify(best))

// ── Sheet music + scoring ────────────────────────────────────────────────
// The exercise stays the same until a run passes (PASS_AT); see finishSession.
let EXERCISE: PracticeExercise = queue.next(levelState.level)
let tries = 0 // misses on this exercise so far
bpm = EXERCISE.tempoBpm
// The staff shows written pitch; the mic hears sounding pitch (trumpet, sax…).
// Match pitch class only while testing with voice (lower voices sing the
// scale an octave down). Set false to require the written octave.
const IGNORE_OCTAVE = true
// ready → (tap) → countIn → playing → results → (tap) → countIn …
type Phase = 'ready' | 'countIn' | 'playing' | 'results'
let phase: Phase = 'ready'
let passed = false
const newSession = () => new Session(toSounding(EXERCISE), IGNORE_OCTAVE, bpm === null ? undefined : 60000 / bpm)
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
  const { notes, key, timeSig } = EXERCISE
  sheet.show(notes, { key, timeSig, showTimeSig: true, current: session.marker, currentHeld: session.holding, letters: true })
  setProgress(progress, session.marker, notes.length)
}
if (created === 0) drawSheet()

/** Corner stats for the exercise that's up next. Changes only between runs. */
function showStats() {
  statsWriter.write(statsText(levelState.level, best[EXERCISE.id]))
}
if (created === 0) showStats()
else setProgress(progress, session.step, EXERCISE.notes.length)

function finishSession() {
  const s = session.summary()
  progress = applySession(progress, s)
  void saveProgress(bridge, progress)
  countIn.cancel()
  showBeat(null)

  const runText = lastRunText(s) // before EXERCISE can change
  const pct = scorePercent(s.points, EXERCISE.notes.length)
  passed = pct >= PASS_AT
  // "New best" only when beating an earlier score, not on the first try.
  const prevBest = best[EXERCISE.id]
  const newBest = prevBest !== undefined && Math.round(pct * 100) > prevBest
  if (prevBest === undefined || Math.round(pct * 100) > prevBest) {
    best[EXERCISE.id] = Math.round(pct * 100)
    saveBest()
  }
  const before = levelState.level
  const run = applyRun(levelState, pct)
  levelState = run.state
  let footer = ''
  if (passed) {
    tries = 0
    void queue.markSeen(EXERCISE.id)
    footer = run.change === 'up' ? `Level up! Now level ${levelState.level}` : `Passed · ${Math.round(pct * 100)}% · tap for next`
  } else {
    tries++
    if (tries >= MAX_TRIES && levelState.level > 1 && run.change !== 'down') {
      levelState = { level: levelState.level - 1, upStreak: 0, downStreak: 0 }
      footer = `Let's try something easier`
    } else if (run.change === 'down') footer = `Back to level ${levelState.level} for now`
    else footer = `${Math.round(pct * 100)}% · need ${Math.round(PASS_AT * 100)}% · tap to retry (${tries}/${MAX_TRIES})`
  }
  saveLevel()
  // Move on only after a pass, or when the level dropped (nothing easier to retry otherwise).
  if (passed || levelState.level !== before) {
    EXERCISE = queue.next(levelState.level)
    tries = 0
    bpm = EXERCISE.tempoBpm
  }
  const headline = `${passed ? 'Passed!' : 'Not yet'}  +${s.points} pts${newBest ? '  ·  new best!' : ''}`
  resultsContent = resultsText(s, headline, footer)
  showStats()
  setLastRun(`${runText} · ${Math.round(pct * 100)}% · ${footer} · level ${levelState.level}`)
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
  ready: () => `Level ${levelState.level} · ready · ${tempoLabel()} · tap to start · swipe to change tempo · double-tap to exit`,
  countIn: () => 'Count-in… · tap to cancel',
  playing: () => 'Playing · tap to stop · double-tap to restart',
  results: () => (passed ? `Passed · tap for the next exercise · ${tempoLabel()}` : `Not yet · tap to retry · ${tempoLabel()}`),
}

function setPhase(p: Phase) {
  phase = p
  setStatus(p === 'countIn' || p === 'playing' ? 'listening' : 'paused', HINTS[p]())
}

/** Show beat `n` of the bar in the corner (glasses + phone); null clears it. */
function showBeat(n: number | null) {
  const beats = EXERCISE.timeSig[0]
  setBeat(n, beats)
  beatWriter.write(beatText(n, beats))
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
    updateGlassesText()
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
      updateGlassesText()
    },
    () => {
      setPhase('playing')
      updateGlassesText()
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

/** Show the text-box content for the current phase on the glasses. */
function updateGlassesText() {
  const cents = smoothCents === null ? null : Math.round(smoothCents)
  noteWriter.write(
    phase === 'results' ? resultsContent
    : phase === 'countIn' ? countInContent
    : tunerText(shownNote, cents, phase === 'ready' ? readyHint() : 'Play a note'),
  )
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
updateGlassesText()

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
