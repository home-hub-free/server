export class Device {
  public ip: string | null = null;
  public manual: boolean = false;
  public value: any;
  public triggerCondition: (value: any) => boolean;
  constructor(
    public id: number,
    public name: string,
    public type: 'boolean' | 'value',
    triggerCondition?: (value: any) => boolean) {

    switch (type) {
      case 'boolean':
        this.value = false;
        break;
      case 'value':
        this.value = 0;
        break;
    }

    this.id = id;
    this.name = name;
    this.type = type;
    if (triggerCondition) {
      this.triggerCondition = triggerCondition
    } else {
      this.triggerCondition = () => true;
    }
  }
}