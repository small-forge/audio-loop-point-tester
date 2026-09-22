export interface WaveformLoopRange {
  start: number
  end: number
}

export interface CanvasWaveformControllerOptions {
  canvas: HTMLCanvasElement
  onSeek(time: number): void | Promise<void>
  onLoopPreview(start: number, end: number): void
  onLoopCommit(start: number, end: number): void
}

type DragHandle = 'start' | 'end' | null

const HANDLE_HIT_RADIUS_PX = 10
const MIN_LOOP_SECONDS = 0.001
const DEFAULT_HEIGHT_PX = 160

export class CanvasWaveformController {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly onSeek: CanvasWaveformControllerOptions['onSeek']
  private readonly onLoopPreview: CanvasWaveformControllerOptions['onLoopPreview']
  private readonly onLoopCommit: CanvasWaveformControllerOptions['onLoopCommit']

  private peaks: Float32Array[] = []
  private duration = 0
  private loop: WaveformLoopRange = { start: 0, end: 0 }
  private currentTime = 0
  private dragHandle: DragHandle = null
  private dragOriginalLoop: WaveformLoopRange | null = null
  private destroyed = false
  private cssWidth = 0
  private cssHeight = DEFAULT_HEIGHT_PX

  private readonly resizeObserver: ResizeObserver | null

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (!this.hasData()) return

    const x = this.eventToLocalX(event)
    const startX = this.timeToX(this.loop.start)
    const endX = this.timeToX(this.loop.end)

    if (Math.abs(x - startX) <= HANDLE_HIT_RADIUS_PX) {
      this.dragHandle = 'start'
      this.dragOriginalLoop = { ...this.loop }
      this.canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }

    if (Math.abs(x - endX) <= HANDLE_HIT_RADIUS_PX) {
      this.dragHandle = 'end'
      this.dragOriginalLoop = { ...this.loop }
      this.canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }

    void this.onSeek(this.xToTime(x))
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.dragHandle || !this.hasData()) return

    const time = this.xToTime(this.eventToLocalX(event))

    if (this.dragHandle === 'start') {
      this.loop.start = Math.min(
        Math.max(0, time),
        Math.max(0, this.loop.end - MIN_LOOP_SECONDS),
      )
    } else {
      this.loop.end = Math.max(
        Math.min(this.duration, time),
        Math.min(this.duration, this.loop.start + MIN_LOOP_SECONDS),
      )
    }

    this.onLoopPreview(this.loop.start, this.loop.end)
    this.draw()
    event.preventDefault()
  }

  private readonly handlePointerUp = (event: PointerEvent) => {
    if (!this.dragHandle) return

    this.dragHandle = null
    this.dragOriginalLoop = null
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }

    // Commit exactly once after drag. AudioEngine.setLoop() recreates the
    // source while playing, so pointermove remains a visual-only preview.
    this.onLoopCommit(this.loop.start, this.loop.end)
    event.preventDefault()
  }

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (!this.dragHandle) return

    if (this.dragOriginalLoop) {
      this.loop = { ...this.dragOriginalLoop }
      this.onLoopPreview(this.loop.start, this.loop.end)
    }

    this.dragHandle = null
    this.dragOriginalLoop = null
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }
    this.draw()
  }

  constructor(options: CanvasWaveformControllerOptions) {
    this.canvas = options.canvas
    this.onSeek = options.onSeek
    this.onLoopPreview = options.onLoopPreview
    this.onLoopCommit = options.onLoopCommit

    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D context is unavailable.')
    this.context = context

    this.canvas.style.touchAction = 'none'
    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel)

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resizeCanvas())
      this.resizeObserver.observe(this.canvas)
    } else {
      this.resizeObserver = null
    }

    this.resizeCanvas()
  }

  load(
    peaks: Float32Array[],
    duration: number,
    loop: WaveformLoopRange,
  ): void {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Waveform duration must be greater than 0.')
    }
    if (!peaks.length || peaks.some((channel) => channel.length === 0)) {
      throw new Error('Waveform peaks must contain at least one non-empty channel.')
    }

    this.peaks = peaks
    this.duration = duration
    this.currentTime = 0
    this.dragHandle = null
    this.dragOriginalLoop = null
    this.setLoop(loop.start, loop.end)
    this.resizeCanvas()
  }

  clear(): void {
    this.peaks = []
    this.duration = 0
    this.currentTime = 0
    this.loop = { start: 0, end: 0 }
    this.dragHandle = null
    this.dragOriginalLoop = null
    this.draw()
  }

  setCurrentTime(time: number): void {
    if (!this.hasData()) return
    const next = this.clamp(time, 0, this.duration)
    if (Math.abs(next - this.currentTime) < 0.000001) return
    this.currentTime = next
    this.draw()
  }

  setLoop(start: number, end: number): void {
    if (!this.hasData()) {
      this.loop = { start, end }
      return
    }

    const clampedStart = this.clamp(start, 0, this.duration)
    const clampedEnd = this.clamp(end, 0, this.duration)
    if (clampedEnd <= clampedStart) {
      throw new Error('loopEnd must be greater than loopStart.')
    }

    this.loop = { start: clampedStart, end: clampedEnd }
    this.draw()
  }

  getLoop(): WaveformLoopRange {
    return { ...this.loop }
  }

  getDuration(): number {
    return this.duration
  }

  getCurrentTime(): number {
    return this.currentTime
  }

  xToTime(x: number): number {
    if (!this.hasData() || this.cssWidth <= 0) return 0
    return this.clamp(x / this.cssWidth, 0, 1) * this.duration
  }

  timeToX(time: number): number {
    if (!this.hasData() || this.duration <= 0) return 0
    return (this.clamp(time, 0, this.duration) / this.duration) * this.cssWidth
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    this.resizeObserver?.disconnect()
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel)
    this.clear()
  }

  private resizeCanvas(): void {
    if (this.destroyed) return

    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(1, this.canvas.clientWidth || rect.width || 1)
    const height = Math.max(1, this.canvas.clientHeight || rect.height || DEFAULT_HEIGHT_PX)
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const pixelWidth = Math.max(1, Math.round(width * dpr))
    const pixelHeight = Math.max(1, Math.round(height * dpr))

    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight

    this.cssWidth = width
    this.cssHeight = height
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.draw()
  }

  private draw(): void {
    const ctx = this.context
    const width = this.cssWidth
    const height = this.cssHeight

    ctx.clearRect(0, 0, width, height)
    if (!this.hasData() || width <= 0 || height <= 0) return

    const loopStartX = this.timeToX(this.loop.start)
    const loopEndX = this.timeToX(this.loop.end)

    ctx.fillStyle = 'rgba(80, 120, 220, 0.18)'
    ctx.fillRect(loopStartX, 0, Math.max(0, loopEndX - loopStartX), height)

    const channels = Math.min(2, this.peaks.length)
    const centerY = height / 2
    const amplitude = Math.max(1, height * 0.42)
    const peakLength = this.peaks[0]?.length ?? 0

    ctx.strokeStyle = '#666'
    ctx.lineWidth = 1
    ctx.beginPath()

    for (let i = 0; i < peakLength; i += 1) {
      let magnitude = 0
      for (let channel = 0; channel < channels; channel += 1) {
        magnitude = Math.max(magnitude, Math.abs(this.peaks[channel][i] ?? 0))
      }

      const x = peakLength <= 1 ? 0 : (i / (peakLength - 1)) * width
      const halfHeight = magnitude * amplitude
      ctx.moveTo(x, centerY - halfHeight)
      ctx.lineTo(x, centerY + halfHeight)
    }
    ctx.stroke()

    ctx.fillStyle = '#2457d6'
    ctx.fillRect(loopStartX - 2, 0, 4, height)
    ctx.fillRect(loopEndX - 2, 0, 4, height)

    const cursorX = this.timeToX(this.currentTime)
    ctx.fillStyle = '#111'
    ctx.fillRect(cursorX - 1, 0, 2, height)
  }

  private eventToLocalX(event: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect()
    const contentWidth = Math.max(1, this.canvas.clientWidth || rect.width)
    const x = event.clientX - rect.left - this.canvas.clientLeft
    return this.clamp(x, 0, contentWidth)
  }

  private hasData(): boolean {
    return this.duration > 0 && this.peaks.length > 0
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
  }
}
