/**
 * Hub → tts-service client.
 *
 * Replaces the AWS Polly call site in v-assistant. POSTs plain text to
 * `tts-service /tts` (Fish Speech 1.5, Mexican-Spanish reference by default) and
 * streams the WAV bytes to disk so play-sound can play them through the
 * existing audio sink.
 *
 * - Plain text only (no emotion/prosody tags); tone comes from the reference.
 * - Default reference is the service-side `mx-default.wav`; override per call
 *   via `reference` if a specific voice is wanted.
 * - Fire-and-forget if the service is down: rejects with a tagged error so the
 *   caller can fall back to a silent log instead of crashing the queue.
 */
import axios from "axios";
import fs from "fs";

const TTS_URL = process.env.TTS_URL || "http://127.0.0.1:8100";
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30000);

export interface SynthesizeOpts {
  text: string;
  outPath: string;
  reference?: string;
}

export async function synthesizeToFile(opts: SynthesizeOpts): Promise<void> {
  const res = await axios.post(
    `${TTS_URL}/tts`,
    { text: opts.text, reference: opts.reference },
    { responseType: "stream", timeout: TTS_TIMEOUT_MS },
  );
  await new Promise<void>((resolve, reject) => {
    const sink = fs.createWriteStream(opts.outPath);
    res.data.pipe(sink);
    sink.on("finish", () => resolve());
    sink.on("error", reject);
    res.data.on("error", reject);
  });
}
