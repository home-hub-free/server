import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import fs from "fs";

type RecorderOpts = {
  cameraId: string;
  segmentSeconds?: number; // default 3600
  outDirRecordings?: string; // default ./recordings
  outDirPublic?: string; // default ./public
  fps?: number; // nominal fps for HLS/keyframe spacing, default 10
  useHardware?: boolean; // mac: h264_videotoolbox, else fallback to libx264
};

export class CameraRecorder {
  private ff: ChildProcessWithoutNullStreams | null = null;
  private opts: Required<RecorderOpts>;

  constructor(opts: RecorderOpts) {
    this.opts = {
      cameraId: opts.cameraId,
      segmentSeconds: opts.segmentSeconds ?? 3600,
      outDirRecordings: opts.outDirRecordings ?? "./recordings",
      outDirPublic: opts.outDirPublic ?? "./public",
      fps: opts.fps ?? 10,
      useHardware: opts.useHardware ?? true,
    };
  }

  start() {
    const {
      cameraId,
      outDirRecordings,
      outDirPublic,
      segmentSeconds,
      fps,
      useHardware,
    } = this.opts;

    // Ensure directories exist
    const recDir = path.resolve(outDirRecordings, cameraId);
    const hlsDir = path.resolve(outDirPublic, cameraId);
    fs.mkdirSync(recDir, { recursive: true });
    fs.mkdirSync(hlsDir, { recursive: true });

    // Outputs
    const segmentOut = path.join(recDir, "%03d.mp4"); // hourly segments: 000.mp4, 001.mp4, ...
    const hlsOut = path.join(hlsDir, "live.m3u8"); // HLS playlist & segments here

    // Choose encoder
    const vCodec = "libx264";

    // Keyframe interval aligned to HLS chunk length (~2s)
    // g = fps * 2; keep keyframes every 2s so each HLS segment is independently decodable.
    const gop = Math.max(2, fps * 2);

    // Build tee arg (no shell quoting; pass as single arg)
    const teeArg = [
      `[f=segment:segment_time=${segmentSeconds}:reset_timestamps=1]${segmentOut}`,
      `[f=hls:hls_time=2:hls_list_size=20:hls_flags=delete_segments+append_list+independent_segments:hls_segment_type=fmp4]${hlsOut}`,
    ].join("|");

    this.ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",

        // Input: MJPEG frames over stdin
        "-f",
        "mjpeg",
        "-fflags",
        "+genpts",
        "-r",
        String(fps), // nominal rate for smoother timing
        "-i",
        "pipe:0",

        // Encode H.264 (GPU on Mac if available)
        "-c:v",
        vCodec,
        ...(useHardware ? [] : ["-preset", "veryfast", "-tune", "zerolatency"]),
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(gop),
        "-keyint_min",
        String(gop),
        "-sc_threshold",
        "0",
        "-movflags",
        "+faststart",

        // Map video
        "-map",
        "0:v",

        // Tee to two outputs
        "-f",
        "tee",
        teeArg,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    this.ff.stderr.on("data", (d) =>
      console.log(`[ffmpeg:${cameraId}] ${d.toString()}`),
    );
    this.ff.on("exit", (code) =>
      console.log(`[ffmpeg:${cameraId}] exited with code ${code}`),
    );

    console.log(
      `[recorder:${cameraId}] started → ${recDir} (segments), ${hlsDir} (HLS)`,
    );
  }

  writeFrame(jpegBuf: Buffer) {
    if (this.ff?.stdin.writable) {
      this.ff.stdin.write(jpegBuf);
    }
  }

  stop() {
    if (!this.ff) return;
    try {
      // Close stdin so ffmpeg finalizes outputs
      this.ff.stdin.end();
      this.ff.kill("SIGINT");
    } catch (_) {}
    this.ff = null;
  }
}
