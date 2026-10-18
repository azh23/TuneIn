import type { StaffNote } from './staff'

export interface RecognizedSheet {
  notes: StaffNote[]
  key: number
  timeSig: [number, number]
  title?: string
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(cleaned)
}

function midiFromPitch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value >= 0 && value <= 127 ? value : null
  if (typeof value !== 'string') return null
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(value.trim())
  if (!match) return null
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0
  const midi = (Number(match[3]) + 1) * 12 + base[match[1].toUpperCase()] + accidental
  return midi >= 0 && midi <= 127 ? midi : null
}

function beatsFromDuration(value: unknown): number | null {
  if (typeof value === 'number' && value > 0 && value <= 8) return value
  if (typeof value !== 'string') return null
  const durations: Record<string, number> = {
    breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25,
  }
  return durations[value.trim().toLowerCase()] ?? null
}

export function normalizeCreaoResult(text: string): RecognizedSheet {
  const parsed = parseJson(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('Creao returned an invalid result')
  const input = parsed as Record<string, unknown>
  const measures = Array.isArray(input.measures) ? input.measures : []
  const notes: StaffNote[] = []
  for (const measure of measures) {
    if (!measure || typeof measure !== 'object') continue
    const measureNotes = (measure as Record<string, unknown>).notes
    if (!Array.isArray(measureNotes)) continue
    for (const note of measureNotes) {
      if (!note || typeof note !== 'object') continue
      const item = note as Record<string, unknown>
      const midi = midiFromPitch(item.pitch)
      const beats = beatsFromDuration(item.duration)
      if (midi !== null && beats !== null) notes.push({ midi, beats })
    }
  }
  if (notes.length === 0) throw new Error('Creao returned no readable notes')
  const key = typeof input.key === 'number' && Number.isInteger(input.key) && Math.abs(input.key) <= 7 ? input.key : 0
  const time = input.timeSignature
  const timeSig: [number, number] =
    Array.isArray(time) && time.length === 2 && time.every(v => typeof v === 'number' && v > 0)
      ? [time[0] as number, time[1] as number]
      : [4, 4]
  return { notes, key, timeSig, title: typeof input.title === 'string' ? input.title : undefined }
}

export async function recognizeSheet(image: File): Promise<RecognizedSheet> {
  const imageDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read image'))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.readAsDataURL(image)
  })
  const response = await fetch('/api/recognize-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl }),
  })
  const payload = await response.json() as { text?: string; error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Recognition failed (${response.status})`)
  if (!payload.text) throw new Error('Recognition response did not include notes')
  return normalizeCreaoResult(payload.text)
}
