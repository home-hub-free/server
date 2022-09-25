import { Sensor, SensorTypesToDataTypes } from "../classes/sensor.class";
import { buildClientSensorData, getSensorsData, sensors } from "../handlers/sensorHandler";
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
    let sensor = sensors.find((sensor) => sensor.id === id);
    if (sensor) {
      response.send(true);
    } else {
      sensor = new Sensor(id, name, SensorTypesToDataTypes[name]);
      io.emit('sensor-declare', buildClientSensorData(sensor));
      sensors.push(sensor);
      response.send(true);
    }
  });

  // Called whenever a sensor's data is updated and its notified to the server
  app.post("/sensor-update", (request, response) => {
    let { id } = request.body;
    let sensor = sensors.find((sensor) => sensor.id === id);
    if (sensor && request.body.value) {
      sensor.update(request.body.value);
      response.send(true);
    } else {
      response.send(false);
    }
  });
}
