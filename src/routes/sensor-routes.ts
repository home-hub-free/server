import { Sensor, SensorTypesToDataTypes } from "../classes/sensor.class";
import { getSensorsData, sensors } from "../handlers/sensorHandler";
import { Express } from "express";

export function initSensorRoutes(app: Express) {

  app.get("/get-sensors", (request, response) => {
    response.send(getSensorsData());
  });

  // Called whenever a sensor's data is updated and its notified to the server
  app.post("/sensor-update", (request, response) => {
    let { id } = request.body;
    let sensor = sensors.find((sensor) => sensor.id === id);
    if (sensor) {
      sensor.update(request.body.value);
      response.send(true);
    } else {
      response.send(false);
    }
  });

  // Called when a sensor connects to the networks and relays its infromation
  // to the server
  app.post("/sensor-declare", (request, response) => {
    let { id, name } = request.body;
    let sensor = sensors.find((sensor) => sensor.id === id);
    if (sensor) {
      response.send(true);
    } else {
      sensor = new Sensor(id, name, SensorTypesToDataTypes[name]);
      sensors.push(sensor);
      response.send(true);
    }
  });
}
