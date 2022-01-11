import express, { Express } from 'express';
import cors from 'cors';
import storage from 'node-persist';
import { updateSensor } from './handlers/sensorHandler';
import { getRoomsStates } from './handlers/roomHandler';
import { initLocalSensors } from './local-sensors';
import { log, EVENT_TYPES } from './logger';
import {
  assignDeviceIpAddress,
  devices,
  getDevices,
  initDailyDevices
} from './handlers/deviceHandler';
import {
  getTodayWeather,
  getDailyEvents
} from './handlers/dailyEventsHandler';

const app: Express = express();
const PORT = 8080;

storage.init({
  dir: './data',
  stringify: JSON.stringify,
  parse: JSON.parse,
  encoding: 'utf8',
  logging: false,  // can also be custom logging function
  ttl: false, // ttl* [NEW], can be true for 24h default or a number in MILLISECONDS or a valid Javascript Date object
  expiredInterval: 2 * 60 * 1000, // every 2 minutes the process will clean-up the expired cache
  // in some cases, you (or some other service) might add non-valid storage files to your
  // storage dir, i.e. Google Drive, make this true if you'd like to ignore these files and not throw an error
  forgiveParseErrors: false
});

getTodayWeather();
initDailyDevices();
initLocalSensors();

app.use(express.json());
app.use(cors());
app.options('*', cors());

app.listen(PORT, () => {
  console.log('App working at: ', PORT);
});

app.post('/sensor-signal', (request, response) => {
  updateSensor(request.body.id, request.body.value);
  response.send(true);
});

app.post('/ping', (request, response) => {
  log(EVENT_TYPES.ping, [request.body.sensor]);
  response.send(true);
});

app.post('/add-device-ip', (request, response) => {
  assignDeviceIpAddress(request.body.device, request.ip);
  response.send(true);
});

app.post('/manual-control', (request, response) => {
  let device = devices.find(device => device.id === request.body.device);
  if (device) {
    // Avoid changing value type devices to manual mode for now
    device.manualTrigger(request.body.value, request.body.manual && device.type !== 'value').then(() => {
      response.send(true);
    }).catch(() => {
      response.send(false);
    });
  }
});

app.get('/get-daily-events', (request, response) => {
  response.send(getDailyEvents());
});

app.post('/set-daily-event', (request, response) => {
  // let name = request.body.name;
  // let description = request.body.description;
  // let deviceId = request.body.device;
  // let value = request.body.value;
  // let date = request.body.date;
  // if (!name || !description || !deviceId || !value) {
  //   response.send(false);
  // } else {
  //   let device = devices.find((device) => device.id === deviceId);
  //   if (device) {
  //     addDailyEvent(name, date, () => {
  //       autoTrigger(device, value);
  //     });
  //     response.send(true);
  //   } else {
  //     response.send(false);
  //   }
  // }
});

app.get('/get-devices', (request, response) => {
  response.send(getDevices());
});

app.get('/get-room-states', (request, response) => {
  response.send(getRoomsStates());
});