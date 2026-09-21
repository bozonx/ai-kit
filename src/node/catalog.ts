import { readFileSync } from 'node:fs';

import { Catalog } from '../catalog/catalog.js';
import { CatalogError } from '../errors.js';

/**
 * Reads, parses and validates a YAML catalog file.
 *
 * Here rather than on `Catalog` because it is the one thing about a catalog
 * that needs a file system, and the main entry point has to load in a browser.
 */
export function readCatalogFile(path: string): Catalog {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new CatalogError(`Cannot read model catalog at ${path}`, { cause: error });
  }
  return Catalog.fromYaml(text);
}
