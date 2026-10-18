const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface Note {
  /** Pitch class, e.g. "A#". */
  name: string
  octave: number
  /** -50..+50, how far the input is from the nearest note. */
  cents: number
  midi: number
}

export function freqToNote(freq: number, a4 = 440): Note {
  const exact = 69 + 12 * Math.log2(freq / a4)
  const midi = Math.round(exact)
  return {
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: Math.round((exact - midi) * 100),
    midi,
  }
}
