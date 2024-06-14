import { Device } from "../classes/device.class";
import { Server } from "socket.io";
import { CameraConnection } from "../classes/camera.class";

const connections: { [key: string]: CameraConnection } = {}; 

const cameraWSServer = new Server({
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

cameraWSServer.on('connect', () => {
  console.log('connection');
})

cameraWSServer.listen(8082);

export function createStorageStream(camera: Device) {
  if (camera.deviceCategory != 'camera') return;

  // Connection already exists, return
if (connections[camera.ip]) return;

  const connection = new CameraConnection(cameraWSServer, camera);
  connection.onDisconnect = () => {
    delete connections[camera.ip];
  }
  connections[camera.ip] = connection;

}