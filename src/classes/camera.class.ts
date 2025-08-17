import { Server } from "socket.io";
import { Device } from "./device.class";
import dgram from "dgram";
import { spawn } from "child_process";
import { CameraRecorder } from "./camera.recorder";

export class CameraConnection {
  feed = dgram.createSocket({
    type: "udp4",
    reuseAddr: true,
  });

  // latest full frame
  currentFrame: Buffer;
  currentFrameTS = new Date();
  // currentFrame

  // frame being constructed
  buffer = Buffer.from("");
  expectedLength: number;
  receivedLength: number;

  recorder: CameraRecorder;

  ws: Server;
  camera: Device;
  timeout: NodeJS.Timeout;
  onDisconnect: () => void;

  constructor(_ws: Server, _camera: Device) {
    this.ws = _ws;
    this.camera = _camera;

    this.feed.on("connect", () => {
      console.log(this.camera.ip + " connection started");
    });

    this.feed.on("message", (message) => {
      this.handleMessage(message);
    });

    this.feed.on("close", () => {
      console.log(this.camera.ip + " connection closed");
      this.onDisconnect();
    });

    this.feed.on("error", () => {
      this.onDisconnect();
      console.log(this.camera.ip + " something went wrong");
    });

    // Initilizes the feed
    this.requestConnection();

    // Start ffmpeg dual-output recorder for this camera
    this.recorder = new CameraRecorder({
      cameraId: this.camera.id,
      segmentSeconds: 360, // 1-minute files; change to 86400 for daily
      outDirRecordings: "./recordings",
      outDirPublic: "./public",
      fps: 10, // tune if you know your frame cadence
      useHardware: true, // set false if you're on Linux without VAAPI
    });
    this.recorder.start();

    setInterval(() => {
      const now = new Date().getTime();
      const lastTS = this.currentFrameTS.getTime();

      if (now - lastTS > 30_000) {
        this.onDisconnect();
      }
    }, 5000);
  }

  private handleMessage(message) {
    this.startDisconnectTimeout();

    const value = message.toString("utf-8");

    if (value.startsWith("START:")) {
      const length = parseInt(value.split(":")[1], 10);
      this.onFrameStart(length);
    } else if (value === "END") {
      this.onFrameEnd();
    } else {
      this.onFrameData(message);
    }
  }

  private onFrameStart(length: number) {
    this.expectedLength = length;
    this.receivedLength = 0;
    this.buffer = Buffer.alloc(length);
  }

  private onFrameData(message: Buffer) {
    message.copy(this.buffer, this.receivedLength);
    this.receivedLength += message.length;
  }

  private onFrameEnd() {
    if (this.receivedLength === this.expectedLength) {
      this.currentFrame = this.buffer;
      this.currentFrameTS = new Date();

      // Send binary buffer directly
      this.ws.emit(this.camera.id, this.buffer);

      // TODO: pipe into ffmpeg here if needed
      this.recorder.writeFrame(this.buffer);
    } else {
      console.warn(
        "Frame size mismatch",
        this.receivedLength,
        this.expectedLength,
      );
    }
  }

  private startDisconnectTimeout() {
    if (this.timeout) clearTimeout(this.timeout);

    this.timeout = setTimeout(() => {
      // If we reach this point, the camera completely disconnected
      this.timeout = null;
      if (this.onDisconnect) this.onDisconnect();
    }, 1000);
  }

  requestConnection() {
    // Initilizes the feed
    const data = Buffer.from("#01\r");
    this.feed.send(data, 82, this.camera.ip);
  }
}
