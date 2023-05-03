import JSONdb from 'simple-json-db';
import { Sensor } from '../classes/sensor.class';
export const SensorsDB = new JSONdb('db/sensors.db.json');

// const testHumiditySensor = new Sensor('123', 'temp/humidity', 'value')
// testHumiditySensor.value = '23.5:10.5'

// These get populated as sensors join the local network
export const sensors: Sensor[] = [
  // new Sensor('1234', 'motion', 'boolean'),
  // testHumiditySensor
  // new Sensor('123', 'temp/humidity', 'value'),
];

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
    value: sensor.value,
    sensorType: sensor.sensorType,
  };
}
