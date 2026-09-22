type AudioFormat = 'mp3' | 'wav'
type SizeBucket = 'under_8_mib' | '8_to_32_mib' | '32_to_64_mib'
type LoopBoundary = 'start' | 'end'
type LoopAdjustMethod = 'waveform' | 'nudge_0_01' | 'nudge_0_1'
type AudioLoadErrorCode =
  | 'unsupported_format'
  | 'file_too_large'
  | 'decode_failed'
  | 'browser_error'

type AnalyticsEvent =
  | { name: 'audio_loaded'; data: { format: AudioFormat; size_bucket: SizeBucket } }
  | { name: 'loop_created' }
  | { name: 'loop_played' }
  | { name: 'loop_adjusted'; data: { boundary: LoopBoundary; method: LoopAdjustMethod } }
  | { name: 'audio_load_error'; data: { error_code: AudioLoadErrorCode } }

declare global {
  interface Window {
    umami?: {
      track(eventName: string, data?: Record<string, string>): void
    }
  }
}

const productionDomain = import.meta.env.VITE_PRODUCTION_DOMAIN as string | undefined

function isProductionAnalyticsHost(): boolean {
  if (!productionDomain) return false
  return window.location.hostname === productionDomain
}

export function trackEvent(event: AnalyticsEvent): void {
  if (!isProductionAnalyticsHost()) return
  if (!window.umami?.track) return

  if ('data' in event) window.umami.track(event.name, event.data)
  else window.umami.track(event.name)
}

export function getAudioFormat(file: File): AudioFormat {
  return file.name.toLowerCase().endsWith('.mp3') ? 'mp3' : 'wav'
}

export function getSizeBucket(sizeBytes: number): SizeBucket {
  const MIB = 1024 * 1024
  if (sizeBytes < 8 * MIB) return 'under_8_mib'
  if (sizeBytes < 32 * MIB) return '8_to_32_mib'
  return '32_to_64_mib'
}

export type { AudioLoadErrorCode, LoopAdjustMethod, LoopBoundary }
