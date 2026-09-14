/**
 * Library surface of the gateway: importing this has no side effects.
 * Used by the suites that embed a gateway on an ephemeral port the way
 * they embed a daemon (the SDK's and the CLI's — the verbs they exercise
 * for keys, settings and templates answer here now). Booting the real
 * gateway lives in main.ts.
 */
export { buildGatewayApp, type GatewayAppDeps } from './app';
export { NameCache } from './cache';
export { type Config, loadConfig } from './config';
export { type Db, migrateDb, openDb } from './db/db';
export { ensureSettings } from './db/settings';
export { Finder } from './find';
export { Fleet } from './fleet';
export { type AskNode, type AskVerb, httpAsk, httpAskNode } from './lookup';
export { checkInOf, reading, TEST_TOKEN, testGateway } from './testing';
