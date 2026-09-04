import { afterEach, describe, expect, it, vi } from 'vitest';

const originalBasePath = process.env.VITE_BASE_PATH;
const originalServerTarget = process.env.VITE_SERVER_TARGET;

afterEach(() => {
  if (originalBasePath === undefined) delete process.env.VITE_BASE_PATH;
  else process.env.VITE_BASE_PATH = originalBasePath;
  if (originalServerTarget === undefined) delete process.env.VITE_SERVER_TARGET;
  else process.env.VITE_SERVER_TARGET = originalServerTarget;
  vi.resetModules();
});

async function proxyKeysFor(basePath: string | undefined): Promise<string[]> {
  if (basePath === undefined) delete process.env.VITE_BASE_PATH;
  else process.env.VITE_BASE_PATH = basePath;
  vi.resetModules();
  const { default: config } = await import('../vite.config');
  if (typeof config === 'function') throw new Error('Expected an object Vite config');
  return Object.keys(config.server?.proxy ?? {});
}

async function proxyTargetFor(serverTarget: string | undefined): Promise<string | undefined> {
  if (serverTarget === undefined) delete process.env.VITE_SERVER_TARGET;
  else process.env.VITE_SERVER_TARGET = serverTarget;
  vi.resetModules();
  const { default: config } = await import('../vite.config');
  if (typeof config === 'function') throw new Error('Expected an object Vite config');
  const proxy = config.server?.proxy;
  if (!proxy || Array.isArray(proxy)) throw new Error('Expected an object proxy config');
  const entry = proxy['/socket.io'];
  if (typeof entry === 'string') return entry;
  return entry?.target === undefined ? undefined : String(entry.target);
}

describe('Vite public base configuration', () => {
  it('proxies Socket.IO within the configured public base while preserving root', async () => {
    await expect(proxyKeysFor('/poker/')).resolves.toEqual(['/poker/socket.io']);
    await expect(proxyKeysFor(undefined)).resolves.toEqual(['/socket.io']);
  });

  it('supports an isolated backend target without changing the production default', async () => {
    await expect(proxyTargetFor('http://127.0.0.1:3411')).resolves.toBe('http://127.0.0.1:3411');
    await expect(proxyTargetFor(undefined)).resolves.toBe('http://localhost:3000');
  });
});
