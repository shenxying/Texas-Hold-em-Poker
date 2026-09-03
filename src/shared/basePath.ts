export function normalizeBasePath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/') return '';
  if (!value.startsWith('/') || /[?#]/.test(value)) {
    throw new Error('BASE_PATH 必须是以 / 开头的 URL 路径');
  }
  const normalized = value.replace(/\/+$/, '');
  if (
    normalized === '' ||
    !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(normalized)
  ) {
    throw new Error('BASE_PATH 必须是安全的 URL 路径');
  }
  return normalized;
}

export function pathWithinBase(basePath: string, suffix: string): string {
  return `${normalizeBasePath(basePath)}/${suffix.replace(/^\/+/, '')}`;
}
