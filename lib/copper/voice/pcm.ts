// Audio in the shape Gemini Live wants: 16 kHz, 16-bit mono PCM going up,
// 24 kHz 16-bit PCM coming back, both base64 in JSON messages.

export const INPUT_RATE = 16_000;
export const OUTPUT_RATE = 24_000;

/** Averages a microphone buffer down to 16 kHz (browsers record at 44.1 or 48 kHz). */
export function downsample(
  samples: Float32Array,
  fromRate: number,
): Float32Array {
  if (fromRate <= INPUT_RATE) return samples;
  const ratio = fromRate / INPUT_RATE;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Float samples (-1 to 1) to little-endian 16-bit PCM, base64. */
export function encodePcm16(samples: Float32Array): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  samples.forEach((s, i) => {
    const clamped = Math.max(-1, Math.min(1, s));
    view.setInt16(
      i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  });
  return toBase64(new Uint8Array(view.buffer));
}

/** Base64 little-endian 16-bit PCM back to float samples. */
export function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++)
    view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < out.length; i++)
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}
