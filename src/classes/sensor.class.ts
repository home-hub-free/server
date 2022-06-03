import { Room } from "./room.class";

export class Sensor {

  id: number;
  type: 'boolean' | 'value';
  description: string;
  rooms: Room[];
  value: any;
  setAs: string[];

  constructor(
    id: number,
    type: 'boolean' | 'value',
    description: string,
    rooms: Room[],
    setAs?: string[]
    ) {
    this.id = id;
    this.type = type;
    this.description = description;
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
    if (this.rooms.length === 0) {
      return;
    }

    this.rooms.forEach((room) => {
      room.activate(this.value);
    });
  }

  /**
   * Value sensors will be used to store data, like temp
   * humidity, light levels, 
   * @param {*} value Value gathered from sensor
   */
  private updateValueSensor(value: any) {
    this.value = value;
    if (this.rooms.length === 0) {
      return;
    }
    this.rooms.forEach((room) => {
      room.updateRoomDataRef((data) => {
        // Implement this before adding new type of value sensors
        // let splitValue = this.value.split(':');
        // splitValue.forEach((val, index) => {
        //   if (this.setAs[index] && splitValue[index]) {
        //     let key = this.setAs[index];
        //     data[key] = val;
        //   }
        // });

        // DEPRECATE
        // Legacy code to keep the FE working
        data[`sensor-${this.id}`] = {
          id: this.id,
          value: value,
          description: this.description
        };
      });
    });
  }
}