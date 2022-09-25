import { Room } from "./room.class";

export const SensorTypesToDataTypes = {
  'motion': 'boolean',
  'temp/humidity': 'value'
}

export class Sensor {

  id: number;
  type: 'boolean' | 'value';
  name: string;
  rooms: Room[];
  value: any;
  setAs: string[];

  constructor(
    id: number,
    name?: string,
    type?: 'boolean' | 'value',
    rooms?: Room[],
    setAs?: string[]
    ) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.rooms = rooms;
    this.setAs = setAs || null;

    switch (type) {
      case 'boolean':
        this.value = false;
        break;
      case 'value':
        this.value = '';
    }
  }

  update(value) {
    switch (this.type) {
      case 'boolean':
        this.updateBooleanSensor(value);
        break;
      case 'value':
        this.updateValueSensor(value);
        break;
    }
  }

  /**
   * Boolean sensors are only used to update active state in rooms
   * @param {boolean} value Sensor state true/false
   */
  private updateBooleanSensor(value: any) {
    this.value = value === 1;
  }

  /**
   * Value sensors will be used to store data, like temp
   * humidity, light levels, 
   * @param {*} value Value gathered from sensor
   */
  private updateValueSensor(value: any) {
    this.value = value;
  }
}