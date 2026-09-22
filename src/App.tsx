import { useEffect, useRef, useState } from 'react'
import { AudioEngine } from './audio/AudioEngine'
import { generatePeaks } from './audio/generatePeaks'
import {
  getAudioFormat,
  getSizeBucket,
  trackEvent,
  type AudioLoadErrorCode,
  type LoopAdjustMethod,
  type LoopBoundary,
} from './analytics/analytics'
import { CanvasWaveformController } from './waveform/CanvasWaveformController'

type LoadStatus = 'empty' | 'loading' | 'ready' | 'error'

const MIN_LOOP_SECONDS = 0.001
const MAX_FILE_SIZE_BYTES = 64 * 1024 * 1024

function formatTime(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000'
}

function isSupportedFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.wav') || name.endsWith('.mp3')
}

function valuesDiffer(a: number, b: number): boolean {
  return Math.abs(a - b) > 0.000001
}

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  if (!engineRef.current) engineRef.current = new AudioEngine()
  const engine = engineRef.current

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const waveformControllerRef = useRef<CanvasWaveformController | null>(null)
  const loadRequestIdRef = useRef(0)
  const loopCreatedRef = useRef(false)
  const loopPlayedRef = useRef(false)
  const previousPlaybackTimeRef = useRef<number | null>(null)

  const [loadStatus, setLoadStatus] = useState<LoadStatus>('empty')
  const [fileName, setFileName] = useState('')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loopStart, setLoopStart] = useState(0)
  const [loopEnd, setLoopEnd] = useState(0)
  const [loopEnabled, setLoopEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const controller = new CanvasWaveformController({
      canvas,
      onSeek: async (requestedTime) => {
        await engine.seek(requestedTime)
        syncTimeFromEngine(controller)
        previousPlaybackTimeRef.current = engine.getCurrentTime()
      },
      onLoopPreview: (start, end) => {
        setLoopStart(start)
        setLoopEnd(end)
      },
      onLoopCommit: (start, end) => {
        const before = engine.getLoop()
        engine.setLoop({ start, end, enabled: before.enabled })
        const after = engine.getLoop()
        syncLoopFromEngine(controller)
        syncTimeFromEngine(controller)
        previousPlaybackTimeRef.current = engine.getCurrentTime()

        const startChanged = valuesDiffer(before.start, after.start)
        const endChanged = valuesDiffer(before.end, after.end)
        if (!startChanged && !endChanged) return

        if (!loopCreatedRef.current) {
          loopCreatedRef.current = true
          trackEvent({ name: 'loop_created' })
          return
        }

        const boundary: LoopBoundary = startChanged ? 'start' : 'end'
        trackEvent({ name: 'loop_adjusted', data: { boundary, method: 'waveform' } })
      },
    })

    waveformControllerRef.current = controller

    let frameId = 0
    let lastUiUpdate = 0
    const tick = (timestamp: number) => {
      const time = engine.getCurrentTime()
      controller.setCurrentTime(time)

      const playing = engine.getIsPlaying()
      const loop = engine.getLoop()
      const previousTime = previousPlaybackTimeRef.current
      if (
        playing &&
        loop.enabled &&
        !loopPlayedRef.current &&
        previousTime !== null &&
        time + 0.000001 < previousTime
      ) {
        loopPlayedRef.current = true
        trackEvent({ name: 'loop_played' })
      }
      previousPlaybackTimeRef.current = playing ? time : null

      if (timestamp - lastUiUpdate >= 100) {
        lastUiUpdate = timestamp
        setCurrentTime(time)
        setIsPlaying(playing)
      }

      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      controller.destroy()
      waveformControllerRef.current = null
      void engine.dispose()
    }
  }, [engine])

  function syncTimeFromEngine(controller = waveformControllerRef.current) {
    const actualTime = engine.getCurrentTime()
    controller?.setCurrentTime(actualTime)
    setCurrentTime(actualTime)
    setIsPlaying(engine.getIsPlaying())
  }

  function syncLoopFromEngine(controller = waveformControllerRef.current) {
    const actual = engine.getLoop()
    if (actual.end > actual.start) controller?.setLoop(actual.start, actual.end)
    setLoopStart(actual.start)
    setLoopEnd(actual.end)
    setLoopEnabled(actual.enabled)
  }

  function resetPerFileAnalytics() {
    loopCreatedRef.current = false
    loopPlayedRef.current = false
    previousPlaybackTimeRef.current = null
  }

  function resetUiForLoad() {
    engine.clear()
    waveformControllerRef.current?.clear()
    resetPerFileAnalytics()
    setFileName('')
    setDuration(0)
    setCurrentTime(0)
    setIsPlaying(false)
    setLoopStart(0)
    setLoopEnd(0)
    setLoopEnabled(false)
    setError(null)
  }

  function reportLoadError(errorCode: AudioLoadErrorCode) {
    trackEvent({ name: 'audio_load_error', data: { error_code: errorCode } })
  }

  async function loadFile(file: File) {
    const requestId = ++loadRequestIdRef.current
    resetUiForLoad()
    setLoadStatus('loading')

    if (!isSupportedFile(file)) {
      setLoadStatus('error')
      setError('Unsupported file. Please choose a WAV or MP3 file.')
      reportLoadError('unsupported_format')
      return
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setLoadStatus('error')
      setError('File is too large. Please choose a WAV or MP3 file up to 64 MiB.')
      reportLoadError('file_too_large')
      return
    }

    let decoded = false
    try {
      const buffer = await engine.load(file)
      if (requestId !== loadRequestIdRef.current) return
      decoded = true

      const newDuration = buffer.duration
      const requestedStart = newDuration >= 4 ? 1 : 0
      const requestedEnd = newDuration >= 4 ? 3 : newDuration

      engine.setLoop({ start: requestedStart, end: requestedEnd, enabled: true })
      const actualLoop = engine.getLoop()
      const peaks = generatePeaks(buffer)

      const controller = waveformControllerRef.current
      if (!controller) throw new Error('Waveform canvas is not mounted.')

      controller.load(peaks, newDuration, {
        start: actualLoop.start,
        end: actualLoop.end,
      })

      setFileName(file.name)
      setDuration(newDuration)
      setCurrentTime(engine.getCurrentTime())
      setIsPlaying(false)
      setLoopStart(actualLoop.start)
      setLoopEnd(actualLoop.end)
      setLoopEnabled(actualLoop.enabled)
      setLoadStatus('ready')

      const analyticsFormat = getAudioFormat(file)
      const analyticsSizeBucket = getSizeBucket(file.size)
      trackEvent({
        name: 'audio_loaded',
        data: {
          format: analyticsFormat,
          size_bucket: analyticsSizeBucket,
        },
      })
    } catch {
      if (requestId !== loadRequestIdRef.current) return
      engine.clear()
      waveformControllerRef.current?.clear()
      resetPerFileAnalytics()
      setFileName('')
      setDuration(0)
      setCurrentTime(0)
      setIsPlaying(false)
      setLoopStart(0)
      setLoopEnd(0)
      setLoopEnabled(false)
      setLoadStatus('error')
      setError(decoded
        ? 'Could not prepare audio playback in this browser.'
        : 'Could not decode this WAV/MP3 file. The file may be damaged or unsupported by this browser.')
      reportLoadError(decoded ? 'browser_error' : 'decode_failed')
    }
  }

  async function play() {
    setError(null)
    try {
      await engine.play()
      syncTimeFromEngine()
      previousPlaybackTimeRef.current = engine.getCurrentTime()
    } catch (playError) {
      setError(playError instanceof Error ? playError.message : 'Playback failed.')
    }
  }

  function pause() {
    engine.pause()
    syncTimeFromEngine()
    previousPlaybackTimeRef.current = null
  }

  function toggleLoop(enabled: boolean) {
    setError(null)
    try {
      const current = engine.getLoop()
      engine.setLoop({ start: current.start, end: current.end, enabled })
      syncLoopFromEngine()
      syncTimeFromEngine()
      previousPlaybackTimeRef.current = engine.getIsPlaying() ? engine.getCurrentTime() : null
    } catch (loopError) {
      setError(loopError instanceof Error ? loopError.message : 'Could not change loop state.')
    }
  }

  function recordLoopAdjustment(boundary: LoopBoundary, method: LoopAdjustMethod) {
    if (!loopCreatedRef.current) {
      loopCreatedRef.current = true
      trackEvent({ name: 'loop_created' })
      return
    }
    trackEvent({ name: 'loop_adjusted', data: { boundary, method } })
  }

  function adjustLoop(boundary: LoopBoundary, delta: number) {
    if (loadStatus !== 'ready') return

    setError(null)
    try {
      const before = engine.getLoop()
      let start = before.start
      let end = before.end

      if (boundary === 'start') {
        start = Math.min(
          Math.max(0, start + delta),
          Math.max(0, end - MIN_LOOP_SECONDS),
        )
      } else {
        end = Math.max(
          Math.min(duration, end + delta),
          Math.min(duration, start + MIN_LOOP_SECONDS),
        )
      }

      engine.setLoop({ start, end, enabled: before.enabled })
      const after = engine.getLoop()
      syncLoopFromEngine()
      syncTimeFromEngine()
      previousPlaybackTimeRef.current = engine.getIsPlaying() ? engine.getCurrentTime() : null

      const changed = boundary === 'start'
        ? valuesDiffer(before.start, after.start)
        : valuesDiffer(before.end, after.end)
      if (!changed) return

      recordLoopAdjustment(boundary, Math.abs(delta) === 0.01 ? 'nudge_0_01' : 'nudge_0_1')
    } catch (adjustError) {
      setError(adjustError instanceof Error ? adjustError.message : 'Could not adjust loop.')
    }
  }

  const ready = loadStatus === 'ready'

  return (
    <main style={{ maxWidth: 760, margin: '40px auto', padding: 24, fontFamily: 'sans-serif' }}>
      <h1>Audio Loop Point Tester</h1>
      <p>Find the right loop start and end points in your MP3 or WAV file.</p>
      <p>Adjust them on the waveform, fine-tune the timing, and hear the selected section repeat instantly.</p>
      <p><strong>Files stay in your browser. No upload. No login.</strong></p>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files?.[0]
          if (file) void loadFile(file)
        }}
        style={{ padding: 20, border: '1px dashed #999', marginBottom: 16 }}
      >
        <input
          type="file"
          accept=".wav,.mp3,audio/wav,audio/mpeg"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void loadFile(file)
            event.currentTarget.value = ''
          }}
        />
        <span style={{ marginLeft: 8 }}>or drag &amp; drop</span>
        <p style={{ marginBottom: 0 }}>MP3 / WAV · Up to 64 MiB · Processed locally in your browser</p>
      </div>

      {loadStatus === 'loading' && <p>Loading audio…</p>}
      {error && <p>{error}</p>}

      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: 160, marginTop: 16 }}
      />

      {ready && (
        <>
          <p>File: {fileName}</p>
          <p>Time: {formatTime(currentTime)} / {formatTime(duration)}</p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <button disabled={isPlaying} onClick={() => void play()}>Play</button>
            <button disabled={!isPlaying} onClick={pause}>Pause</button>
            <label>
              <input
                type="checkbox"
                checked={loopEnabled}
                onChange={(event) => toggleLoop(event.target.checked)}
              />
              Loop
            </label>
          </div>

          <div>
            <p>Start: <strong>{formatTime(loopStart)}</strong>s</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => adjustLoop('start', -0.1)}>Start -0.10</button>
              <button onClick={() => adjustLoop('start', -0.01)}>Start -0.01</button>
              <button onClick={() => adjustLoop('start', 0.01)}>Start +0.01</button>
              <button onClick={() => adjustLoop('start', 0.1)}>Start +0.10</button>
            </div>

            <p>End: <strong>{formatTime(loopEnd)}</strong>s</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => adjustLoop('end', -0.1)}>End -0.10</button>
              <button onClick={() => adjustLoop('end', -0.01)}>End -0.01</button>
              <button onClick={() => adjustLoop('end', 0.01)}>End +0.01</button>
              <button onClick={() => adjustLoop('end', 0.1)}>End +0.10</button>
            </div>
          </div>
        </>
      )}

      <section>
        <h2>How it works</h2>
        <ol>
          <li>Choose or drop an MP3 or WAV file.</li>
          <li>Drag the loop start and end points on the waveform.</li>
          <li>Play the loop and fine-tune either boundary by 0.01 or 0.1 seconds.</li>
        </ol>
      </section>

      <section>
        <h2>Privacy &amp; Limits</h2>
        <p>Your audio file is processed locally in your browser and is not uploaded to our server or to the analytics provider.</p>
        <p>Basic usage events are measured with Umami Cloud. File names, local paths, audio contents, and exact loop values are not sent.</p>
        <p>WAV and MP3 files up to 64 MiB are supported.</p>
      </section>

      <section>
        <h2>FAQ</h2>
        <h3>Is my audio uploaded?</h3>
        <p>No. Audio processing stays in your browser.</p>
        <h3>Which audio formats are supported?</h3>
        <p>WAV and MP3.</p>
        <h3>Can I export or download the looped audio?</h3>
        <p>No. Export and download are not supported.</p>
      </section>
    </main>
  )
}
