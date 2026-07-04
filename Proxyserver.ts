import express from 'express';
import { Server } from 'http';
import { KeyManager } from './keyManager';

/**
 * Runs a local server that any OpenAI-compatible tool (Continue, Cursor,
 * a raw curl script, etc.) can point at. It forwards requests using a
 * rotating pool of keys and hides rate limits from the caller entirely.
 */
export class ProxyServer {
  private app = express();
  private server?: Server;
  public port = 0;

  constructor(private keyManager: KeyManager) {
    this.app.use(express.json({ limit: '25mb' }));
    this.registerRoutes();
  }

  private registerRoutes() {
    // The one endpoint Continue/most tools actually call.
    this.app.post('/v1/chat/completions', async (req, res) => {
      await this.handleWithRotation(req, res);
    });

    this.app.get('/status', (_req, res) => {
      res.json({ keys: this.keyManager.list() });
    });
  }

  private async handleWithRotation(req: express.Request, res: express.Response, attempt = 0) {
    const MAX_ATTEMPTS = 5;
    const key = this.keyManager.nextKey(); // TODO: infer provider from req.body.model
    if (!key) {
      return res.status(503).json({
        error: 'All keys exhausted. Add more keys or wait for cooldowns to clear.',
      });
    }

    const rawSecret = await this.keyManager.getSecret(key.id);
    if (!rawSecret) {
      await this.keyManager.markInvalid(key.id, 'secret missing from vault');
      return this.retryOrFail(req, res, attempt, MAX_ATTEMPTS);
    }

    try {
      const upstreamUrl = this.upstreamUrlFor(key.provider);
      const upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: this.headersFor(key.provider, rawSecret),
        body: JSON.stringify(req.body),
      });

      if (upstreamResp.status === 429) {
        const retryAfter = Number(upstreamResp.headers.get('retry-after'));
        await this.keyManager.markCoolingDown(key.id, Number.isFinite(retryAfter) ? retryAfter : undefined);
        return this.retryOrFail(req, res, attempt, MAX_ATTEMPTS);
      }

      if (upstreamResp.status === 401 || upstreamResp.status === 403) {
        await this.keyManager.markInvalid(key.id, `upstream returned ${upstreamResp.status}`);
        return this.retryOrFail(req, res, attempt, MAX_ATTEMPTS);
      }

      await this.keyManager.recordSuccess(key.id);
      const body = await upstreamResp.text();
      res.status(upstreamResp.status).send(body);
    } catch (err: any) {
      // Network-level failure on this key; try another rather than failing the user.
      return this.retryOrFail(req, res, attempt, MAX_ATTEMPTS);
    }
  }

  private async retryOrFail(req: express.Request, res: express.Response, attempt: number, max: number) {
    if (attempt + 1 >= max) {
      return res.status(503).json({ error: 'Exhausted retries across available keys.' });
    }
    return this.handleWithRotation(req, res, attempt + 1);
  }

  private upstreamUrlFor(provider: string): string {
    switch (provider) {
      case 'anthropic': return 'https://api.anthropic.com/v1/messages';
      case 'google': return 'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent';
      case 'groq': return 'https://api.groq.com/openai/v1/chat/completions';
      default: return 'https://api.openai.com/v1/chat/completions';
    }
  }

  private headersFor(provider: string, secret: string): Record<string, string> {
    const base = { 'Content-Type': 'application/json' };
    switch (provider) {
      case 'anthropic':
        return { ...base, 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
      case 'google':
        return { ...base, 'x-goog-api-key': secret };
      default:
        return { ...base, Authorization: `Bearer ${secret}` };
    }
  }

  start(preferredPort = 4141): Promise<number> {
    return new Promise((resolve) => {
      this.server = this.app.listen(preferredPort, () => {
        this.port = preferredPort;
        resolve(this.port);
      });
    });
  }

  stop() {
    this.server?.close();
  }
}
