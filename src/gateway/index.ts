import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeBasePath } from '../shared/basePath';
import { parsePort } from '../server/index';
import { createGateway, type GatewayServer } from './app';

export interface GatewayStartOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface RunningGateway {
  host: string;
  port: number;
  gateway: GatewayServer;
  close(): Promise<void>;
}

function parseHttpUpstream(value: string, name: string): URL {
  let upstream: URL;
  try {
    upstream = new URL(value);
  } catch {
    throw new Error(`${name} 必须是绝对 http: URL`);
  }
  if (upstream.protocol !== 'http:' || upstream.hostname === '') {
    throw new Error(`${name} 必须是绝对 http: URL`);
  }
  return upstream;
}

export async function startGateway(
  options: GatewayStartOptions = {},
): Promise<RunningGateway> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const host = env.GATEWAY_HOST ?? '0.0.0.0';
  if (host === '' || host.trim() !== host) {
    throw new Error('GATEWAY_HOST 必须是非空主机名或 IP 地址');
  }
  const configuredPort = parsePort(env.GATEWAY_PORT ?? '8080');
  const drawingUpstream = parseHttpUpstream(
    env.DRAWING_UPSTREAM ?? 'http://127.0.0.1:18080',
    'DRAWING_UPSTREAM',
  );
  const pokerUpstream = parseHttpUpstream(
    env.POKER_UPSTREAM ?? 'http://127.0.0.1:3000',
    'POKER_UPSTREAM',
  );
  const pokerBasePath = normalizeBasePath(env.POKER_BASE_PATH ?? '/poker');
  const gateway = createGateway({ drawingUpstream, pokerUpstream, pokerBasePath });

  const listening = new Promise<void>((resolveListening, rejectListening) => {
    const onListening = (): void => {
      gateway.httpServer.off('error', onError);
      resolveListening();
    };
    const onError = (error: Error): void => {
      gateway.httpServer.off('listening', onListening);
      rejectListening(error);
    };
    gateway.httpServer.once('listening', onListening);
    gateway.httpServer.once('error', onError);
  });
  gateway.httpServer.listen(configuredPort, host);
  try {
    await listening;
  } catch (error) {
    await gateway.close();
    throw error;
  }

  const address = gateway.httpServer.address();
  if (address === null || typeof address === 'string') {
    await gateway.close();
    throw new Error('共享网关未能绑定 TCP 端口');
  }
  const port = address.port;
  const publicPath = pokerBasePath === '' ? '/' : `${pokerBasePath}/`;
  log('共享 HTTP + WebSocket 网关已启动：');
  log(`  本机：http://localhost:${port}${publicPath}`);

  let closePromise: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`收到 ${signal}，正在安全关闭共享网关……`);
    void close().catch((error: unknown) => {
      console.error('共享网关关闭失败', error);
      process.exitCode = 1;
    });
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  const removeSignalHandlers = (): void => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
  const close = (): Promise<void> => {
    closePromise ??= gateway.close().finally(removeSignalHandlers);
    return closePromise;
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return { host, port, gateway, close };
}

const isMain = process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  void startGateway().catch((error: unknown) => {
    console.error('共享网关启动失败', error);
    process.exitCode = 1;
  });
}
