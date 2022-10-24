import JSONdb from 'simple-json-db';
import { Sensor } from '../classes/sensor.class';
export const SensorsDB = new JSONdb('db/sensors.db.json');

// These get populated as sensors join the local network
export const sensors: Sensor[] = [];

export function updateSensor(sensorId: string, value: any) {
  let sensor: Sensor = sensors.find(sensor => sensor.id === sensorId);
  if (sensor) sensor.update(value);
}

export function getSensorsData() {
  return sensors.map(buildClientSensorData);
}

export function buildClientSensorData(sensor: Sensor) {
  return {
    id: sensor.id,
    type: sensor.type,
    name: sensor.name,
    value: sensor.value
  };
}
