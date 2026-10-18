// Display writes that never pile up.
//
// Real glasses take a while to apply each write over Bluetooth (the
// simulator is instant). Firing writes faster than that queues them up, and
// the screen falls further and further behind, so a restart can take ages to
// show. A LatestWriter keeps at most one write in flight; anything requested
// meanwhile replaces the waiting value, so only the newest content is sent.

/** Stop waiting on a write that never answers after this long. */
const STUCK_MS = 5000

export class LatestWriter<T> {
  private inFlight = false
  private pending: { value: T } | null = null
  private last: T | undefined

  constructor(
    private readonly send: (value: T) => Promise<unknown>,
    private readonly name: string,
    /** Pause after each write, leaving Bluetooth time for other boxes. */
    private readonly gapMs = 0,
  ) {}

  write(value: T) {
    this.pending = { value }
    void this.pump()
  }

  private async pump() {
    if (this.inFlight || !this.pending) return
    const { value } = this.pending
    this.pending = null
    if (value === this.last) return
    this.inFlight = true
    let timer = 0
    try {
      await Promise.race([
        this.send(value),
        new Promise<void>(resolve => {
          timer = window.setTimeout(() => {
            console.warn(`${this.name}: write took over ${STUCK_MS} ms, moving on`)
            resolve()
          }, STUCK_MS)
        }),
      ])
      this.last = value
    } catch (err) {
      console.warn(`${this.name}: write failed`, err)
    } finally {
      clearTimeout(timer)
      if (this.gapMs) await new Promise(r => setTimeout(r, this.gapMs))
      this.inFlight = false
      void this.pump()
    }
  }
}
