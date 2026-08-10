export interface MicSession {
  /** Returns all audio captured since the last drain (minus a small tail
   * overlap so word boundaries don't get chopped), and clears it. */
  drain: () => Float32Array
  /** Stops capture and returns the remaining audio (including the tail). */
  stop: () => Promise<Float32Array>
}

// 0.4s of trailing samples are kept across drains so segment boundaries land
// mid-word less often and Whisper sees whole words.
const TAIL_SAMPLES = 6400

export async function startMicCapture(
  onLevel?: (level: number) => void
): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const ctx = new AudioContext({ sampleRate: 16000 })
  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  // Route through a zero-gain node so the mic audio doesn't play out loud.
  const mute = ctx.createGain()
  mute.gain.value = 0

  let buffer = new Float32Array(0)
  const chunks: Float32Array[] = []

  processor.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(data))
    if (onLevel) {
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      onLevel(Math.sqrt(sum / data.length))
    }
  }

  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  const levelTimer = setInterval(() => {
    // keep the audio graph alive; level callbacks fire in onaudioprocess
  }, 1000)

  function materialize(): Float32Array {
    let total = 0
    for (const c of chunks) total += c.length
    const merged = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    chunks.length = 0
    return merged
  }

  let stopped = false
  return {
    drain(): Float32Array {
      if (stopped) return new Float32Array(0)
      const incoming = materialize()
      if (incoming.length === 0) return new Float32Array(0)
      // Combine with any retained tail from the previous drain.
      const combined = new Float32Array(buffer.length + incoming.length)
      combined.set(buffer, 0)
      combined.set(incoming, buffer.length)
      const keep = Math.min(TAIL_SAMPLES, combined.length)
      const take = combined.length - keep
      const out = new Float32Array(take)
      out.set(combined.subarray(0, take))
      buffer = combined.slice(take)
      return out
    },
    async stop(): Promise<Float32Array> {
      if (stopped) return new Float32Array(0)
      stopped = true
      clearInterval(levelTimer)
      processor.disconnect()
      source.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
      const incoming = materialize()
      const combined = new Float32Array(buffer.length + incoming.length)
      combined.set(buffer, 0)
      combined.set(incoming, buffer.length)
      buffer = new Float32Array(0)
      return combined
    }
  }
}
