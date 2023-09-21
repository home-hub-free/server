// import { Device } from "../classes/device.class";
// import dgram from 'dgram';
// import fs from 'fs';
// import path from 'path';
// import videoshow from 'videoshow';
// const streams: { [key: string]: dgram.Socket } = {};
// const images: { [key: string]: (string | Buffer)[] } = {};

// export function createStorageStream(camera: Device) {
//   if (camera.deviceCategory != 'camera') return;

//   if (!streams[camera.ip]) {
//     const client = getClient();
//     validateCameraStoragePath(camera);
//     let buffer: Buffer = Buffer.from('');
//     images[camera.ip] = [];
  
//     client.on('message', (msg) => {
//       const utf = msg.toString('utf-8'); 

//       switch (utf) {
//         case 'start':
//           buffer = Buffer.from('');
//           break;
//         case 'end':
//           const filePath = path.resolve(
//             'storage',
//             camera.id,
//             'pictures',
//             `frame-${images[camera.ip].length}.jpg`
//           );
//           fs.writeFile(filePath, buffer, "binary", (err) => {});
//           images[camera.ip].push(filePath);

//           if (images[camera.ip].length > 200) {
//             joinBufferedFrames(camera);
//             clearBufferedFrames(camera);
//           };
//           break;
//         default:
//           buffer = Buffer.concat([buffer, msg]);
//       }
//     });

//     client.on('error', (err) => {
//       console.error(`server error:\n${err.stack}`);
//       client.close();
//       delete streams[camera.ip];
//     });
  
//     const data = Buffer.from('#01\r');
//     // Initialized the stream
//     client.send(data, 82, camera.ip);
//     streams[camera.ip] = client;
//   }
// }

// function getClient() {
//   return dgram.createSocket({
//     type: 'udp4',
//     reuseAddr: true,
//   });
// }

// function validateCameraStoragePath(camera: Device) {
//   if (!fs.existsSync(path.resolve('storage', camera.id))) {
//     fs.mkdirSync(path.resolve('storage', camera.id));
//     fs.mkdirSync(path.resolve('storage', camera.id, 'clips'));
//     fs.mkdirSync(path.resolve('storage', camera.id, 'pictures'));
//   }
// }

// // Turns the buffered frames into 2 second video clips
// function joinBufferedFrames(camera: Device) {
//   const date = new Date();
//   const time = date.toLocaleTimeString();
//   const day = date.toLocaleDateString().replaceAll('/', '-');

//   const dayPath = path.resolve(
//     'storage',
//     camera.id,
//     'clips',
//     day
//   );
//   if (!fs.existsSync(dayPath)) {
//     fs.mkdirSync(dayPath);
//   }
//   videoshow(images[camera.ip], {
//     fps: 25,
//     loop: 0.1,
//     format: 'mp4',
//     transition: false,
//   })
//   .save(path.resolve(dayPath,`${time}.mp4`))
// }

// function clearBufferedFrames(camera: Device) {
//   images[camera.ip] = []
// }
