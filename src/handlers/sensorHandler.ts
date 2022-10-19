import JSONdb from 'simple-json-db';
import { Sensor } from '../classes/sensor.class';
import { devices } from './deviceHandler';
import { io } from './websocketHandler';

export const SensorsDB = new JSONdb('db/sensors.db.json');

// These get populated as sensors join the local network
export const sensors: Sensor[] = [
  new Sensor('12301', 'Fake sensor', 'boolean')
];


export function updateSensor(sensorId: string, value: any) {
  let sensor: Sensor = sensors.find(sensor => sensor.id === sensorId);
  if (sensor) sensor.update(value);
}

export function getSensorsData() {
  return sensors.map(buildClientSensorData);
}

export function mergeSensorData(sensor: Sensor, data: any) {
  Object.keys(data).forEach((key: string) => {
    if (sensor[key]) sensor[key] = data[key];
  });
} 

// When a programmable action involves a sensor we set them here
export function addSensorEffect(effect: any) {
  let id = effect.when.id;
  let sensor = sensors.find(sens => sens.id === id);
  let device = devices.find(dev => dev.id === effect.set.id);

  // Parse it because its a string "true" or "false"
  let sensorValue = JSON.parse(effect.when.is);
  let deviceValue = JSON.parse(effect.set.value);

  if (sensor && device) {
    sensor.effects[sensorValue ? 'on' : 'off'].push(() => {
      device.manualTrigger(deviceValue).then(() => {
        io.emit("device-update", {
          id: device.id,
          value: deviceValue,
        });
      });
    });
  }
}

export function buildClientSensorData(sensor: Sensor) {
  return {
    id: sensor.id,
    type: sensor.type,
    name: sensor.name,
    value: sensor.value
  };
}
