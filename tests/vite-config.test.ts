import { afterEach, describe, expect, it, vi } from 'vitest';

const originalBasePath = process.env.VITE_BASE_PATH;

afterEach(() => {
  if (originalBasePath === undefined) delete process.env.VITE_BASE_PATH;
  else process.env.VITE_BASE_PATH = originalBasePath;
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

describe('Vite public base configuration', () => {
  it('proxies Socket.IO within the configured public base while preserving root', async () => {
    await expect(proxyKeysFor('/poker/')).resolves.toEqual(['/poker/socket.io']);
    await expect(proxyKeysFor(undefined)).resolves.toEqual(['/socket.io']);
  });
});
