const express = require('express');

const { updateSensor } = require('./handlers/sensorHandler');
const { 
  assignDeviceIpAddress,
  triggerDevice,
  devices,
  setDailyEvents,
  getDailyEvents,
  getDevices
} = require('./handlers/deviceHandler');

const { log, EVENT_TYPE } = require('./logger');

const app = express();
const PORT = 8080;

setDailyEvents();

app.use(express.json());

app.listen(PORT, () => {
  console.log('App working at: ', PORT);
});

app.post('/sensor-signal', (request, response) => {
  updateSensor(request.body.id, request.body.value);
  response.send(true);
});

app.post('/ping', (request, response) => {
  log(EVENT_TYPE.ping, [request.body.sensor]);
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

app.get('/get-daily-events', (request, response) => {
  response.send(getDailyEvents());
});

app.get('/get-devices', (request, response) => {
  response.send(getDevices());
});