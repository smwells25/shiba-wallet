// Offline guard for the CI runner (scripts/ci/run.mjs).
//
// The runner preloads this module into every test process it starts in
// OFFLINE mode (via NODE_OPTIONS="--import <this file>", so child processes
// that a suite spawns are guarded too). It makes "offline" a property that
// is enforced rather than hoped for:
//
// 1. Network: globalThis.fetch and net.Socket#connect refuse every
//    destination except loopback addresses and local (unix/pipe) sockets.
//    A suite that is supposed to use fakes therefore cannot silently reach a
//    real endpoint, and a suite that does try gets a clear error instead of
//    a flaky pass or fail that depends on someone else's server.
// 2. Local secrets: reads of anything inside a `.dev-wallet` directory fail
//    with ENOENT, exactly as if the directory did not exist. Suites such as
//    check-doge and check-indexer run their live sections only when
//    .dev-wallet/env exists; hiding it makes a developer machine behave like
//    a fresh CI machine, so the offline result is the same everywhere.
//
// Every refusal is appended as one JSON line to the file named by
// SHIBA_CI_GUARD_LOG (when set), so the runner can report how many network
// attempts and secret reads it blocked for each step. Nothing secret is
// ever written there: only the host name or the hidden path.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const LOG = process.env.SHIBA_CI_GUARD_LOG;

function record(kind, target) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, kind, target })}\n`);
  } catch {
    // Logging must never change the behaviour of the guarded process.
  }
}

// --- network -------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function isLoopback(host) {
  if (typeof host !== 'string' || host === '') return true; // Node defaults to localhost
  return LOOPBACK.has(host.toLowerCase()) || host.startsWith('127.');
}

function blockedError(target) {
  const error = new Error(
    `[ci offline guard] network access is disabled in offline mode (attempted: ${target}). ` +
      'Offline suites must use fakes; run the CI runner with --mode live for live checks.',
  );
  error.code = 'SHIBA_CI_OFFLINE';
  return error;
}

const realFetch = globalThis.fetch;
if (typeof realFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    } catch {
      return realFetch.call(this, input, init);
    }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !isLoopback(url.hostname)) {
      record('network', url.hostname);
      return Promise.reject(blockedError(url.hostname));
    }
    return realFetch.call(this, input, init);
  };
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  // connect(options[, listener]) | connect(path[, listener]) | connect(port[, host][, listener])
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host;
  let isLocalSocket = false;
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') isLocalSocket = true;
    host = first.host;
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) {
    isLocalSocket = true; // a unix socket or Windows pipe path
  } else if (typeof args[1] === 'string') {
    host = args[1];
  }
  if (!isLocalSocket && !isLoopback(host)) {
    record('network', String(host));
    const error = blockedError(String(host));
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return realConnect.apply(this, args);
};

// --- .dev-wallet ----------------------------------------------------------

function toPath(p) {
  if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null;
  if (Buffer.isBuffer(p)) return p.toString();
  if (typeof p === 'string') return p.startsWith('file:') ? fileURLToPath(p) : p;
  return null; // file descriptors and anything else pass through
}

function isDevWallet(p) {
  const resolved = toPath(p);
  if (resolved === null) return false;
  return path.resolve(resolved).split(path.sep).includes('.dev-wallet');
}

function enoent(p) {
  const shown = toPath(p);
  record('dev-wallet-hidden', shown);
  const error = new Error(`ENOENT: no such file or directory (hidden by the CI offline guard), open '${shown}'`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = 'open';
  error.path = shown;
  return error;
}

const realReadFileSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (isDevWallet(p)) throw enoent(p);
  return realReadFileSync.call(this, p, ...rest);
};

const realReadFile = fs.readFile;
fs.readFile = function (p, ...rest) {
  if (isDevWallet(p)) {
    const callback = rest[rest.length - 1];
    const error = enoent(p);
    if (typeof callback === 'function') process.nextTick(() => callback(error));
    return undefined;
  }
  return realReadFile.call(this, p, ...rest);
};

const realExistsSync = fs.existsSync;
fs.existsSync = function (p) {
  if (isDevWallet(p)) {
    record('dev-wallet-hidden', toPath(p));
    return false;
  }
  return realExistsSync.call(this, p);
};

const realPromisesReadFile = fs.promises.readFile;
fs.promises.readFile = function (p, ...rest) {
  if (isDevWallet(p)) return Promise.reject(enoent(p));
  return realPromisesReadFile.call(this, p, ...rest);
};

// Make `import { readFileSync } from 'node:fs'` (and friends) see the
// patched functions too, not only `fs.readFileSync`.
syncBuiltinESMExports();
