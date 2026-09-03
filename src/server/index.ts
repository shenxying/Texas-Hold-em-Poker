import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPokerServer, type PokerServer } from './app';

type NetworkMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface LanServerOptions {
  env?: NodeJS.ProcessEnv;
  interfaces?: NetworkMap;
  log?: (message: string) => void;
}

export interface RunningLanServer {
  host: string;
  port: number;
  pokerServer: PokerServer;
  close(): Promise<void>;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('PORT 必须是 1 到 65535 之间的整数');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error('PORT 必须是 1 到 65535 之间的整数');
  }
  return port;
}

export function collectLanUrls(
  port: number,
  interfaces: NetworkMap = networkInterfaces(),
): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') addresses.add(entry.address);
    }
  }
  return [...addresses].map((address) => `http://${address}:${port}`);
}

export async function startLanServer(options: LanServerOptions = {}): Promise<RunningLanServer> {
  const env = options.env ?? process.env;
  const host = env.HOST ?? '0.0.0.0';
  const configuredPort = parsePort(env.PORT);
  const log = options.log ?? console.log;
  const staticDir = env.NODE_ENV === 'production'
    ? fileURLToPath(new URL('../../dist', import.meta.url))
    : undefined;
  const pokerServer = createPokerServer({
    ...(staticDir === undefined ? {} : { staticDir }),
    onUnexpectedError: (context, error) => {
      console.error(`命令 ${context.command} 发生未预期错误`, error);
    },
  });

  const listening = new Promise<void>((resolveListening, rejectListening) => {
    const onListening = (): void => {
      pokerServer.httpServer.off('error', onError);
      resolveListening();
    };
    const onError = (error: Error): void => {
      pokerServer.httpServer.off('listening', onListening);
      rejectListening(error);
    };
    pokerServer.httpServer.once('listening', onListening);
    pokerServer.httpServer.once('error', onError);
  });
  pokerServer.httpServer.listen(configuredPort, host);
  try {
    await listening;
  } catch (error) {
    await pokerServer.close();
    throw error;
  }
  const address = pokerServer.httpServer.address();
  if (address === null || typeof address === 'string') {
    await pokerServer.close();
    throw new Error('服务器未能绑定 TCP 端口');
  }
  const port = address.port;

  log('局域网私人德州扑克已启动：');
  log(`  本机：http://localhost:${port}`);
  const lanUrls = collectLanUrls(port, options.interfaces);
  for (const url of lanUrls) log(`  局域网：${url}`);
  if (lanUrls.length === 0) log('  未发现可用的非内部 IPv4 局域网地址。');
  log('若其他设备无法访问，请检查系统防火墙、企业网络策略或 Wi-Fi 客户端隔离。');

  let closePromise: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`收到 ${signal}，正在安全关闭服务器……`);
    void close().catch((error: unknown) => {
      console.error('服务器关闭失败', error);
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
    closePromise ??= pokerServer.close().finally(removeSignalHandlers);
    return closePromise;
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return { host, port, pokerServer, close };
}

const isMain = process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  void startLanServer().catch((error: unknown) => {
    console.error('服务器启动失败', error);
    process.exitCode = 1;
  });
}
