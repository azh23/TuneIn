// Staff renderer for the G2 display.
//
// Draws light-on-dark (black = see-through on the glasses) onto any
// CanvasRenderingContext2D, then quantizes to 16 grey levels.
// Size budget from the workshop slide: 288x144, 4-bit greyscale.

export const W = 288
export const H = 144

export interface StaffNote {
  midi: number // 60 = middle C
  beats: number // 0.5, 1, 2 or 4 (quarter note = 1)
}

export interface RenderOptions {
  key?: number // + = number of sharps, - = number of flats (0 = C major / A minor)
  timeSig?: [number, number] // shown only when showTimeSig is true
  showTimeSig?: boolean
  current?: number // index of the note to play now (bright + marker)
  // Notes before `current` are drawn dim, notes after are drawn bright.
  letters?: boolean // draw note names under the staff (good for beginners)
  barsPerPage?: number // purely informational, used for the bar line count
}

// Brightness levels (0-15), mapped to the display's 16 green levels.
const LV = { off: 0, staff: 7, dim: 6, note: 15, marker: 15, text: 11 }

const SP = 10 // staff space (px between lines)
const STAFF_BOTTOM = 96 // y of the bottom line (E4)
const E4_DIA = 30 // diatonic index: octave*7 + letter(C=0..B=6)
const HEAD_RX = 6.2
const HEAD_RY = 4.4
const STEM_LEN = 30

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const SHARP_SPELL: [number, number][] = [ // pc -> [letter, acc]
  [0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0],
]
const FLAT_SPELL: [number, number][] = [
  [0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0],
]
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6] // F C G D A E B (letter indices)
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3] // B E A D G C F
const SHARP_DIA = [38, 35, 39, 36, 33, 37, 34] // treble staff positions
const FLAT_DIA = [34, 37, 33, 36, 32, 35, 31]

interface Spelled { dia: number; acc: number; letter: string }

function keyAccidentals(key: number): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < Math.abs(key); i++) {
    m.set(key > 0 ? SHARP_ORDER[i] : FLAT_ORDER[i], key > 0 ? 1 : -1)
  }
  return m
}

function spell(midi: number, key: number): Spelled {
  const pc = ((midi % 12) + 12) % 12
  const octave = Math.floor(midi / 12) - 1
  const table = key < 0 ? FLAT_SPELL : SHARP_SPELL
  const [letterIdx, acc] = table[pc]
  let oct = octave
  // Cb / B# edge cases are not needed for the scales we generate.
  return { dia: oct * 7 + letterIdx, acc, letter: LETTERS[letterIdx] }
}

const yOf = (dia: number) => STAFF_BOTTOM - ((dia - E4_DIA) * SP) / 2
const grey = (level: number) => {
  const v = Math.round((level / 15) * 255)
  return `rgb(${v},${v},${v})`
}

type Ctx = CanvasRenderingContext2D

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, w: number, level: number) {
  ctx.strokeStyle = grey(level)
  ctx.lineWidth = w
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
}

function drawStaffLines(ctx: Ctx, x1: number, x2: number) {
  for (let i = 0; i < 5; i++) line(ctx, x1, STAFF_BOTTOM - i * SP, x2, STAFF_BOTTOM - i * SP, 1.6, LV.staff)
}

// Simple geometric treble clef (no font dependency).
function drawTrebleClef(ctx: Ctx, x: number) {
  const gY = STAFF_BOTTOM - SP // G line
  const u = SP
  const X = (v: number) => x + v * u
  const Y = (v: number) => gY - v * u // v>0 is up
  ctx.strokeStyle = grey(LV.note)
  ctx.lineWidth = 2.1
  ctx.lineCap = 'round'
  ctx.beginPath()
  // main stroke: bottom hook -> up the stem -> top loop -> back down around G
  ctx.moveTo(X(-0.55), Y(-1.65))
  ctx.bezierCurveTo(X(-0.2), Y(-2.35), X(0.75), Y(-2.2), X(0.7), Y(-1.4))
  ctx.bezierCurveTo(X(0.65), Y(-0.6), X(0.25), Y(0.1), X(0.0), Y(1.2))
  ctx.bezierCurveTo(X(-0.35), Y(2.6), X(-0.4), Y(3.9), X(0.25), Y(4.1))
  ctx.bezierCurveTo(X(0.85), Y(4.1), X(1.0), Y(2.9), X(0.45), Y(1.8))
  ctx.bezierCurveTo(X(0.0), Y(1.0), X(-1.15), Y(0.45), X(-1.0), Y(-0.45))
  ctx.bezierCurveTo(X(-0.9), Y(-1.1), X(-0.2), Y(-1.2), X(0.2), Y(-0.9))
  ctx.bezierCurveTo(X(0.6), Y(-0.6), X(0.7), Y(0.25), X(0.25), Y(0.55))
  ctx.bezierCurveTo(X(-0.05), Y(0.75), X(-0.45), Y(0.55), X(-0.35), Y(0.15))
  ctx.stroke()
  // small dot at the bottom of the hook
  ctx.fillStyle = grey(LV.note)
  ctx.beginPath(); ctx.arc(X(-0.5), Y(-1.7), 1.4, 0, Math.PI * 2); ctx.fill()
}

function drawSharp(ctx: Ctx, x: number, y: number, level: number) {
  line(ctx, x - 2, y - 7, x - 2, y + 8, 1.2, level)
  line(ctx, x + 2, y - 8, x + 2, y + 7, 1.2, level)
  line(ctx, x - 5, y - 1.5, x + 5, y - 3.5, 2.2, level)
  line(ctx, x - 5, y + 3.5, x + 5, y + 1.5, 2.2, level)
}

function drawFlat(ctx: Ctx, x: number, y: number, level: number) {
  line(ctx, x - 2, y - 10, x - 2, y + 4, 1.4, level)
  ctx.strokeStyle = grey(level)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(x - 2, y + 4)
  ctx.bezierCurveTo(x + 6, y, x + 6, y - 7, x - 2, y - 3)
  ctx.stroke()
}

function drawNatural(ctx: Ctx, x: number, y: number, level: number) {
  line(ctx, x - 2.5, y - 8, x - 2.5, y + 3, 1.2, level)
  line(ctx, x + 2.5, y - 3, x + 2.5, y + 8, 1.2, level)
  line(ctx, x - 2.5, y - 2.5, x + 2.5, y - 4, 2, level)
  line(ctx, x - 2.5, y + 4, x + 2.5, y + 2.5, 2, level)
}

function drawAcc(ctx: Ctx, acc: number, x: number, y: number, level: number) {
  if (acc > 0) drawSharp(ctx, x, y, level)
  else if (acc < 0) drawFlat(ctx, x, y, level)
  else drawNatural(ctx, x, y, level)
}

function drawKeySignature(ctx: Ctx, key: number, x: number): number {
  const n = Math.abs(key)
  for (let i = 0; i < n; i++) {
    const dia = key > 0 ? SHARP_DIA[i] : FLAT_DIA[i]
    drawAcc(ctx, key > 0 ? 1 : -1, x + i * 9, yOf(dia), LV.note)
  }
  return n * 9
}

function durationSpace(beats: number): number {
  if (beats <= 0.5) return 18
  if (beats <= 1) return 28
  if (beats <= 2) return 44
  return 72
}

interface Placed { note: StaffNote; sp: Spelled; x: number; idx: number; showAcc: number | null }

/** Lay notes out left to right. Returns null if they do not fit. */
function layout(notes: StaffNote[], key: number, startX: number, endX: number, barBeats: number) {
  const keyAcc = keyAccidentals(key)
  const barXs: number[] = []
  const placed: Placed[] = []
  const naturalWidths = notes.map(n => durationSpace(n.beats))
  const total = naturalWidths.reduce((a, b) => a + b, 0)
  const barCount = Math.max(1, Math.round(notes.reduce((a, n) => a + n.beats, 0) / barBeats))
  const avail = endX - startX - 10 - (barCount - 1) * 8
  let scale = Math.min(1.5, avail / total)
  const minSpace = HEAD_RX * 2 + 4
  if (naturalWidths.some(w => w * scale < minSpace)) return null
  let x = startX + 12
  let beatsInBar = 0
  const measureAcc = new Map<number, number>() // accidentals already shown this bar
  notes.forEach((note, idx) => {
    const sp = spell(note.midi, key)
    const letterIdx = LETTERS.indexOf(sp.letter)
    const impliedByKey = keyAcc.get(letterIdx) ?? 0
    const key2 = sp.dia
    const current = measureAcc.has(key2) ? measureAcc.get(key2)! : impliedByKey
    let showAcc: number | null = null
    if (sp.acc !== current) { showAcc = sp.acc; measureAcc.set(key2, sp.acc) }
    placed.push({ note, sp, x: x + HEAD_RX, idx, showAcc })
    x += durationSpace(note.beats) * scale
    beatsInBar += note.beats
    if (beatsInBar >= barBeats - 1e-6 && idx < notes.length - 1) {
      beatsInBar = 0
      x += 4
      barXs.push(x - 2)
      x += 4
      measureAcc.clear()
    }
  })
  return { placed, barXs, endX: x }
}

function drawNote(ctx: Ctx, p: Placed, level: number, stemDown: boolean, withStem: boolean) {
  const y = yOf(p.sp.dia)
  const { beats } = p.note
  // ledger lines
  if (p.sp.dia <= 28) for (let d = 28; d >= p.sp.dia; d -= 2) line(ctx, p.x - 10, yOf(d), p.x + 10, yOf(d), 1.6, LV.staff + 2)
  if (p.sp.dia >= 40) for (let d = 40; d <= p.sp.dia; d += 2) line(ctx, p.x - 10, yOf(d), p.x + 10, yOf(d), 1.6, LV.staff + 2)
  // accidental
  if (p.showAcc !== null) drawAcc(ctx, p.showAcc, p.x - 15, y, level)
  // head
  ctx.save()
  ctx.translate(p.x, y)
  ctx.rotate(-0.35)
  ctx.beginPath()
  ctx.ellipse(0, 0, HEAD_RX, HEAD_RY, 0, 0, Math.PI * 2)
  if (beats >= 2) { ctx.strokeStyle = grey(level); ctx.lineWidth = 2.2; ctx.stroke() }
  else { ctx.fillStyle = grey(level); ctx.fill() }
  ctx.restore()
  // stem
  if (withStem && beats < 4) {
    const sx = stemDown ? p.x - HEAD_RX + 0.8 : p.x + HEAD_RX - 0.8
    line(ctx, sx, y, sx, stemDown ? y + STEM_LEN : y - STEM_LEN, 1.8, level)
  }
}

export function renderStaff(ctx: Ctx, notes: StaffNote[], opts: RenderOptions = {}): { ok: boolean; reason?: string } {
  const key = opts.key ?? 0
  const barBeats = (opts.timeSig ?? [4, 4])[0] * (4 / (opts.timeSig ?? [4, 4])[1])
  ctx.fillStyle = grey(LV.off)
  ctx.fillRect(0, 0, W, H)

  const clefX = 18
  drawStaffLines(ctx, 4, W - 4)
  drawTrebleClef(ctx, clefX)
  let x = clefX + 20
  x += drawKeySignature(ctx, key, x) + 4
  if (opts.showTimeSig) {
    const [n, d] = opts.timeSig ?? [4, 4]
    ctx.fillStyle = grey(LV.note)
    ctx.font = 'bold 22px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(String(n), x + 8, STAFF_BOTTOM - SP * 2 - 3)
    ctx.fillText(String(d), x + 8, STAFF_BOTTOM - 3 + 0)
    x += 20
  }

  const lay = layout(notes, key, x, W - 6, barBeats)
  if (!lay) return { ok: false, reason: 'too many notes for one image; use fewer bars per page' }

  const cur = opts.current ?? -1
  // beams: group consecutive eighth notes within the same beat pair
  const used = new Set<number>()
  let beatPos = 0
  const groups: number[][] = []
  let currentGroup: number[] = []
  notes.forEach((n, i) => {
    if (n.beats === 0.5) {
      currentGroup.push(i)
      if (currentGroup.length === 2 || (beatPos + n.beats) % 1 === 0) { groups.push(currentGroup); currentGroup = [] }
    } else if (currentGroup.length) { groups.push(currentGroup); currentGroup = [] }
    beatPos += n.beats
  })
  if (currentGroup.length) groups.push(currentGroup)

  const levelOf = (i: number) => (cur >= 0 && i < cur ? LV.dim : LV.note)

  for (const g of groups) {
    if (g.length < 2) continue
    const avgDia = g.reduce((a, i) => a + lay.placed[i].sp.dia, 0) / g.length
    const down = avgDia >= 34
    const pts = g.map(i => {
      const p = lay.placed[i]
      const y = yOf(p.sp.dia)
      return { p, i, sx: down ? p.x - HEAD_RX + 0.8 : p.x + HEAD_RX - 0.8, y }
    })
    const tip = down ? Math.max(...pts.map(q => q.y)) + STEM_LEN : Math.min(...pts.map(q => q.y)) - STEM_LEN
    pts.forEach(q => { drawNote(ctx, q.p, levelOf(q.i), down, false); line(ctx, q.sx, q.y, q.sx, tip, 1.8, levelOf(q.i)); used.add(q.i) })
    const first = pts[0], last = pts[pts.length - 1]
    line(ctx, first.sx, tip, last.sx, tip, 4, Math.min(levelOf(first.i), levelOf(last.i)))
  }

  lay.placed.forEach(p => {
    if (used.has(p.idx)) return
    const down = p.sp.dia >= 34
    drawNote(ctx, p, levelOf(p.idx), down, true)
    if (p.note.beats === 0.5) { // lone eighth: flag
      const sx = down ? p.x - HEAD_RX + 0.8 : p.x + HEAD_RX - 0.8
      const ty = yOf(p.sp.dia) + (down ? STEM_LEN : -STEM_LEN)
      line(ctx, sx, ty, sx + 8, ty + (down ? -10 : 10), 2.2, levelOf(p.idx))
    }
  })

  // bar lines + final bar line
  lay.barXs.forEach(bx => line(ctx, bx, STAFF_BOTTOM - 4 * SP, bx, STAFF_BOTTOM, 1.6, LV.staff + 3))
  const endBar = Math.min(lay.endX + 4, W - 6)
  line(ctx, endBar, STAFF_BOTTOM - 4 * SP, endBar, STAFF_BOTTOM, 1.6, LV.staff + 3)

  // current-note marker: small triangle under the staff + brighter note
  if (cur >= 0 && cur < lay.placed.length) {
    const p = lay.placed[cur]
    const my = 18
    ctx.fillStyle = grey(LV.marker)
    ctx.beginPath(); ctx.moveTo(p.x, my + 6); ctx.lineTo(p.x - 6, my - 4); ctx.lineTo(p.x + 6, my - 4); ctx.closePath(); ctx.fill()
  }

  if (opts.letters) {
    ctx.fillStyle = grey(LV.text)
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    lay.placed.forEach(p => {
      const acc = p.sp.acc > 0 ? '#' : p.sp.acc < 0 ? 'b' : ''
      ctx.fillText(p.sp.letter + acc, p.x, 140)
    })
  }
  return { ok: true }
}

/** Quantize the canvas to 16 grey levels (0 = off). One value (0-15) per pixel. */
export function toGrey16(ctx: Ctx): Uint8Array {
  const img = ctx.getImageData(0, 0, W, H).data
  const out = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2]
    out[i] = Math.round(((0.299 * r + 0.587 * g + 0.114 * b) / 255) * 15)
  }
  return out
}

/** Build a major scale up one octave from a root midi note as quarter or eighth notes. */
export function majorScale(rootMidi: number, beats = 1): StaffNote[] {
  const steps = [0, 2, 4, 5, 7, 9, 11, 12]
  return steps.map(s => ({ midi: rootMidi + s, beats }))
}
