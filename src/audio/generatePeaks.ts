export const MAX_PEAKS_PER_CHANNEL = 4096

/**
 * Downsample an AudioBuffer to visualization-only peaks.
 *
 * Each output bucket keeps the sample with the largest absolute magnitude
 * while preserving its sign.
 */
export function generatePeaks(
  buffer: AudioBuffer,
  maxLength = MAX_PEAKS_PER_CHANNEL,
): Float32Array[] {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    throw new Error('maxLength must be greater than 0.')
  }

  const outputLength = Math.max(1, Math.min(Math.floor(maxLength), buffer.length))
  const peaks: Float32Array[] = []

  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex)
    const output = new Float32Array(outputLength)
    const sampleSize = channel.length / outputLength

    for (let bucket = 0; bucket < outputLength; bucket += 1) {
      const start = Math.floor(bucket * sampleSize)
      const end = Math.min(channel.length, Math.ceil((bucket + 1) * sampleSize))

      let peak = 0
      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = channel[sampleIndex]
        if (Math.abs(sample) > Math.abs(peak)) peak = sample
      }
      output[bucket] = peak
    }

    peaks.push(output)
  }

  return peaks
}
