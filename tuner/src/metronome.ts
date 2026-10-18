// Count-in: "1 2 3 4" on the beat before the player starts.
//
// Clicks play on the phone (the glasses have no speaker) and are scheduled
// on the Web Audio clock, so they're sample-accurate. Visual beats use
// timers aimed at absolute times, so they don't drift. Clicks only happen
// during the count-in, never while the mic is grading the player.

let ctx: AudioContext | null = null

/** Browsers only allow audio after a user gesture on the page. Call this from
 *  a tap on the phone screen; until then the count-in is visual only. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    ctx = null
  }
}

function scheduleClick(at: number, accent: boolean) {
  if (!ctx || ctx.state !== 'running') return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = accent ? 1600 : 1000
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.6, at + 0.002)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
  osc.connect(gain).connect(ctx.destination)
  osc.start(at)
  osc.stop(at + 0.06)
}

export class CountIn {
  private timers: number[] = []

  /**
   * Counts `beats` beats at `bpm`. `onBeat(n)` fires on each beat (1-based);
   * `onDone` fires one beat after the last count — the moment to start playing.
   */
  start(bpm: number, beats: number, onBeat: (n: number) => void, onDone: () => void) {
    this.cancel()
    unlockAudio()
    const beatMs = 60000 / bpm
    const t0 = performance.now() + 100 // small lead so beat 1 isn't clipped
    const audioT0 = ctx ? ctx.currentTime + 0.1 : 0
    for (let i = 0; i < beats; i++) {
      scheduleClick(audioT0 + (i * beatMs) / 1000, i === 0)
      this.at(t0 + i * beatMs, () => onBeat(i + 1))
    }
    this.at(t0 + beats * beatMs, onDone)
  }

  cancel() {
    this.timers.forEach(clearTimeout)
    this.timers = []
  }

  private at(time: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, Math.max(0, time - performance.now())))
  }
}
