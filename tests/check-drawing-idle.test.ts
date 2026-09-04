import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-drawing-idle.py');
const temporaryDirectories: string[] = [];

function databaseWith(
  ingestionStatuses: string[],
  parseStatuses: string[] = [],
): string {
  const directory = mkdtempSync(join(tmpdir(), 'drawing-idle-'));
  temporaryDirectories.push(directory);
  const database = join(directory, 'drawing.sqlite3');
  execFileSync('python3', [
    '-c',
    [
      'import sqlite3, sys',
      'database, ingestion, parse = sys.argv[1:]',
      'with sqlite3.connect(database) as connection:',
      " connection.execute('CREATE TABLE ingestion_tasks (status TEXT NOT NULL, payload TEXT)')",
      " connection.execute('CREATE TABLE parse_tasks (status TEXT NOT NULL, payload TEXT)')",
      " connection.executemany('INSERT INTO ingestion_tasks VALUES (?, ?)', [(status, 'SECRET') for status in ingestion.split(',') if status])",
      " connection.executemany('INSERT INTO parse_tasks VALUES (?, ?)', [(status, 'SECRET') for status in parse.split(',') if status])",
    ].join('\n'),
    database,
    ingestionStatuses.join(','),
    parseStatuses.join(','),
  ]);
  return database;
}

function runCheck(database: string) {
  return spawnSync('python3', [script, database], { encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Drawing idle preflight', () => {
  it('accepts only terminal work in both task tables', () => {
    const database = databaseWith(
      ['completed', 'completed_with_warnings'],
      ['failed_retryable', 'failed'],
    );

    const result = runCheck(database);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      result: 'idle',
      ingestion_tasks: 0,
      parse_tasks: 0,
    });
    expect(result.stdout).not.toContain('SECRET');
  });

  it('rejects queued ingestion work with an aggregate count', () => {
    const result = runCheck(databaseWith(['queued']));

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/queued/);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ingestion_tasks: 1,
      parse_tasks: 0,
    });
    expect(result.stdout).not.toContain('SECRET');
  });

  it('rejects processing parse work with an aggregate count', () => {
    const result = runCheck(databaseWith([], ['processing']));

    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/processing/);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ingestion_tasks: 0,
      parse_tasks: 1,
    });
    expect(result.stdout).not.toContain('SECRET');
  });

  it('reports an unreadable or malformed database without exposing details', () => {
    const missing = join(tmpdir(), `missing-drawing-${process.pid}.sqlite3`);

    const result = runCheck(missing);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ result: 'error' });
    expect(result.stderr).toBe('');
  });
});
