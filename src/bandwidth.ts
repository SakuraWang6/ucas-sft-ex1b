import { setTimeout as delay } from 'node:timers/promises';

const MIB = 1024 * 1024;
export const DEFAULT_BANDWIDTH = 8 * MIB;
const MIN_BANDWIDTH = 2 * MIB;
const MAX_BANDWIDTH = 64 * MIB;

export function parseBandwidthConfig(config: unknown): Map<string, number> {
  if (config === undefined) return new Map();
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid bandwidth configuration');
  }
  const rates = new Map<string, number>();
  for (const [name, rate] of Object.entries(config)) {
    if (!Number.isSafeInteger(rate) || rate < MIN_BANDWIDTH || rate > MAX_BANDWIDTH) {
      throw new Error('Invalid bandwidth configuration: rates must be 2–64 MiB/s in bytes per second');
    }
    rates.set(name, rate);
  }
  return rates;
}

export class AccountBandwidth {
  private availableAt = 0;

  constructor(readonly bytesPerSecond: number) {}

  async wait(bytes: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const now = performance.now();
    // Reserve this payload block on the shared timeline before any other socket can reserve one.
    const readyAt = Math.max(now, this.availableAt) + bytes * 1000 / this.bytesPerSecond;
    this.availableAt = readyAt;
    await delay(Math.ceil(readyAt - now), undefined, { signal });
  }
}
