import { Sensor, SensorTypesToDataTypes } from "../classes/sensor.class";
import { buildClientSensorData, getSensorsData, sensors, SensorsDB } from "../handlers/sensorHandler";
import { Express } from "express";
import { io } from "../handlers/websocketHandler";

export function initSensorRoutes(app: Express) {
  app.get("/get-sensors", (request, response) => {
    response.send(getSensorsData());
  });

  // Called when a sensor connects to the networks and relays its infromation
  // to the server (Also used as a ping function each 10 seconds)
  app.post("/sensor-declare", (request, response) => {
    let { id, name } = request.body;
    let sensor = sensors.find((sensor) => String(sensor.id) === String(id));

    if (!sensor) {
      sensor = new Sensor(id, name, SensorTypesToDataTypes[name]);
      io.emit('sensor-declare', buildClientSensorData(sensor));
      sensors.push(sensor);
    }
    response.send(true);
  });

  // Called whenever a sensor's data is updated and its notified to the server
  app.post("/sensor-update", (request, response) => {
    let { id } = request.body;
    let sensor = sensors.find((sensor) => String(sensor.id) === String(id));
    if (sensor && request.body.value !== undefined) {
      sensor.update(request.body.value);
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
    response.send(true);
  });
}
