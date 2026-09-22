export async function decodeAudioFile(
  context: AudioContext,
  file: File,
): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer()
  return await context.decodeAudioData(arrayBuffer)
}
