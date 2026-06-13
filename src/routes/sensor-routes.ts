import { Sensor, SensorTypesToDataTypes } from "../classes/sensor.class";
import { buildClientSensorData, getSensorsData, sensors, SensorsDB } from "../handlers/sensor.handler";
import { Express } from "express";
import { io } from "../handlers/websockets.handler";
import axios from "axios";

export function initSensorRoutes(app: Express) {
  app.get("/get-sensors", (request, response) => {
    response.send(getSensorsData());
  });

  // Called when a sensor connects to the networks and relays its infromation
  // to the server (Also used as a ping function each 10 seconds)
  app.post("/sensor-declare", (request, response) => {
    let { id, name, ip } = request.body;
    let sensor = sensors.find((sensor) => String(sensor.id) === String(id));

    if (!sensor) {
      sensor = new Sensor(id, name, SensorTypesToDataTypes[name]);
      if (ip) sensor.ip = ip;
      io.emit('sensor-declare', buildClientSensorData(sensor));
      sensors.push(sensor);
    } else {
      sensor.lastPing = new Date();
      if (ip) sensor.ip = ip;
    }
    response.send(true);
  });

  // Called whenever a sensor's value is updated and its notified to the server
  app.post("/sensor-update", (request, response) => {
    let { id, value } = request.body;
    let sensor = sensors.find((sensor) => String(sensor.id) === String(id));
    if (sensor && value !== undefined) {
      sensor.update(value);
      response.send(true);
    } else {
      response.send(false);
    }
  });

  // Updates information about sensor that lives in DB
  app.post('/sensors-data-set', (request, response) => {
    let sensor = sensors.find((sensor) => sensor.id === request.body.id);
    if (!sensor) return response.send(false);
    if (!request.body.data) response.send(false);

    let incomingData = request.body.data;
    let dbStoredData = SensorsDB.get(sensor.id);
    if (!dbStoredData) {
      SensorsDB.set(sensor.id, incomingData);
    } else {
      Object.keys(incomingData).forEach(key => {
        dbStoredData[key] = incomingData[key]
      });
      SensorsDB.set(sensor.id, dbStoredData);
    }

    sensor.mergeDBData();
    io.emit('sensor-update', buildClientSensorData(sensor));
    response.send(true);
  });

  // Trigger calibration mode on presence sensor
  app.post('/sensor-calibrate', async (request, response) => {
    let { id } = request.body;
    let sensor = sensors.find((sensor) => sensor.id === id);

    if (!sensor || !sensor.ip) {
      return response.status(400).send({ error: 'Sensor not found or IP unknown' });
    }

    try {
      const calibrateUrl = `http://${sensor.ip}/recalibrate`;
      await axios.post(calibrateUrl, {}, { timeout: 5000 });
      response.send({ ok: true });
    } catch (err) {
      console.error(`Failed to calibrate sensor ${id} at ${sensor.ip}:`, err.message);
      response.status(500).send({ error: 'Failed to reach device' });
    }
  });
}
