import { Server } from "socket.io";
import { Device } from "./device.class";
import dgram from 'dgram';

enum FEED_MESSAGE {
  START = 'start',
  END = 'end',
}

export class CameraConnection {
  feed = dgram.createSocket({
    type: 'udp4',
    reuseAddr: true,
  });

  // latest full frame
  currentFrame: Buffer;
  currentFrameTS = new Date();
  // currentFrame

  // frame being constructed
  buffer = Buffer.from('');

  ws: Server;
  camera: Device;
  timeout: NodeJS.Timeout;
  onDisconnect: () => void;

  constructor(_ws: Server, _camera: Device) {
    this.ws = _ws;
    this.camera = _camera;

    this.feed.on('connect', () => {
      console.log(this.camera.ip + ' connection started');
    });

    this.feed.on('message', (message) => {
      this.handleMessage(message);
    });

    this.feed.on('close', () => {
      console.log(this.camera.ip + ' connection closed');
      this.onDisconnect();
    });

    this.feed.on('error', () => {
      this.onDisconnect();
      console.log(this.camera.ip + ' something went wrong');
    });

    // Initilizes the feed
    this.requestConnection();

    setInterval(() => {
      const now = new Date().getTime();
      const lastTS = this.currentFrameTS.getTime();

      if (now - lastTS > 30_000) {
        this.onDisconnect();
      }
    }, 5000)
  }

  private handleMessage(message) {
    this.startDisconnectTimeout();
    const value = message.toString('utf-8');
    switch (value) {
      case FEED_MESSAGE.START:
        this.onFrameStart();
        break;
      case FEED_MESSAGE.END:
        this.onFrameEnd();
        break;
      default:
        this.onFrameData(message);
    }
  }

  private onFrameStart() {
    this.buffer = Buffer.from('');
  }

  private onFrameData(message) {
    this.buffer = Buffer.concat([this.buffer, message])
  }

  private onFrameEnd() {
    this.currentFrame = this.buffer;
    this.currentFrameTS = new Date();
    const data = `data:image/jpg;base64,${this.buffer.toString("base64")}`;
    
    // Broadcast every complete frame
    this.ws.emit(this.camera.id, data);
  }

  private startDisconnectTimeout() {
    if (this.timeout) clearTimeout(this.timeout);

    this.timeout = setTimeout(() => {
      // If we reach this point, the camera completely disconnected
      this.timeout = null;
      if (this.onDisconnect) this.onDisconnect();
    }, 1000)
  }

  requestConnection() {
    // Initilizes the feed
    const data = Buffer.from('#01\r');
    this.feed.send(data, 82, this.camera.ip);
  }
}