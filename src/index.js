const express = require('express');
const cors = require('cors');
const { updateSensor } = require('./handlers/sensorHandler');
const { 
  assignDeviceIpAddress,
  triggerDevice,
  manualTrigger,
  devices,
  setDailyEvents,
  getDailyEvents,
  setEvent,
  getDevices
} = require('./handlers/deviceHandler');

const { log, EVENT_TYPES } = require('./logger');

const app = express();
const PORT = 8080;

setDailyEvents();

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

app.get('/manual-trigger', (request, response) => {
  if (request.query.device && request.query.value) {
    let device = devices.find(device =>  device.id == request.query.device);
    if (device) triggerDevice(device, request.query.value, true);
  }

  response.send(true);
});

app.post('/manual-control', (request, response) => {
  let device = devices.find(device => device.id === request.body.device);
  if (device) {
    manualTrigger(device, request.body.value);
    device.manual = request.body.manual;
  }

  response.send(true);
});

app.get('/get-daily-events', (request, response) => {
  response.send(getDailyEvents());
});

app.post('/set-daily-event', (request, response) => {
  let name = request.body.name;
  let description = request.body.description;
  let deviceId = request.body.device;
  let value = request.body.value;
  let date = request.body.date;
  if (!name || !description || !deviceId || !value) {
    response.send(false);
  } else {
    let device = devices.find((device) => device.id === deviceId);
    if (device) {
      setEvent(name, descriptionm, date, () => {
        triggerDevice(device, value, true);
      });
      response.send(true);
    } else {
      response.send(false);
    }
  }
});

app.get('/get-devices', (request, response) => {
  response.send(getDevices());
});