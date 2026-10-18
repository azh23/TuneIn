type Status = 'connecting' | 'listening' | 'paused' | 'error'

let statusEl: HTMLDivElement
let noteEl: HTMLDivElement
let detailEl: HTMLDivElement
let debugEl: HTMLDivElement
let needleEl: HTMLDivElement
let centsEl: HTMLDivElement
let progressEl: HTMLElement

export function mountUi() {
  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>Tuner</h1>
        <div id="status" class="status status-connecting">Connecting…</div>
      </header>
      <section class="readout" aria-live="polite">
        <div id="note" class="note idle">–</div>
        <div class="meter">
          <span class="flat">♭</span>
          <div class="track">
            <div class="zone"></div>
            <div class="center"></div>
            <div id="needle" class="needle hidden"></div>
          </div>
          <span class="sharp">♯</span>
        </div>
        <div id="cents" class="cents"></div>
        <div id="detail" class="detail">Play or sing a note</div>
      </section>
      <section id="progress" class="progress" aria-live="polite"></section>
      <div id="debug" class="debug">mic: no audio yet</div>
      <footer>Tap the glasses temple to pause · double-tap to restart (twice to exit).</footer>
    </main>
  `
  statusEl = app.querySelector<HTMLDivElement>('#status')!
  noteEl = app.querySelector<HTMLDivElement>('#note')!
  detailEl = app.querySelector<HTMLDivElement>('#detail')!
  debugEl = app.querySelector<HTMLDivElement>('#debug')!
  needleEl = app.querySelector<HTMLDivElement>('#needle')!
  centsEl = app.querySelector<HTMLDivElement>('#cents')!
  progressEl = app.querySelector<HTMLElement>('#progress')!
  injectStyles()
}

export function setStatus(kind: Status, text: string) {
  if (!statusEl) return
  statusEl.className = `status status-${kind}`
  statusEl.textContent = text
}

const IN_TUNE_CENTS = 5

/** Pass null to show the idle state. `cents` is -50..+50 from the note. */
export function setNote(name: string | null, cents = 0, detail = '') {
  if (!noteEl) return
  const inTune = name !== null && Math.abs(cents) <= IN_TUNE_CENTS
  noteEl.textContent = name ?? '–'
  noteEl.classList.toggle('idle', name === null)
  noteEl.classList.toggle('in-tune', inTune)
  needleEl.classList.toggle('hidden', name === null)
  needleEl.classList.toggle('in-tune', inTune)
  needleEl.style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`
  centsEl.textContent =
    name === null ? '' : inTune ? 'in tune' : cents > 0 ? `+${cents}¢ sharp` : `${cents}¢ flat`
  detailEl.textContent = name === null ? 'Play or sing a note' : detail
}

/** Practice progress shown under the tuner: where you are in the scale, points, streak. */
export function setProgress(p: { points: number; streak: number; lastPoints: number | null }, step: number, total: number) {
  if (!progressEl) return
  const cell = (label: string, value: string) =>
    `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`
  progressEl.innerHTML =
    cell('Note', `${Math.min(step + 1, total)} / ${total}`) +
    cell('Points', String(p.points)) +
    cell('Streak', `${p.streak} day${p.streak === 1 ? '' : 's'}`) +
    cell('Last run', p.lastPoints === null ? '–' : `+${p.lastPoints}`)
}

// Temporary mic diagnostics; remove once pitch detection is confirmed working.
export function setDebug(text: string) {
  if (debugEl) debugEl.textContent = text
}

function injectStyles() {
  // ER brand dark-theme surfaces: #232323 / #2E2E2E / #3E3E3E.
  // ER OS green (#3CFA44) + signal red (#FF453A) for state chips.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening  { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,0.08); }
    .status-paused     { color: #E5E5E5; border-color: #7B7B7B; background: rgba(229,229,229,0.06); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .readout { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 20px;
      min-height: 220px; }
    .note { font-size: 120px; font-weight: 600; line-height: 1; color: #E5E5E5;
      font-variant-numeric: tabular-nums; }
    .note.idle { color: #5A5A5A; }
    .note.in-tune { color: #3CFA44; }
    .meter { display: flex; align-items: center; gap: 12px; width: 100%; max-width: 420px; margin-top: 24px; }
    .flat, .sharp { font-size: 20px; color: #919191; }
    .track { position: relative; flex: 1; height: 36px; border-bottom: 2px solid #5A5A5A; }
    .zone { position: absolute; left: 45%; width: 10%; top: 0; bottom: 0; background: rgba(60,250,68,0.10); }
    .center { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #7B7B7B; }
    .needle { position: absolute; top: 0; bottom: 0; width: 4px; margin-left: -2px; border-radius: 2px;
      background: #FF9F0A; transition: left 120ms ease-out; }
    .needle.in-tune { background: #3CFA44; }
    .needle.hidden { display: none; }
    .cents { margin-top: 12px; min-height: 22px; font-size: 18px; color: #E5E5E5; font-variant-numeric: tabular-nums; }
    .detail { margin-top: 12px; font-size: 14px; color: #919191; font-variant-numeric: tabular-nums; }
    .progress { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .stat { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px 8px; text-align: center; }
    .stat-value { font-size: 20px; font-weight: 600; color: #3CFA44; font-variant-numeric: tabular-nums; }
    .stat-label { margin-top: 4px; font-size: 11px; color: #919191; letter-spacing: 0.04em; text-transform: uppercase; }
    .debug { font: 12px/1.4 ui-monospace, Menlo, monospace; color: #A7A7A7; text-align: center; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
