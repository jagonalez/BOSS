export interface TtsStatus {
  available: boolean
  ready: boolean
  speaking: boolean
  error?: string
}

export interface AsrStatus {
  available: boolean
  listening: boolean
  error?: string
}

export interface TtsSpeakResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

export interface SpeechStatus {
  tts: TtsStatus
  asr: AsrStatus
}

export const DEFAULT_TTS_VOICE = 'stuart_bell'

export const POCKET_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'stuart_bell', label: 'Stuart Bell' },
  { id: 'michael', label: 'Michael' },
  { id: 'cosette', label: 'Cosette' },
  { id: 'marius', label: 'Marius' },
  { id: 'javert', label: 'Javert' },
  { id: 'alba', label: 'Alba' },
  { id: 'jean', label: 'Jean' },
  { id: 'anna', label: 'Anna' },
  { id: 'vera', label: 'Vera' },
  { id: 'fantine', label: 'Fantine' },
  { id: 'charles', label: 'Charles' },
  { id: 'paul', label: 'Paul' },
  { id: 'eponine', label: 'Eponine' },
  { id: 'azelma', label: 'Azelma' },
  { id: 'george', label: 'George' },
  { id: 'mary', label: 'Mary' },
  { id: 'jane', label: 'Jane' },
  { id: 'eve', label: 'Eve' },
  { id: 'bill_boerst', label: 'Bill Boerst' },
  { id: 'peter_yearsley', label: 'Peter Yearsley' },
  { id: 'caro_davy', label: 'Caro Davy' },
  { id: 'giovanni', label: 'Giovanni' },
  { id: 'lola', label: 'Lola' },
  { id: 'juergen', label: 'Juergen' },
  { id: 'rafael', label: 'Rafael' },
  { id: 'estelle', label: 'Estelle' }
]
