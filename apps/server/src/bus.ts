import { EventEmitter } from 'node:events';

export interface Bus {
  emit(topic: string, payload: unknown): void;
  on(topic: string, handler: (payload: any) => void): () => void;
}

export class MemoryBus implements Bus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  emit(topic: string, payload: unknown): void {
    this.ee.emit(topic, payload);
  }

  on(topic: string, handler: (payload: any) => void): () => void {
    this.ee.on(topic, handler);
    return () => this.ee.off(topic, handler);
  }
}
