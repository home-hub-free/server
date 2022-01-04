import { Sensor } from '../classes/sensor.class';
import { roomList } from "./roomHandler";


const sensors: Sensor[] = [
  new Sensor(1, 'boolean', 'Motion sensor', [roomList['living-room']]),
  new Sensor(2, 'boolean', 'Motion sensor', [roomList['dinning-room']]),
  new Sensor(3, 'boolean', 'Motion sensor', [roomList.kitchen]),
  // Values for 'value' type sensors can come formated as "valueOne:valueTwo:valueTree", the 
  // setAs property defines how to populate those values into the data object of the rooms,
  // leaving the value property as the "raw" value form the device
  new Sensor(4, 'value', 'Room temp, humidity', [roomList['main-room']], ['temperature', 'humidity']),
  new Sensor(5, 'value', 'Common area temp/humidity', [roomList.kitchen, roomList['dinning-room']], ['temperature', 'humidity'])
];

export function updateSensor(sensorId: number, value: any) {
  let sensor: Sensor = sensors.find(sensor => sensor.id === sensorId);
  if (sensor) sensor.update(value);
}
