import type { PlaybackLoop } from './audioTypes'
import { decodeAudioFile } from './decodeAudioFile'

export class AudioEngine {
  private context: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private startedAtContextTime = 0
  private startedAtOffset = 0
  private pausedAt = 0
  private playing = false
  private loop: PlaybackLoop = { start: 0, end: 0, enabled: false }
  private loadGeneration = 0

  async load(file: File): Promise<AudioBuffer> {
    const generation = ++this.loadGeneration
    const context = this.ensureContext()
    this.stopCurrentSource()
    this.buffer = null
    this.startedAtContextTime = 0
    this.startedAtOffset = 0
    this.pausedAt = 0
    this.playing = false
    const buffer = await decodeAudioFile(context, file)
    if (generation !== this.loadGeneration) {
      throw new DOMException('Audio load was superseded.', 'AbortError')
    }
    this.buffer = buffer
    this.loop = { start: 0, end: buffer.duration, enabled: false }
    return buffer
  }

  async play(offset?: number, loop?: PlaybackLoop): Promise<void> {
    if (!this.buffer) throw new Error('No audio buffer loaded.')
    const context = this.ensureContext()
    const requestedOffset = offset ?? (this.playing ? this.getCurrentTime() : this.pausedAt)
    const nextLoop = this.validateLoop(loop ?? this.loop)
    if (context.state === 'suspended') await context.resume()
    this.loop = nextLoop
    const normalizedOffset = this.normalizePlaybackOffset(requestedOffset, nextLoop)
    this.startSource(normalizedOffset)
  }

  pause(): number {
    if (!this.buffer) return 0
    if (!this.playing) return this.pausedAt
    const currentTime = this.getCurrentTime()
    this.stopCurrentSource()
    this.pausedAt = currentTime
    this.playing = false
    return currentTime
  }

  stop(): void {
    this.stopCurrentSource()
    this.startedAtContextTime = 0
    this.startedAtOffset = 0
    this.pausedAt = 0
    this.playing = false
  }

  async seek(time: number): Promise<void> {
    if (!this.buffer) return
    const target = this.normalizePlaybackOffset(time, this.loop)
    if (!this.playing) {
      this.pausedAt = target
      return
    }
    const context = this.ensureContext()
    if (context.state === 'suspended') await context.resume()
    this.startSource(target)
  }

  setLoop(loop: PlaybackLoop): void {
    if (!this.buffer) { this.loop = { ...loop }; return }
    const currentTime = this.getCurrentTime()
    const validated = this.validateLoop(loop)
    this.loop = validated
    const normalized = this.normalizePlaybackOffset(currentTime, validated)
    if (this.playing) this.startSource(normalized)
    else this.pausedAt = normalized
  }

  getCurrentTime(): number {
    if (!this.buffer) return 0
    if (!this.playing || !this.context) return this.pausedAt
    const elapsed = this.context.currentTime - this.startedAtContextTime
    const rawTime = this.startedAtOffset + elapsed
    if (!this.loop.enabled) return Math.min(rawTime, this.buffer.duration)
    const loopStart = this.loop.start
    const loopEnd = this.loop.end
    const loopLength = loopEnd - loopStart
    if (loopLength <= 0) return Math.min(rawTime, this.buffer.duration)
    if (rawTime < loopEnd) return rawTime
    return loopStart + ((rawTime - loopEnd) % loopLength)
  }

  getDuration(): number { return this.buffer?.duration ?? 0 }
  getIsPlaying(): boolean { return this.playing }
  getLoop(): PlaybackLoop { return { ...this.loop } }

  clear(): void {
    this.loadGeneration += 1
    this.stopCurrentSource()
    this.buffer = null
    this.startedAtContextTime = 0
    this.startedAtOffset = 0
    this.pausedAt = 0
    this.playing = false
    this.loop = { start: 0, end: 0, enabled: false }
  }

  async dispose(): Promise<void> {
    this.clear()
    if (this.context) { await this.context.close(); this.context = null }
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext()
    return this.context
  }

  private startSource(offset: number): void {
    if (!this.buffer || !this.context) throw new Error('Audio is not loaded.')
    this.stopCurrentSource()
    const source = this.context.createBufferSource()
    source.buffer = this.buffer
    source.loop = this.loop.enabled
    if (this.loop.enabled) { source.loopStart = this.loop.start; source.loopEnd = this.loop.end }
    source.connect(this.context.destination)
    this.source = source
    this.startedAtContextTime = this.context.currentTime
    this.startedAtOffset = offset
    this.pausedAt = offset
    this.playing = true
    source.onended = () => {
      if (this.source !== source) return
      this.source = null
      this.playing = false
      if (this.buffer) this.pausedAt = this.buffer.duration
    }
    source.start(0, offset)
  }

  private stopCurrentSource(): void {
    const oldSource = this.source
    if (!oldSource) return
    this.source = null
    try { oldSource.stop() } catch {}
    try { oldSource.disconnect() } catch {}
  }

  private validateLoop(loop: PlaybackLoop): PlaybackLoop {
    if (!this.buffer) return { ...loop }
    const start = this.snapToSample(this.clamp(loop.start, 0, this.buffer.duration))
    const end = this.snapToSample(this.clamp(loop.end, 0, this.buffer.duration))
    if (loop.enabled && end <= start) throw new Error('loopEnd must be greater than loopStart.')
    return { start, end, enabled: loop.enabled }
  }

  private normalizePlaybackOffset(time: number, loop: PlaybackLoop): number {
    if (!this.buffer) return 0
    let clamped = this.clamp(time, 0, this.buffer.duration)
    clamped = this.snapToSample(clamped)
    if (!loop.enabled) return clamped
    if (clamped >= loop.end) return loop.start
    return clamped
  }

  private snapToSample(time: number): number {
    if (!this.buffer) return time
    const sampleRate = this.buffer.sampleRate
    const frame = Math.round(time * sampleRate)
    const clampedFrame = Math.min(Math.max(frame, 0), this.buffer.length)
    return clampedFrame / sampleRate
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }
}
