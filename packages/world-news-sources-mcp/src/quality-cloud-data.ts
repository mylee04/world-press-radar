import { statSync } from 'node:fs';

/** Published snapshot files change atomically. Refresh their view without interrupting an accepted investigation. */
export class CloudQualityDataCache<T> {
  private value: T;
  private fingerprint: string;
  private checkedAt = 0;
  private failed = false;
  constructor(private readonly paths: readonly string[], private readonly load: () => T,
    private readonly busy: () => boolean, private readonly now = () => Date.now(), private readonly intervalMs = 30000) {
    this.value = load(); this.fingerprint = this.signature();
  }
  private signature() {
    return this.paths.map(path => { try { const info = statSync(path); return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`; }
      catch { return 'missing'; } }).join('|');
  }
  get() {
    if (this.now() - this.checkedAt < this.intervalMs || this.busy()) return this.value;
    this.checkedAt = this.now();
    const next = this.signature();
    if (next === this.fingerprint) return this.value;
    try { const loaded = this.load(); this.value = loaded; this.fingerprint = next; this.failed = false; }
    catch { this.failed = true; }
    return this.value;
  }
  reloadFailed() { return this.failed; }
}
