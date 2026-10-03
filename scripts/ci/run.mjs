#!/usr/bin/env node
// One command for every automated check in the repository: the engine build
// and its vitest suites, every app script suite, the app's lint and
// typecheck, and an Android bundle export as a smoke test. Used by
// `npm test` at the repository root and by .github/workflows/ci.yml.
//
// Usage (from anywhere; paths are resolved from this file):
//
//   node scripts/ci/run.mjs [--mode offline|live] [--only <groups>]
//                           [--skip-bundle] [--verbose] [--logs-dir <dir>]
//
//   --mode offline  (default) No network and no local secrets: test processes
//                   are started with scripts/ci/offline-guard.mjs preloaded,
//                   which refuses every non-loopback connection and hides the
//                   git-ignored .dev-wallet directory. Live-only suites are
//                   skipped and listed as such. This is what CI runs.
//   --mode live     For a developer machine: also runs the live-only suites,
//                   passes --live to the suites that support it, and leaves
//                   .dev-wallet visible so keyed live sections run.
//   --only          Comma-separated subset of: engine, app, lint, typecheck,
//                   bundle. The engine build always runs first because every
//                   app step consumes the built packages.
//   --skip-bundle   Skip the `expo export` smoke test (same as setting
//                   SHIBA_CI_SKIP_BUNDLE=1).
//   --verbose       Stream every step's output instead of only showing the
//                   tail of a failing step.
//   --logs-dir      Where to keep each step's full output (default: a fresh
//                   directory under the OS temp directory).
//   Environment: SHIBA_CI_MODE, SHIBA_CI_SKIP_BUNDLE, SHIBA_CI_TIMEOUT_SCALE.
//
// A step fails when its process exits non-zero, times out, or prints a
// summary with a non-zero failure count. Suites that are expected to print
// "N passed, M failed" also fail when that line is missing, and in offline
// mode a step fails when it attempted any network connection. Every step has a
// timeout, and a timed-out step's whole process group is killed, so the
// runner cannot hang.
//
// The runner imports nothing from the code under test; it only starts
// processes and reads their output. It has no dependencies beyond Node.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCRIPTS } from './suites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'app');
const GUARD = path.join(ROOT, 'scripts', 'ci', 'offline-guard.mjs');
const ENGINE_PACKAGES = ['core', 'chains-evm', 'chains-utxo', 'chains-solana', 'prices'];
const GROUPS = ['engine', 'app', 'lint', 'typecheck', 'bundle'];

// Per-step timeouts. They are generous (a full local run takes under two
// minutes); SHIBA_CI_TIMEOUT_SCALE multiplies all of them, e.g. 2 for a slow
// machine.
const MINUTE = 60_000;
const SCALE = Number(process.env.SHIBA_CI_TIMEOUT_SCALE || '1') > 0 ? Number(process.env.SHIBA_CI_TIMEOUT_SCALE || '1') : 1;
const TIMEOUTS = Object.fromEntries(
  Object.entries({
    build: 10 * MINUTE,
    vitest: 10 * MINUTE,
    suite: 5 * MINUTE,
    lint: 10 * MINUTE,
    typecheck: 10 * MINUTE,
    bundle: 20 * MINUTE,
  }).map(([k, v]) => [k, Math.max(1_000, Math.round(v * SCALE))]),
);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    mode: process.env.SHIBA_CI_MODE || 'offline',
    only: null,
    skipBundle: /^(1|true|yes)$/i.test(process.env.SHIBA_CI_SKIP_BUNDLE || ''),
    verbose: false,
    logsDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) usage(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === '--mode') options.mode = value();
    else if (arg.startsWith('--mode=')) options.mode = arg.slice(7);
    else if (arg === '--only') options.only = value().split(',');
    else if (arg.startsWith('--only=')) options.only = arg.slice(7).split(',');
    else if (arg === '--skip-bundle') options.skipBundle = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--logs-dir') options.logsDir = value();
    else if (arg === '--help' || arg === '-h') usage(null);
    else usage(`unknown argument ${arg}`);
  }
  if (options.mode !== 'offline' && options.mode !== 'live') usage(`--mode must be offline or live, got ${options.mode}`);
  if (options.only) {
    options.only = options.only.map((g) => g.trim()).filter(Boolean);
    for (const g of options.only) if (!GROUPS.includes(g)) usage(`unknown group ${g} (groups: ${GROUPS.join(', ')})`);
  }
  return options;
}

function usage(error) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(6, 29).map((l) => l.replace(/^\/\/ ?/, ''));
  if (error) console.error(`error: ${error}\n`);
  console.error(text.join('\n'));
  process.exit(error ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Process execution with a hard timeout
// ---------------------------------------------------------------------------

const NODE_BIN_DIR = path.dirname(process.execPath);

// Use the npm/npx that ship with the Node running this script, and put that
// Node first on PATH for children, so a machine whose default `node` is older
// still runs every step on the same Node version.
function tool(name) {
  const candidate = path.join(NODE_BIN_DIR, name);
  return fs.existsSync(candidate) ? candidate : name;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function runProcess({ command, args, cwd, env, timeoutMs, logFile, verbose }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logFile);
    log.write(`$ (cd ${path.relative(ROOT, cwd) || '.'} && ${[command, ...args].join(' ')})\n\n`);
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      log.end();
      resolve({ code: null, signal: null, output: String(error), timedOut: false, ms: 0, spawnError: true });
      return;
    }
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      log.write(text);
      if (verbose) process.stdout.write(text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.on('error', (error) => {
      output += `\n${String(error)}\n`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Make sure nothing the step started outlives it (e.g. a Metro worker).
      killGroup('SIGKILL');
      log.end();
      resolve({ code, signal, output: stripAnsi(output), timedOut, ms: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

// App suites print "N passed, M failed", sometimes prefixed with the suite
// name ("check-wc: 197 passed, 0 failed"). The last such line is the
// summary; any line with M > 0 fails the step even if the exit code was 0.
function parseSuiteCounts(output) {
  const matches = [...output.matchAll(/(\d+) passed, (\d+) failed/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const anyFailed = matches.some((m) => Number(m[2]) > 0);
  return { passed: Number(last[1]), failed: Number(last[2]), anyFailed };
}

// Vitest prints e.g. "      Tests  359 passed (359)" or
// "      Tests  1 failed | 358 passed (359)".
function parseVitest(output) {
  const line = output.split('\n').find((l) => /^\s*Tests\s+\d/.test(l));
  if (!line) return null;
  const count = (word) => {
    const m = line.match(new RegExp(`(\\d+) ${word}`));
    return m ? Number(m[1]) : 0;
  };
  const total = line.match(/\((\d+)\)/);
  return {
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped') + count('todo'),
    total: total ? Number(total[1]) : null,
  };
}

// ESLint's stylish formatter ends with "✖ N problems (E errors, W warnings)"
// when there is anything to report and prints nothing otherwise.
function parseEslint(output) {
  const m = output.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);
  if (!m) return { problems: 0, errors: 0, warnings: 0 };
  return { problems: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]) };
}

function readGuardLog(file) {
  const counts = { network: 0, 'dev-wallet-hidden': 0, hosts: new Set() };
  if (!fs.existsSync(file)) return counts;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      if (entry.kind === 'network') counts.hosts.add(entry.target);
    } catch {
      // A torn line from a killed process; ignore it.
    }
  }
  return counts;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function checkSuiteTable() {
  const present = fs.readdirSync(path.join(APP, 'scripts')).filter((f) => f.endsWith('.mjs'));
  const unclassified = present.filter((f) => !(f in APP_SCRIPTS));
  const missing = Object.keys(APP_SCRIPTS).filter((f) => !present.includes(f));
  if (unclassified.length || missing.length) {
    if (unclassified.length) console.error(`Unclassified app scripts (add them to scripts/ci/suites.mjs): ${unclassified.join(', ')}`);
    if (missing.length) console.error(`scripts/ci/suites.mjs lists scripts that do not exist: ${missing.join(', ')}`);
    process.exit(2);
  }
}

function buildPlan(options) {
  const want = (group) => options.only === null || options.only.includes(group);
  const offline = options.mode === 'offline';
  const steps = [];

  steps.push({
    name: 'engine: build (all five packages)',
    group: 'build',
    command: tool('npm'),
    args: ['run', 'build'],
    cwd: ROOT,
    timeoutMs: TIMEOUTS.build,
    parse: 'exit',
    prerequisite: true,
  });

  if (want('engine')) {
    for (const pkg of ENGINE_PACKAGES) {
      steps.push({
        name: `engine: vitest ${pkg}`,
        group: 'engine',
        command: tool('npm'),
        args: ['run', 'test', '-w', `@shiba-wallet/${pkg}`],
        cwd: ROOT,
        timeoutMs: TIMEOUTS.vitest,
        parse: 'vitest',
        guarded: offline,
      });
    }
  }

  if (want('app')) {
    for (const [file, info] of Object.entries(APP_SCRIPTS)) {
      if (info.kind === 'helper') continue;
      const name = `app: ${file.replace(/\.mjs$/, '')}`;
      if (info.kind === 'live' && offline) {
        steps.push({ name, group: 'app', skip: 'live-only suite (run with --mode live)' });
        continue;
      }
      const args = [path.join('scripts', file)];
      if (info.kind === 'flag-live' && !offline) args.push('--live');
      steps.push({
        name: info.kind === 'flag-live' && !offline ? `${name} --live` : name,
        group: 'app',
        command: process.execPath,
        args,
        cwd: APP,
        timeoutMs: TIMEOUTS.suite,
        parse: info.summary === 'counts' ? 'counts' : 'exit',
        guarded: offline,
      });
    }
  }

  if (want('lint')) {
    steps.push({
      name: 'app: expo lint (zero warnings allowed)',
      group: 'lint',
      command: tool('npx'),
      args: ['expo', 'lint', '--max-warnings', '0'],
      cwd: APP,
      timeoutMs: TIMEOUTS.lint,
      parse: 'eslint',
    });
  }

  if (want('typecheck')) {
    steps.push({
      name: 'app: tsc --noEmit',
      group: 'typecheck',
      command: tool('npx'),
      args: ['tsc', '--noEmit'],
      cwd: APP,
      timeoutMs: TIMEOUTS.typecheck,
      parse: 'exit',
    });
  }

  if (want('bundle')) {
    const name = 'app: expo export --platform android (bundle smoke test)';
    if (options.skipBundle) {
      steps.push({ name, group: 'bundle', skip: 'skipped by --skip-bundle / SHIBA_CI_SKIP_BUNDLE' });
    } else {
      steps.push({
        name,
        group: 'bundle',
        command: tool('npx'),
        // The output directory is created just before the step runs.
        args: ['expo', 'export', '--platform', 'android', '--output-dir'],
        cwd: APP,
        timeoutMs: TIMEOUTS.bundle,
        parse: 'bundle',
        extraEnv: offline ? { EXPO_OFFLINE: '1' } : {},
      });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Evaluate one finished step
// ---------------------------------------------------------------------------

function evaluate(step, result, guardCounts) {
  const notes = [];
  let ok = result.code === 0 && !result.timedOut;
  let detail = '';

  if (result.timedOut) notes.push(`timed out after ${Math.round(step.timeoutMs / 1000)} s (process group killed)`);
  else if (result.code !== 0) notes.push(`exit code ${result.code ?? `signal ${result.signal}`}`);

  if (step.parse === 'counts') {
    const counts = parseSuiteCounts(result.output);
    if (!counts) {
      ok = false;
      notes.push('no "N passed, M failed" summary line');
    } else {
      detail = `${counts.passed} passed, ${counts.failed} failed`;
      if (counts.anyFailed) ok = false;
      step.counts = counts;
    }
  } else if (step.parse === 'vitest') {
    const counts = parseVitest(result.output);
    if (!counts) {
      ok = false;
      notes.push('no vitest "Tests" summary line');
    } else {
      detail = `${counts.passed} passed, ${counts.failed} failed${counts.skipped ? `, ${counts.skipped} skipped` : ''}`;
      if (counts.failed > 0 || counts.passed === 0) ok = false;
      step.counts = counts;
    }
  } else if (step.parse === 'eslint') {
    const counts = parseEslint(result.output);
    detail = `${counts.errors} errors, ${counts.warnings} warnings`;
    if (counts.problems > 0) ok = false;
  } else if (step.parse === 'bundle') {
    if (ok) {
      const jsDir = path.join(step.outDir, '_expo', 'static', 'js', 'android');
      const files = fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter((f) => f.endsWith('.hbc') || f.endsWith('.js')) : [];
      if (files.length === 0) {
        ok = false;
        notes.push('export finished but produced no Android bundle');
      } else {
        const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(jsDir, f)).size, 0);
        const modules = result.output.match(/Android Bundled \d+ms .*?\((\d+) modules\)/);
        detail = `${files.length} bundle file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB${modules ? `, ${modules[1]} modules` : ''}; export dir ${(directorySize(step.outDir) / 1024 / 1024).toFixed(1)} MB`;
      }
    }
    fs.rmSync(step.outDir, { recursive: true, force: true });
  }

  if (guardCounts) {
    // Offline steps must not even try the network: a suite that swallows the
    // refusal would otherwise pass while depending on a live endpoint.
    if (guardCounts.network > 0) {
      ok = false;
      notes.push(`offline guard blocked ${guardCounts.network} network attempt(s): ${[...guardCounts.hosts].join(', ')}`);
    }
    if (guardCounts['dev-wallet-hidden'] > 0) notes.push(`offline guard hid .dev-wallet ${guardCounts['dev-wallet-hidden']} time(s)`);
  }
  return { ok, detail, notes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
checkSuiteTable();

const logsDir = options.logsDir
  ? path.resolve(options.logsDir)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'shiba-ci-logs-'));
fs.mkdirSync(logsDir, { recursive: true });

const steps = buildPlan(options);
const total = steps.length;
const width = Math.max(...steps.map((s) => s.name.length)) + 2;
const fmtSeconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

console.log(`Shiba Wallet CI runner — mode: ${options.mode.toUpperCase()}, Node ${process.version}`);
console.log(`Repository: ${ROOT}`);
console.log(`Step logs:  ${logsDir}`);
if (options.mode === 'offline') {
  console.log('Offline guard: network (non-loopback) and .dev-wallet are blocked for engine tests and app suites.');
}
console.log('');

const baseEnv = {
  ...process.env,
  PATH: `${NODE_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
  FORCE_COLOR: '0',
  NO_COLOR: '1',
  CI: process.env.CI ?? '1',
  EXPO_NO_TELEMETRY: '1',
};
delete baseEnv.SHIBA_CI_GUARD_LOG;

const results = [];
const runStarted = Date.now();
let prerequisiteFailed = false;

for (let index = 0; index < steps.length; index += 1) {
  const step = steps[index];
  const label = `[${String(index + 1).padStart(2)}/${total}] ${step.name}`.padEnd(width + 8, ' ');

  if (step.skip) {
    console.log(`${label} SKIP  ${step.skip}`);
    results.push({ step, status: 'SKIP', detail: step.skip, ms: 0 });
    continue;
  }
  if (prerequisiteFailed) {
    console.log(`${label} SKIP  engine build failed`);
    results.push({ step, status: 'FAIL', detail: 'not run: engine build failed', ms: 0 });
    continue;
  }

  const slug = `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`;
  const logFile = path.join(logsDir, `${slug}.log`);
  const env = { ...baseEnv, ...(step.extraEnv ?? {}) };
  let guardLog = null;
  if (step.guarded) {
    guardLog = path.join(logsDir, `${slug}.guard.jsonl`);
    env.SHIBA_CI_GUARD_LOG = guardLog;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import=${GUARD}`;
  }

  if (step.parse === 'bundle') {
    step.outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiba-ci-export-'));
    step.args = [...step.args, step.outDir];
  }

  if (options.verbose) console.log(`${label} ...`);
  const result = await runProcess({
    command: step.command,
    args: step.args,
    cwd: step.cwd,
    env,
    timeoutMs: step.timeoutMs,
    logFile,
    verbose: options.verbose,
  });
  const verdict = evaluate(step, result, guardLog ? readGuardLog(guardLog) : null);
  const status = verdict.ok ? 'PASS' : 'FAIL';
  const parts = [verdict.detail, ...verdict.notes].filter(Boolean).join('; ');
  console.log(`${label} ${status}  ${parts}${parts ? '  ' : ''}(${fmtSeconds(result.ms)})`);
  if (!verdict.ok) {
    const tail = result.output.trimEnd().split('\n').slice(-60);
    console.log(`        --- last ${tail.length} lines of ${logFile} ---`);
    for (const line of tail) console.log(`        | ${line}`);
    console.log('        ---');
    if (step.prerequisite) prerequisiteFailed = true;
  }
  results.push({ step, status, detail: parts, ms: result.ms });
}

// Summary
const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP');
const sum = (group, key) =>
  results.filter((r) => r.step.group === group && r.step.counts).reduce((acc, r) => acc + (r.step.counts[key] ?? 0), 0);

console.log('');
console.log('Summary');
const ran = (group) => results.filter((r) => r.step.group === group && r.status !== 'SKIP').length;
if (ran('engine') > 0) {
  console.log(`  engine vitest: ${sum('engine', 'passed')} passed, ${sum('engine', 'failed')} failed across ${ran('engine')} packages`);
}
if (results.some((r) => r.step.group === 'app')) console.log(
  `  app suites:    ${sum('app', 'passed')} passed, ${sum('app', 'failed')} failed across ${ran('app')} suites` +
    `${skipped.some((r) => r.step.group === 'app') ? ` (${skipped.filter((r) => r.step.group === 'app').length} live-only skipped)` : ''}`,
);
console.log(`  steps:         ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
console.log(`  wall time:     ${fmtSeconds(Date.now() - runStarted)}`);
console.log(`  logs:          ${logsDir}`);
if (failed.length > 0) {
  console.log('');
  console.log('FAILED:');
  for (const r of failed) console.log(`  - ${r.step.name}: ${r.detail}`);
  process.exit(1);
}
console.log('');
console.log('ALL GREEN');
