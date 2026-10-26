import net from 'node:net';
import { log } from '../logger.js';
import type { ValidatorResult } from '@cipherforge/shared';
import type { TerminalChannel } from '../drivers/types.js';

interface BrokerMessage {
  t: string;
  [key: string]: unknown;
}

/** NDJSON connection to the in-jail supervisor broker (unix socket, 0600). */
export class BrokerClient {
  private buffer = '';
  private listeners: ((msg: BrokerMessage) => void)[] = [];
  private closed = false;
  readonly ready: Promise<void>;

  private constructor(
    private socket: net.Socket,
    private handshake: Record<string, unknown>,
  ) {
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('broker handshake timed out')), 8000);
      const onWelcome = (msg: BrokerMessage) => {
        if (msg.t === 'welcome') {
          clearTimeout(timer);
          this.off(onWelcome);
          resolve();
        }
      };
      this.on(onWelcome);
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    socket.on('data', (chunk) => this.handleData(chunk.toString('utf8')));
    socket.on('error', (err) => log.warn('broker socket error', { error: err.message }));
    socket.on('close', () => {
      this.closed = true;
      for (const cb of this.listeners) cb({ t: 'closed' });
    });
    this.send({ t: 'hello', ...handshake });
  }

  static async connect(socketPath: string, handshake: Record<string, unknown> = {}): Promise<BrokerClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timed out connecting to session broker'));
      }, 8000);
      socket.once('connect', async () => {
        clearTimeout(timer);
        const client = new BrokerClient(socket, handshake);
        try {
          await client.ready;
          resolve(client);
        } catch (err) {
          socket.destroy();
          reject(err);
        }
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      log.warn('broker write failed', { error: (err as Error).message });
    }
  }

  on(cb: (msg: BrokerMessage) => void): void {
    this.listeners.push(cb);
  }

  off(cb: (msg: BrokerMessage) => void): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) {
      this.socket.destroy();
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: BrokerMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      for (const cb of [...this.listeners]) cb(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }
}

export async function openTerminal(socketPath: string, cols: number, rows: number): Promise<TerminalChannel> {
  const client = await BrokerClient.connect(socketPath);
  const dataHandlers: ((chunk: Buffer) => void)[] = [];
  const exitHandlers: ((code: number) => void)[] = [];
  const errorHandlers: ((err: Error) => void)[] = [];
  let opened = false;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal setup timed out')), 10000);
    client.on((msg) => {
      if (msg.t === 'ready' && !opened) {
        opened = true;
        clearTimeout(timer);
        resolve();
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        if (!opened) reject(new Error(String(msg.message ?? 'terminal error')));
        else for (const cb of errorHandlers) cb(new Error(String(msg.message)));
      } else if (msg.t === 'data') {
        for (const cb of dataHandlers) cb(Buffer.from(String(msg.d ?? ''), 'base64'));
      } else if (msg.t === 'exit') {
        for (const cb of exitHandlers) cb(Number(msg.code ?? 0));
      } else if (msg.t === 'closed') {
        for (const cb of exitHandlers) cb(0);
      }
    });
  });
  client.send({ t: 'pty', cols, rows });
  await ready;

  return {
    write: (data) => client.send({ t: 'input', d: data.toString('base64') }),
    resize: (c, r) => client.send({ t: 'resize', cols: c, rows: r }),
    close: () => client.close(),
    onData: (cb) => dataHandlers.push(cb),
    onExit: (cb) => exitHandlers.push(cb),
    onError: (cb) => errorHandlers.push(cb),
  };
}

export async function runValidator(
  socketPath: string,
  labId: string,
  req: { objectiveId: string; validator: string; meta: Record<string, unknown>; evidence: Record<string, unknown>; timeoutMs?: number },
): Promise<ValidatorResult> {
  const client = await BrokerClient.connect(socketPath);
  try {
    return await new Promise<ValidatorResult>((resolve) => {
      const timer = setTimeout(() => {
        client.close();
        resolve({ passed: false, detail: 'validator timed out inside the lab session' });
      }, (req.timeoutMs ?? 30_000) + 10_000);
      let settled = false;
      client.on((msg) => {
        if (msg.t === 'closed' && !settled) {
          clearTimeout(timer);
          settled = true;
          resolve({ passed: false, detail: 'validator channel closed unexpectedly' });
        }
        if (msg.t !== 'exec-result') return;
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        client.close();
        const result = msg.result as { passed?: boolean; detail?: string; evidence?: Record<string, unknown> } | null;
        if (!result || typeof result.passed !== 'boolean') {
          resolve({
            passed: false,
            detail: 'validator did not return a structured result',
            evidence: {
              stderr: String(msg.stderr ?? '').slice(0, 800),
              stdout: String(msg.stdout ?? '').slice(0, 800),
              exitCode: msg.code,
            },
          });
          return;
        }
        resolve({
          passed: result.passed,
          detail: String(result.detail ?? ''),
          evidence: result.evidence,
        });
      });
      client.send({
        t: 'exec',
        file: `${labId}/validators/${req.validator}.mjs`,
        objectiveId: req.objectiveId,
        meta: req.meta,
        evidence: req.evidence,
        timeoutMs: req.timeoutMs ?? 30_000,
      });
    });
  } finally {
    client.close();
  }
}
