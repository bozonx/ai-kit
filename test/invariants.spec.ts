import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from '@jest/globals';

/**
 * The boundary of the package, checked rather than promised.
 *
 * Written as a test because a boundary that lives only in a document has about
 * a month before somebody imports Prisma "just here" and the package quietly
 * stops being reusable. The failure message has to say what to do instead, so
 * that whoever trips it moves the component rather than deletes the test.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map(path => ({
  path: path.slice(SRC.length + 1),
  text: readFileSync(path, 'utf8'),
}));

describe('library invariants', () => {
  it('has sources to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports no framework and no ORM', () => {
    const offenders = files
      .filter(file => /from '(@nestjs\/|@prisma\/|\.prisma\/)/.test(file.text))
      .map(file => file.path);

    expect(offenders).toEqual([]);
  });

  it('reads no environment variables', () => {
    const offenders = files.filter(file => /process\.env/.test(file.text)).map(file => file.path);

    expect(offenders).toEqual([]);
  });

  it("knows no words from anybody's domain", () => {
    // The list is the point: the moment one of these is needed, the component
    // belongs to the consuming application, not to a library that has no idea
    // what a project is.
    const forbidden = /\b(organization|tenant|projectId|userId|publication)\b/i;
    const offenders = files.filter(file => forbidden.test(file.text)).map(file => file.path);

    expect(offenders).toEqual([]);
  });

  it('does not log by itself', () => {
    const offenders = files.filter(file => /console\.(log|info|warn|error)/.test(file.text));

    expect(offenders.map(file => file.path)).toEqual([]);
  });
});
