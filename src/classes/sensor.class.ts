// import { Room } from "./room.class";
import { io } from '../handlers/websocketHandler';

export const SensorTypesToDataTypes = {
  'motion': 'boolean',
  'temp/humidity': 'value'
}

export class Sensor {

  id: number;
  type: 'boolean' | 'value';
  name: string;
  value: any;
  setAs: string[];
  timeout: NodeJS.Timeout;

  constructor(
    id: number,
    name?: string,
    type?: 'boolean' | 'value',
    setAs?: string[]
    ) {
    this.id = id;
    this.type = type;
    this.name = name;
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
   * Boolean sensors are basically motion sensors (for now)
   * so we keep an activity timmer for 1 minute
   */
  private updateBooleanSensor(value: any) {
    let newValue = value === 1;
    // Cancel current timeout and reset
    if (newValue) {
      if (this.timeout) {
        clearTimeout(this.timeout)
      } else {
        io.emit('sensor-update', {
          id: this.id,
          value: true,
        });
      }
      this.timeout = setTimeout(() => {
        this.value = false;
        this.timeout = null;
        io.emit('sensor-update', {
          id: this.id,
          value: false,
        });
      }, 60 * 1000);
    }
  }

  /**
   * Value sensors will be used to store data, like temp
   * humidity, light levels, basically any sensor that
   * requires a more complex way of reading its data gets
   * updated here
   * @param {*} value Value gathered from sensor
   */
  private updateValueSensor(value: any) {
    this.value = value;
  }
}