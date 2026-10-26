export class EngineError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'EngineError';
  }
}
