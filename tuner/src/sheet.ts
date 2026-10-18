// Sheet music on the glasses.
//
// Draws the staff (staff.ts) into an offscreen canvas, encodes it, and pushes
// it into the glasses' image container with updateImageRawData.
//
// SDK rules (from its README):
//  - image containers are created empty; pixels are sent AFTER creation
//  - never send two images at once (queue them)
//  - don't send too often (the sample app caps it at about 1 per second)

import {
  EvenAppBridge,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
} from '@evenrealities/even_hub_sdk'
import { H, W, renderStaff, type RenderOptions, type StaffNote } from './staff'

/**
 * How pixels are encoded for updateImageRawData.
 *  'png'   - PNG bytes; the host converts to 4-bit grey. Worked in community apps.
 *  'gray8' - one byte per pixel (0-255). Used by Even's newer sample apps.
 * If the glasses show nothing or updateImageRawData reports an error, switch this.
 */
export const IMAGE_FORMAT: 'png' | 'gray8' = 'png'

/** Minimum gap between image sends. The SDK sample uses about 1000 ms. */
const MIN_SEND_INTERVAL_MS = 500

export const SHEET_ID = 2
export const SHEET_NAME = 'sheet'

/** Where the staff sits on the 576x288 screen (centered horizontally, near the top). */
export const sheetBox = new ImageContainerProperty({
  xPosition: Math.round((576 - W) / 2),
  yPosition: 6,
  width: W,
  height: H,
  containerID: SHEET_ID,
  containerName: SHEET_NAME,
})

interface Frame {
  notes: StaffNote[]
  opts: RenderOptions
}

export class SheetDisplay {
  private canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  private pending: Frame | null = null
  private sending = false
  private lastSent = 0
  private timer: number | null = null
  /** Called with a short message whenever sending fails (shown in the phone UI). */
  onError: (msg: string) => void = () => {}

  constructor(private bridge: EvenAppBridge) {
    this.canvas.width = W
    this.canvas.height = H
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  }

  /** Ask for a redraw. If one is already in flight, only the newest request is kept. */
  show(notes: StaffNote[], opts: RenderOptions = {}) {
    this.pending = { notes, opts }
    this.pump()
  }

  /** Blank the image area (an all-black image clears an image container). */
  clear() {
    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, W, H)
    this.pending = null
    void this.send()
  }

  private pump() {
    if (this.sending || this.timer !== null || !this.pending) return
    const wait = Math.max(0, MIN_SEND_INTERVAL_MS - (performance.now() - this.lastSent))
    this.timer = window.setTimeout(async () => {
      this.timer = null
      const frame = this.pending
      this.pending = null
      if (!frame) return
      const res = renderStaff(this.ctx, frame.notes, frame.opts)
      if (!res.ok) {
        this.onError(res.reason ?? 'staff does not fit')
        return
      }
      await this.send()
      this.pump() // a newer frame may have arrived while sending
    }, wait)
  }

  private async send() {
    this.sending = true
    try {
      const bytes = await this.encode()
      const result = await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: SHEET_ID, containerName: SHEET_NAME, imageData: bytes }),
      )
      if (!ImageRawDataUpdateResult.isSuccess(result)) this.onError(`image update failed: ${result}`)
    } catch (err) {
      this.onError(`image update error: ${(err as Error)?.message ?? err}`)
    } finally {
      this.lastSent = performance.now()
      this.sending = false
    }
  }

  /** Snap the canvas to 16 grey levels (what the display can show), then encode. */
  private async encode(): Promise<Uint8Array> {
    const img = this.ctx.getImageData(0, 0, W, H)
    const d = img.data
    if (IMAGE_FORMAT === 'gray8') {
      const out = new Uint8Array(W * H)
      for (let i = 0; i < W * H; i++) {
        const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
        out[i] = Math.round(Math.round((g / 255) * 15) * (255 / 15))
      }
      return out
    }
    for (let i = 0; i < W * H; i++) {
      const g = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]
      const v = Math.round(Math.round((g / 255) * 15) * (255 / 15))
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
      d[i * 4 + 3] = 255
    }
    this.ctx.putImageData(img, 0, 0)
    const blob: Blob = await new Promise((resolve, reject) =>
      this.canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
    )
    return new Uint8Array(await blob.arrayBuffer())
  }
}
