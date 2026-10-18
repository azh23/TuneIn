// Count-in: "1 2 3 4" on the beat before the player starts. Visual only —
// beats are timers aimed at absolute times, so they don't drift.

export class CountIn {
  private timers: number[] = []

  /**
   * Counts `beats` beats at `bpm`. `onBeat(n)` fires on each beat (1-based);
   * `onDone` fires one beat after the last count — the moment to start playing.
   * If `onPlayBeat` is given, beats keep coming on the same grid after that
   * with `n` = position in the bar (1..beats), until `cancel()`.
   */
  start(
    bpm: number,
    beats: number,
    onBeat: (n: number) => void,
    onDone: () => void,
    onPlayBeat?: (n: number) => void,
  ) {
    this.cancel()
    const beatMs = 60000 / bpm
    const t0 = performance.now() + 100 // small lead before beat 1
    for (let i = 0; i < beats; i++) this.at(t0 + i * beatMs, () => onBeat(i + 1))
    // Each play beat schedules the next one, always aimed at t0 + k·beat so
    // timer lateness never accumulates.
    const playBeat = (k: number) => {
      this.at(t0 + k * beatMs, () => {
        if (k === beats) onDone()
        onPlayBeat?.(((k - beats) % beats) + 1)
        if (onPlayBeat) playBeat(k + 1)
      })
    }
    playBeat(beats)
  }

  cancel() {
    this.timers.forEach(clearTimeout)
    this.timers = []
  }

  private at(time: number, fn: () => void) {
    // Drop timers that already fired so the list doesn't grow while playing.
    this.timers = this.timers.slice(-8)
    this.timers.push(window.setTimeout(fn, Math.max(0, time - performance.now())))
  }
}
