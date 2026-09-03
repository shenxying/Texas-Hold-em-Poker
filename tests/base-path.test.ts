import { describe, expect, it } from 'vitest';
import { normalizeBasePath, pathWithinBase } from '../src/shared/basePath';

describe('public base path', () => {
  it('normalizes root and nested base paths', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/poker/')).toBe('/poker');
  });

  it('rejects values that are not safe URL paths', () => {
    expect(() => normalizeBasePath('poker')).toThrow(/BASE_PATH/);
    expect(() => normalizeBasePath('/poker?room=x')).toThrow(/BASE_PATH/);
  });

  it('places a suffix inside root and nested base paths', () => {
    expect(pathWithinBase('', 'health')).toBe('/health');
    expect(pathWithinBase('/poker/', '/socket.io')).toBe('/poker/socket.io');
  });
});
