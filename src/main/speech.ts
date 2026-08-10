import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { systemPreferences } from 'electron'
import type { AsrStatus, SpeechStatus, TtsSpeakResult, TtsStatus } from '@shared/speech'
import { DEFAULT_TTS_VOICE } from '@shared/speech'

export class SpeechManager {
  private ttsProc: ChildProcess | null = null
  private ttsReady = false
  private ttsReadyPromise: Promise<void> | null = null
  private ttsQueue: Array<{ resolve: (payload: Record<string, unknown>) => void }> = []
  private ttsBuffer = ''
  private earsProc: ChildProcess | null = null
  private earsListening = false
  private earsBuffer = ''
  private ttsError: string | null = null

  onTranscript?: (text: string) => void
  onStatusChange?: (status: SpeechStatus) => void

  get dir(): string {
    return process.env.RALF_SPEECH_DIR ?? join(homedir(), 'dev', 'just-us', 'bots', 'marvin', 'tts')
  }

  private get ttsPython(): string {
    return join(this.dir, '.venv-pt', 'bin', 'python')
  }

  private get earsPython(): string {
    return join(this.dir, '.venv-ears', 'bin', 'python')
  }

  private get ttsScript(): string {
    return join(this.dir, 'pocket_server.py')
  }

  private get earsScript(): string {
    return join(this.dir, 'ears_server.py')
  }

  ttsAvailable(): boolean {
    return existsSync(this.ttsPython) && existsSync(this.ttsScript)
  }

  asrAvailable(): boolean {
    return existsSync(this.earsPython) && existsSync(this.earsScript)
  }

  ttsStatus(): TtsStatus {
    return {
      available: this.ttsAvailable(),
      ready: this.ttsReady,
      speaking: this.ttsQueue.length > 0,
      error: this.ttsError ?? undefined
    }
  }

  asrStatus(): AsrStatus {
    return {
      available: this.asrAvailable(),
      listening: this.earsListening,
      error: this.ttsError ?? undefined
    }
  }

  private emitStatus(): void {
    this.onStatusChange?.({ tts: this.ttsStatus(), asr: this.asrStatus() })
  }

  async speak(text: string, voice: string): Promise<TtsSpeakResult> {
    if (!this.ttsAvailable()) {
      return { ok: false, error: 'Pocket TTS not installed — missing .venv-pt or pocket_server.py' }
    }
    try {
      await this.ensureTts()
    } catch (err) {
      return { ok: false, error: `Could not start Pocket TTS: ${String(err)}` }
    }
    if (!this.ttsProc) return { ok: false, error: 'Pocket TTS is not running' }
    const out = join(tmpdir(), `ralf-tts-${randomBytes(6).toString('hex')}.wav`)
    return new Promise<TtsSpeakResult>((resolve) => {
      this.ttsQueue.push({
        resolve: (payload) => {
          if (!payload.ok) {
            this.ttsError = String(payload.error ?? 'TTS error')
            this.emitStatus()
            resolve({ ok: false, error: this.ttsError })
            return
          }
          try {
            const data = readFileSync(out)
            resolve({ ok: true, dataUrl: `data:audio/wav;base64,${data.toString('base64')}` })
          } catch (err) {
            resolve({ ok: false, error: String(err) })
          } finally {
            try {
              unlinkSync(out)
            } catch {
              /* ignore */
            }
          }
        }
      })
      this.ttsProc!.stdin.write(JSON.stringify({ text, voice, out }) + '\n')
      this.emitStatus()
    })
  }

  private ensureTts(): Promise<void> {
    if (this.ttsReady && this.ttsProc) return Promise.resolve()
    if (this.ttsReadyPromise) return this.ttsReadyPromise
    this.ttsReadyPromise = new Promise<void>((resolve, reject) => {
      const proc = spawn(this.ttsPython, [this.ttsScript], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.ttsProc = proc
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (d) => {
        this.ttsBuffer += d
        let nl = this.ttsBuffer.indexOf('\n')
        while (nl >= 0) {
          const line = this.ttsBuffer.slice(0, nl).trim()
          this.ttsBuffer = this.ttsBuffer.slice(nl + 1)
          if (line) this.handleTtsLine(line)
          nl = this.ttsBuffer.indexOf('\n')
        }
      })
      proc.stderr.on('data', (d) => {
        if (process.env.RALF_DEBUG) process.stderr.write(`[pocket-tts] ${d}`)
      })
      proc.on('exit', (code, signal) => {
        this.ttsProc = null
        this.ttsReady = false
        this.ttsReadyPromise = null
        this.ttsQueue.forEach((q) => q.resolve({ ok: false, error: 'Pocket TTS exited' }))
        this.ttsQueue = []
        this.emitStatus()
        if (process.env.RALF_DEBUG) process.stderr.write(`[pocket-tts] exited ${code} ${signal}\n`)
      })
      proc.on('error', (err) => {
        this.ttsProc = null
        this.ttsReady = false
        this.ttsReadyPromise = null
        this.ttsQueue.forEach((q) => q.resolve({ ok: false, error: String(err) }))
        this.ttsQueue = []
        reject(err)
        this.emitStatus()
      })
    })
    return this.ttsReadyPromise
  }

  private handleTtsLine(line: string): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.ready) {
      this.ttsReady = true
      this.ttsReadyPromise = null
      this.ttsError = null
      this.emitStatus()
      return
    }
    const pending = this.ttsQueue.shift()
    if (pending) pending.resolve(payload)
  }

  async startAsr(): Promise<AsrStatus> {
    if (this.earsProc) return this.asrStatus()
    if (!this.asrAvailable()) {
      return { available: false, listening: false, error: 'Parakeet ASR not installed — missing .venv-ears or ears_server.py' }
    }
    if (process.platform === 'darwin') {
      const granted = await this.ensureMicPermission()
      if (!granted) {
        return { available: true, listening: false, error: 'Microphone permission denied' }
      }
    }
    try {
      await this.spawnEars()
      return this.asrStatus()
    } catch (err) {
      return { available: true, listening: false, error: String(err) }
    }
  }

  stopAsr(): AsrStatus {
    if (this.earsProc) {
      const proc = this.earsProc
      this.earsProc = null
      this.earsListening = false
      proc.kill('SIGTERM')
    }
    this.emitStatus()
    return this.asrStatus()
  }

  private async ensureMicPermission(): Promise<boolean> {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied') return false
    return await systemPreferences.askForMediaAccess('microphone')
  }

  private spawnEars(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.earsPython, [this.earsScript], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.earsProc = proc
      const started = setTimeout(() => reject(new Error('ASR start timed out')), 30000)
      const done = (): void => {
        clearTimeout(started)
        resolve()
      }
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (d) => {
        this.earsBuffer += d
        let nl = this.earsBuffer.indexOf('\n')
        while (nl >= 0) {
          const line = this.earsBuffer.slice(0, nl).trim()
          this.earsBuffer = this.earsBuffer.slice(nl + 1)
          if (!line) continue
          let payload: Record<string, unknown>
          try {
            payload = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (payload.ready) {
            this.earsListening = true
            this.emitStatus()
            done()
          } else if (typeof payload.text === 'string') {
            this.onTranscript?.(payload.text)
          }
        }
      })
      proc.stderr.on('data', (d) => {
        if (process.env.RALF_DEBUG) process.stderr.write(`[ears] ${d}`)
      })
      proc.on('exit', () => {
        this.earsProc = null
        this.earsListening = false
        this.emitStatus()
      })
      proc.on('error', (err) => {
        this.earsProc = null
        this.earsListening = false
        clearTimeout(started)
        reject(err)
        this.emitStatus()
      })
    })
  }

  dispose(): void {
    if (this.ttsProc) {
      this.ttsProc.kill('SIGTERM')
      this.ttsProc = null
    }
    if (this.earsProc) {
      this.earsProc.kill('SIGTERM')
      this.earsProc = null
    }
  }
}

export { DEFAULT_TTS_VOICE }
