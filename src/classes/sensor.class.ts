import { devices } from '../handlers/deviceHandler';
import { SensorsDB } from '../handlers/sensorHandler';
import { io } from '../handlers/websocketHandler';
import { EffectsDB } from '../routes/effects-routes';

export const SensorTypesToDataTypes = {
  'motion': 'boolean',
  'temp/humidity': 'value'
}

export class Sensor {
  id: string;
  type: 'boolean' | 'value';
  name: string;
  value: any;
  setAs: string[];
  timeout: NodeJS.Timeout;
  effects = {
    on: [],
    off: []
  };

  constructor(
    id: string,
    name?: string,
    type?: 'boolean' | 'value',
    setAs?: string[]
    ) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.setAs = setAs || null;
    this.mergeDBData();
    this.setSensorDBEffects();

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

  setEffect(effect: any) {
    let prop = !effect.when.is || effect.when.is === 'false' ? 'off' : 'on';
    this.effects[prop].push(() => {
      let device = devices.find(device => device.id === effect.set.id);
      if (device && device.value !== effect.set.value) {
        device.autoTrigger(effect.set.value);
      }
    });
  }

  /**
   * Boolean sensors are basically motion sensors (for now)
   * so we keep an activity timmer for 1 minute
   */
  private updateBooleanSensor(value: any) {
    // let newValue = value === 1;
    this.value = value === 1;
    this.effects.on.forEach((fn) => fn());
    if (this.timeout) {
      // This is a timer reset
      clearTimeout(this.timeout)
    } else {
      // This is where the motion starts
    }
    io.emit('sensor-update', {
      id: this.id,
      value: this.value,
    });
    this.timeout = setTimeout(() => {
      this.value = false;
      this.timeout = null;
      this.effects.off.forEach((fn) => fn());

      io.emit('sensor-update', {
        id: this.id,
        value: false,
      });
    }, 60 * 1000);
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

  mergeDBData() {
    const dbStoredData = SensorsDB.get(this.id);
    if (dbStoredData) {
      Object.keys(dbStoredData).forEach((key: string) => {
        if (this[key]) this[key] = dbStoredData[key];
      });
    }
  }
  
  public setSensorDBEffects() {
    const effects = EffectsDB.get('effects');
    if (effects && effects.length) {
      let sensorEffects = effects.filter((effect) => {
        return effect.when.type === 'sensor' && effect.when.id === this.id 
      });
      sensorEffects.forEach((e) => {
        this.setEffect(e);
      });
    }
  }
}

// sensors.push(
//   new Sensor('12301', 'Fake sensor', 'boolean')
// )