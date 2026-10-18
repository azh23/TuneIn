// Hard-coded practice pieces. Pick one with EXERCISE in main.ts.

import { majorScale, type StaffNote } from './staff'

export interface Exercise {
  name: string
  notes: StaffNote[]
  key: number
  timeSig: [number, number]
  showTimeSig: boolean
}

export const C_MAJOR_SCALE: Exercise = {
  name: 'C major scale',
  notes: majorScale(60, 1),
  key: 0,
  timeSig: [4, 4],
  showTimeSig: false,
}

// Mixed note lengths for testing rhythm. No note repeats the one before it,
// so every note change is a pitch change (repeated notes need onset
// detection, which we don't have yet).
//   | C  D  E-- | F  G  E-- | C------ |
const q = 1
const h = 2
const w = 4
export const RHYTHM_TEST: Exercise = {
  name: 'Rhythm test',
  notes: [
    { midi: 60, beats: q }, { midi: 62, beats: q }, { midi: 64, beats: h },
    { midi: 65, beats: q }, { midi: 67, beats: q }, { midi: 64, beats: h },
    { midi: 60, beats: w },
  ],
  key: 0,
  timeSig: [4, 4],
  showTimeSig: true,
}
