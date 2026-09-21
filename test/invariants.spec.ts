import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
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

  it("knows no product's names for its own kinds of work", () => {
    // Task classes used to be a closed list in the schema, and the list held
    // `generate_post`, `alt_text` and `subtitles` — one product's vocabulary,
    // shipped inside a library that claims to know nothing about anybody's
    // domain. A second product could then fork the package or call its ticket
    // triage `rewrite`. The class is a free string now, and this is what stops
    // the list from growing back one convenient constant at a time.
    const forbidden =
      /'(generate_post|alt_text|bulk_plan|chat_simple|chat_agentic|dictation|subtitles|rewrite|summarize)'/;
    const offenders = files.filter(file => forbidden.test(file.text)).map(file => file.path);

    expect(offenders).toEqual([]);
  });

  it('does not log by itself', () => {
    const offenders = files.filter(file => /console\.(log|info|warn|error)/.test(file.text));

    expect(offenders.map(file => file.path)).toEqual([]);
  });
});

/**
 * Every module a bundler would pull in from one entry point, with the bare
 * specifiers they import at runtime.
 *
 * Type-only imports are skipped because they are erased at compile time; a
 * dynamic `import()` is followed like a static one, because a bundler follows it.
 */
function runtimeGraph(entry: string): { modules: string[]; externals: Map<string, string> } {
  const modules = new Set<string>();
  const externals = new Map<string, string>();
  const pending = [join(SRC, entry)];

  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || modules.has(path)) continue;
    modules.add(path);

    const text = readFileSync(path, 'utf8');
    const specifiers = [
      ...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'";]*?from\s+'([^']+)'/gm),
      ...text.matchAll(/^\s*import\s+'([^']+)'/gm),
      ...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g),
    ].map(match => match[1] ?? '');

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')));
      } else {
        externals.set(specifier, path.slice(SRC.length + 1));
      }
    }
  }

  return { modules: [...modules], externals };
}

const NODE_ONLY = new Set([...builtinModules, 'ws']);

describe.each(['index.ts', 'stt/index.ts', 'translate/index.ts', 'stream/index.ts'])(
  'the entry point %s',
  entry => {
    const graph = runtimeGraph(entry);

    it('loads without Node, so that a browser or a Tauri webview can bundle it', () => {
      // Whoever trips this moves the Node-only piece to `src/node/` and exports
      // it from `@bozonx/ai-kit/node`, or puts it behind the `Transport` port.
      const offenders = [...graph.externals]
        .filter(([specifier]) => specifier.startsWith('node:') || NODE_ONLY.has(specifier))
        .map(([specifier, from]) => `${from} imports ${specifier}`);

      expect(offenders).toEqual([]);
    });

    it('uses no Node globals', () => {
      const offenders = graph.modules
        .filter(path => {
          const code = readFileSync(path, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          return /\bBuffer\.|\bprocess\.|\b__dirname\b|(?:^|[=(;,])\s*require\(/m.test(code);
        })
        .map(path => path.slice(SRC.length + 1));

      expect(offenders).toEqual([]);
    });
  },
);
