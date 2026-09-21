/**
 * `@bozonx/ai-kit/node` — the parts that need a Node-like runtime.
 *
 * Everything else in the package runs wherever `fetch`, `WebSocket` and Web
 * Crypto do: a server, a browser, a Tauri webview. What is here reads files or
 * depends on a Node-only package, and is kept out of the main entry point so
 * that a bundler for a browser never has to resolve it.
 */

export { readCatalogFile } from './catalog.js';
export { wsSocketOpener } from './ws.js';
