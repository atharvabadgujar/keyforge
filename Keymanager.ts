import * as vscode from 'vscode';

export type Provider = 'openai' | 'anthropic' | 'google' | 'groq' | 'unknown';
export type KeyStatus = 'active' | 'cooling_down' | 'invalid';

export interface ManagedKey {
  id: string;          // random uuid, used as the SecretStorage key name
  label: string;       // e.g. "Personal OpenAI"
  provider: Provider;
  maskedValue: string; // e.g. "sk-...ab12" for display only
  status: KeyStatus;
  cooldownUntil?: number; // epoch ms
  requestsToday: number;
  lastError?: string;
}

const SECRET_PREFIX = 'keyforge.key.';
const STATE_KEY = 'keyforge.keyMeta';

/**
 * Detects provider from key format so the user doesn't have to pick manually.
 */
export function detectProvider(rawKey: string): Provider {
  if (/^sk-ant-/.test(rawKey)) return 'anthropic';
  if (/^sk-proj-|^sk-[A-Za-z0-9]{20,}/.test(rawKey) && !/^sk-ant-/.test(rawKey)) return 'openai';
  if (/^AIza/.test(rawKey)) return 'google';
  if (/^gsk_/.test(rawKey)) return 'groq';
  return 'unknown';
}

function mask(rawKey: string): string {
  if (rawKey.length <= 8) return '****';
  return `${rawKey.slice(0, 5)}...${rawKey.slice(-4)}`;
}

/**
 * Owns the vault: SecretStorage holds raw secrets, globalState holds
 * non-sensitive metadata (labels, status, counters) for fast dashboard reads.
 */
export class KeyManager {
  private keys: ManagedKey[] = [];
  private rrCursor = 0; // round-robin cursor

  constructor(
    private secrets: vscode.SecretStorage,
    private state: vscode.Memento
  ) {
    this.keys = this.state.get<ManagedKey[]>(STATE_KEY, []);
  }

  private async persist() {
    await this.state.update(STATE_KEY, this.keys);
  }

  async addKey(rawKey: string, label: string): Promise<ManagedKey> {
    const id = crypto.randomUUID();
    const provider = detectProvider(rawKey);
    const entry: ManagedKey = {
      id,
      label,
      provider,
      maskedValue: mask(rawKey),
      status: 'active',
      requestsToday: 0,
    };
    await this.secrets.store(SECRET_PREFIX + id, rawKey);
    this.keys.push(entry);
    await this.persist();
    return entry;
  }

  async removeKey(id: string) {
    await this.secrets.delete(SECRET_PREFIX + id);
    this.keys = this.keys.filter(k => k.id !== id);
    await this.persist();
  }

  list(): ManagedKey[] {
    this.refreshCooldowns();
    return this.keys;
  }

  private refreshCooldowns() {
    const now = Date.now();
    for (const k of this.keys) {
      if (k.status === 'cooling_down' && k.cooldownUntil && k.cooldownUntil <= now) {
        k.status = 'active';
        k.cooldownUntil = undefined;
      }
    }
  }

  /** Picks the next active key for a given provider, round-robin. */
  nextKey(provider?: Provider): ManagedKey | undefined {
    this.refreshCooldowns();
    const pool = this.keys.filter(k => k.status === 'active' && (!provider || k.provider === provider));
    if (pool.length === 0) return undefined;
    this.rrCursor = (this.rrCursor + 1) % pool.length;
    return pool[this.rrCursor];
  }

  async getSecret(id: string): Promise<string | undefined> {
    return this.secrets.get(SECRET_PREFIX + id);
  }

  /** Called when a request against `id` comes back 429. */
  async markCoolingDown(id: string, retryAfterSeconds?: number) {
    const k = this.keys.find(k => k.id === id);
    if (!k) return;
    k.status = 'cooling_down';
    // Default to 60s if the provider didn't tell us via Retry-After header.
    k.cooldownUntil = Date.now() + (retryAfterSeconds ?? 60) * 1000;
    await this.persist();
  }

  async markInvalid(id: string, error: string) {
    const k = this.keys.find(k => k.id === id);
    if (!k) return;
    k.status = 'invalid';
    k.lastError = error;
    await this.persist();
  }

  async recordSuccess(id: string) {
    const k = this.keys.find(k => k.id === id);
    if (!k) return;
    k.requestsToday += 1;
    await this.persist();
  }
}
