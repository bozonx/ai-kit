/**
 * Setup environment variables for tests
 * This runs before test files are imported
 */
process.env.ROUTER_CONFIG_PATH = process.env.ROUTER_CONFIG_PATH ?? 'test/setup/config.yaml';
