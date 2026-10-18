import type { StaffNote } from './staff'

export interface RecognizedSheet {
  notes: StaffNote[]
  key: number
  timeSig: [number, number]
  title?: string
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('Creao returned invalid JSON')
    return JSON.parse(cleaned.slice(start, end + 1))
  }
}

function unwrapResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  for (const key of ['response', 'text', 'content', 'output']) {
    if (typeof object[key] === 'string') {
      try {
        const nested = parseJson(object[key])
        if (nested && typeof nested === 'object') return nested as Record<string, unknown>
      } catch {
        // Try the next known wrapper.
      }
    }
  }
  return object
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
  const input = unwrapResult(parsed)
  if (!input) throw new Error('Creao returned an invalid result')
  const measures = Array.isArray(input.measures) ? input.measures : []
  const notes: StaffNote[] = []
  for (const measure of measures) {
    if (!measure || typeof measure !== 'object') continue
    const measureNotes = (measure as Record<string, unknown>).notes
    if (!Array.isArray(measureNotes)) continue
    for (const note of measureNotes) {
      if (!note || typeof note !== 'object') continue
      const item = note as Record<string, unknown>
      if (typeof item.pitch === 'string' && item.pitch.trim().toLowerCase() === 'rest') continue
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
  const imageDataUrl = await prepareImage(image)
  const response = await fetch('/api/recognize-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageDataUrl }),
  })
  const payload = await response.json() as { job_id?: string; error?: string }
  if (!response.ok) throw new Error(payload.error ?? `Recognition failed (${response.status})`)
  if (!payload.job_id) throw new Error('Recognition response did not include a job ID')

  let delayMs = 2000
  const deadline = Date.now() + 16 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const statusResponse = await fetch(`/api/recognize-sheet/${encodeURIComponent(payload.job_id)}`)
    const status = await statusResponse.json() as { status?: string; text?: string; error?: string }
    if (!statusResponse.ok) throw new Error(status.error ?? `Recognition status failed (${statusResponse.status})`)
    if (status.status === 'completed' && status.text) return normalizeCreaoResult(status.text)
    if (status.status === 'failed' || status.status === 'cancelled') {
      throw new Error(status.error ?? `Creao run ${status.status}`)
    }
    delayMs = Math.min(delayMs * 1.5, 10000)
  }
  throw new Error('Sheet recognition timed out while waiting for Creao')
}

const MAX_IMAGE_EDGE = 2400
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

async function prepareImage(image: File): Promise<string> {
  const source = await createImageBitmap(image)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(source.width, source.height))
  const width = Math.max(1, Math.round(source.width * scale))
  const height = Math.max(1, Math.round(source.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not prepare sheet-music image')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, 0, 0, width, height)
  source.close()
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not encode sheet-music image')), 'image/jpeg', 0.88),
  )
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('Sheet-music image is too large after compression; use a closer crop')
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read prepared image'))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read prepared image'))
    reader.readAsDataURL(blob)
  })
}
