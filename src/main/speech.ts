import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AsrStatus, SpeechStatus, TtsSpeakResult, TtsStatus } from '@shared/speech'
import { DEFAULT_TTS_VOICE } from '@shared/speech'

export { DEFAULT_TTS_VOICE }

// Shared model store. Defaults to a common cache under the user's home so
// multiple apps can reuse the same weights; override with BOSS_MODEL_CACHE.
function resolveModelCache(): string {
  return process.env.BOSS_MODEL_CACHE ?? join(homedir(), '.cache', 'boss', 'models')
}

export class SpeechManager {
  private tts: {
    generate: (
      text: string,
      opts: { voice?: string; speed?: number }
    ) => Promise<{ audio: Float32Array; sampling_rate: number }>
  } | null = null
  private ttsLoading: Promise<boolean> | null = null
  private ttsReady = false
  private ttsError: string | null = null

  private asr: ((audio: Float32Array) => Promise<{ text: string }>) | null = null
  private asrLoading: Promise<boolean> | null = null
  private asrReady = false
  private asrError: string | null = null

  onStatusChange?: (status: SpeechStatus) => void

  get modelCache(): string {
    return resolveModelCache()
  }

  ttsStatus(): TtsStatus {
    return {
      available: true,
      ready: this.ttsReady,
      speaking: this.ttsLoading !== null,
      error: this.ttsError ?? undefined
    }
  }

  asrStatus(): AsrStatus {
    return {
      available: true,
      listening: false,
      error: this.asrError ?? undefined
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.({ tts: this.ttsStatus(), asr: this.asrStatus() })
  }

  private async loadTts(): Promise<boolean> {
    if (this.ttsReady) return true
    if (this.ttsLoading) return this.ttsLoading
    this.ttsLoading = (async () => {
      const { env } = await import('@huggingface/transformers')
      env.cacheDir = this.modelCache
      env.localModelPath = this.modelCache
      const { KokoroTTS } = await import('kokoro-js')
      const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' })
      this.tts = {
        generate: (text, opts) =>
          tts.generate(text, { voice: (opts.voice ?? DEFAULT_TTS_VOICE) as 'af_heart', speed: opts.speed ?? 1 })
      }
      this.ttsReady = true
      this.ttsError = null
      return true
    })().catch((err) => {
      this.ttsError = String(err?.message ?? err)
      return false
    }).finally(() => {
      this.ttsLoading = null
      this.emitStatus()
    })
    this.emitStatus()
    return this.ttsLoading
  }

  async speak(text: string, voice: string): Promise<TtsSpeakResult> {
    const ok = await this.loadTts()
    if (!ok || !this.tts) {
      return { ok: false, error: this.ttsError ?? 'Voice model failed to load' }
    }
    try {
      const { audio, sampling_rate } = await this.tts.generate(text, { voice })
      return { ok: true, dataUrl: pcmToWavDataUrl(audio, sampling_rate) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  private async loadAsr(): Promise<boolean> {
    if (this.asrReady) return true
    if (this.asrLoading) return this.asrLoading
    this.asrLoading = (async () => {
      const { env, pipeline } = await import('@huggingface/transformers')
      env.cacheDir = this.modelCache
      env.localModelPath = this.modelCache
      const transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
        dtype: 'q8'
      })
      this.asr = (audio) => transcriber(audio) as Promise<{ text: string }>
      this.asrReady = true
      this.asrError = null
      return true
    })().catch((err) => {
      this.asrError = String(err?.message ?? err)
      return false
    }).finally(() => {
      this.asrLoading = null
      this.emitStatus()
    })
    this.emitStatus()
    return this.asrLoading
  }

  async transcribe(audio: Float32Array): Promise<{ text: string; error?: string }> {
    const ok = await this.loadAsr()
    if (!ok || !this.asr) {
      return { text: '', error: this.asrError ?? 'Speech model failed to load' }
    }
    try {
      const { text } = await this.asr(audio)
      return { text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', error: message }
    }
  }

  dispose(): void {
    this.tts = null
    this.asr = null
  }
}

function pcmToWavDataUrl(samples: Float32Array, sampleRate: number): string {
  const numSamples = samples.length
  const dataSize = numSamples * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  function writeString(offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return `data:audio/wav;base64,${btoa(binary)}`
}
