// YIN pitch detector (de Cheveigné & Kawahara, 2002).
//
// Finds the fundamental frequency — the repeating period of the waveform —
// rather than the loudest spectral peak, so strong overtones don't make the
// reading jump octaves.

export interface PitchResult {
  /** Detected fundamental in Hz. */
  freq: number
  /** 0–1, higher is a cleaner periodic signal. */
  clarity: number
}

export interface DetectorOptions {
  sampleRate: number
  minFreq?: number
  maxFreq?: number
  /** YIN absolute threshold; lower is stricter. */
  threshold?: number
}

export function detectPitch(buf: Float32Array, opts: DetectorOptions): PitchResult | null {
  const { sampleRate, minFreq = 60, maxFreq = 1200, threshold = 0.15 } = opts
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq))
  const tauMax = Math.min(Math.floor(sampleRate / minFreq), Math.floor(buf.length / 2))
  const w = buf.length - tauMax

  // Step 1–2: difference function d(tau).
  const d = new Float32Array(tauMax + 1)
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0
    for (let i = 0; i < w; i++) {
      const delta = buf[i] - buf[i + tau]
      sum += delta * delta
    }
    d[tau] = sum
  }

  // Step 3: cumulative mean normalized difference d'(tau).
  const cmnd = new Float32Array(tauMax + 1)
  cmnd[0] = 1
  let running = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau]
    cmnd[tau] = running === 0 ? 1 : (d[tau] * tau) / running
  }

  // Step 4: first dip below the threshold, then walk to its local minimum.
  // If nothing dips that low, fall back to the global minimum and let the
  // caller decide via `clarity` — a wavering sustained note often lands here.
  let tau = -1
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++
      tau = t
      break
    }
  }
  if (tau === -1) {
    tau = tauMin
    for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[tau]) tau = t
  }

  // Step 5: parabolic interpolation for sub-sample precision. At 16 kHz one
  // sample of period error is tens of cents, so this step matters.
  let betterTau = tau
  if (tau > 1 && tau < tauMax) {
    const s0 = cmnd[tau - 1]
    const s1 = cmnd[tau]
    const s2 = cmnd[tau + 1]
    const denom = s0 + s2 - 2 * s1
    if (denom !== 0) betterTau = tau + (s0 - s2) / (2 * denom)
  }

  return { freq: sampleRate / betterTau, clarity: 1 - cmnd[tau] }
}

export function rms(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}
