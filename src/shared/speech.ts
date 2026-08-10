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

export const DEFAULT_TTS_VOICE = 'af_heart'

export const KOKORO_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'af_heart', label: 'Heart (US female)' },
  { id: 'af_bella', label: 'Bella (US female)' },
  { id: 'af_alloy', label: 'Alloy (US female)' },
  { id: 'af_aoede', label: 'Aoede (US female)' },
  { id: 'af_jessica', label: 'Jessica (US female)' },
  { id: 'af_kore', label: 'Kore (US female)' },
  { id: 'af_nicole', label: 'Nicole (US female)' },
  { id: 'af_nova', label: 'Nova (US female)' },
  { id: 'af_river', label: 'River (US female)' },
  { id: 'af_sarah', label: 'Sarah (US female)' },
  { id: 'af_sky', label: 'Sky (US female)' },
  { id: 'am_adam', label: 'Adam (US male)' },
  { id: 'am_echo', label: 'Echo (US male)' },
  { id: 'am_eric', label: 'Eric (US male)' },
  { id: 'am_fenrir', label: 'Fenrir (US male)' },
  { id: 'am_liam', label: 'Liam (US male)' },
  { id: 'am_michael', label: 'Michael (US male)' },
  { id: 'am_onyx', label: 'Onyx (US male)' },
  { id: 'am_puck', label: 'Puck (US male)' },
  { id: 'am_santa', label: 'Santa (US male)' },
  { id: 'bf_alice', label: 'Alice (UK female)' },
  { id: 'bf_emma', label: 'Emma (UK female)' },
  { id: 'bf_isabella', label: 'Isabella (UK female)' },
  { id: 'bf_lily', label: 'Lily (UK female)' },
  { id: 'bm_daniel', label: 'Daniel (UK male)' },
  { id: 'bm_fable', label: 'Fable (UK male)' },
  { id: 'bm_george', label: 'George (UK male)' },
  { id: 'bm_lewis', label: 'Lewis (UK male)' }
]
