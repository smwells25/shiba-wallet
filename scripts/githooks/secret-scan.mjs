// Secret scanner for the Shiba Wallet repository. This repository is PUBLIC:
// anything committed here must be assumed to be read by an attacker. The
// scanner runs from the pre-commit hook (scripts/githooks/pre-commit) over
// the staged version of every added or modified file, and from CI over the
// whole tree, and refuses when it finds something that looks like a secret.
//
// Usage:
//   node scripts/githooks/secret-scan.mjs --staged      what the hook runs
//   node scripts/githooks/secret-scan.mjs --tree HEAD   every file in a commit
//   node scripts/githooks/secret-scan.mjs --files a b   specific files on disk
//
// What it looks for:
//   alchemy-key       an Alchemy-style API key in a URL path: /v2/<key> or
//                     /nft/v3/<key> (the keys seen so far are 26 characters;
//                     anything of 20 or more key characters is flagged)
//   zerodev-project   a UUID inside an rpc.zerodev.app URL, or assigned to a
//                     ZERODEV_PROJECT_ID name
//   nownodes-key      a key on a line that mentions NOWNodes, assigned to a
//                     NOWNODES_KEY name, or sent as an api-key header value
//   mnemonic          12 or more consecutive words from the BIP-39 English
//                     wordlist (read from the installed @scure/bip39 package)
//   private-key       0x followed by 64 hex digits on a line where a word such
//                     as key, priv or secret appears shortly before it
//   dev-wallet        the literal value of anything stored in the local,
//                     git-ignored .dev-wallet/ directory (when it exists), or
//                     a staged path inside .dev-wallet/
//
// Accepted on purpose (the ALLOW list below, each entry with its reason):
//   - REOWN_PROJECT_ID: the WalletConnect / Reown project id is a public
//     client identifier that the app ships in app/src/wallet/walletconnect.ts.
//   - BIP-39 phrases whose entropy is one byte repeated (for example the
//     "abandon ... about" phrase, entropy all zero): these are the published
//     BIP-39 test vectors used throughout the tests. They are public and can
//     never protect funds. Any other phrase is flagged.
//   - Specific public test private keys listed in ALLOWED_PRIVATE_KEYS.
//
// Findings never print the secret itself: values are shown shortened, so
// that the scanner's own output (for example in a CI log) does not leak what
// it found.
//
// Written for old Node versions too (14 and later), because a git hook runs
// with whatever `node` the committer's shell finds first.

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Allow list. Every entry needs a reason a reviewer can check.
// ---------------------------------------------------------------------------

// The public WalletConnect / Reown project id shipped in the app
// (DEFAULT_WC_PROJECT_ID in app/src/wallet/walletconnect.ts). The same value
// sits in .dev-wallet/env as REOWN_PROJECT_ID, so the literal-value check
// skips that name and this value.
const ALLOWED_ENV_NAMES = ['REOWN_PROJECT_ID'];
const ALLOWED_LITERALS = ['a6d5afbd869df1713ca48fa14fb3fcf8'];

// Private keys that are public test material (lowercase, without 0x). Both
// are fixtures of offline engine tests and have been in the public history
// since the commits named below; listing them here exposes nothing new.
const ALLOWED_PRIVATE_KEYS = {
  // Synthetic secp256k1 session key of the offline byte-comparison tests in
  // packages/chains-evm/test/kernel-permissions.test.ts (SESSION_PRIVATE_KEY,
  // address 0x484B87B8D4D73d88ccF7D39C006cC1b078384640); since 035ca2f.
  '0d04b3f51f6e0c7b0ccfb9aef76421285a08cba424e2a684ca1a664da32650a4': 'kernel-permissions test session key',
  // "Fixed synthetic P-256 key" of packages/chains-evm/test/kernel-webauthn.test.ts
  // (SDK.secret), used to produce the passkey reference signatures.
  '263e6b57150b681a561d2970d066a17a1404e5f1a409d3b96c8b1ec1801d6e6e': 'kernel-webauthn test P-256 key',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, options) {
  return execFileSync('git', args, Object.assign({ maxBuffer: 256 * 1024 * 1024 }, options || {}));
}

const REPO_ROOT = git(['rev-parse', '--show-toplevel']).toString().trim();

function mask(value) {
  if (value.length <= 8) return `<${value.length} chars>`;
  return `${value.slice(0, 4)}…<${value.length} chars>`;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// ---------------------------------------------------------------------------
// BIP-39 wordlist (from the installed @scure/bip39 package, no new dependency)
// ---------------------------------------------------------------------------

function loadWordlist() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', '@scure', 'bip39', 'wordlists', 'english.js'),
    path.join(REPO_ROOT, 'app', 'node_modules', '@scure', 'bip39', 'wordlists', 'english.js'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf('`');
    const end = source.indexOf('`', start + 1);
    if (start < 0 || end < 0) continue;
    const words = source.slice(start + 1, end).split('\n').map((w) => w.trim()).filter(Boolean);
    if (words.length === 2048 && words[0] === 'abandon' && words[2047] === 'zoo') return words;
  }
  return null;
}

const WORDLIST = loadWordlist();
const WORD_INDEX = new Map();
if (WORDLIST) WORDLIST.forEach((w, i) => WORD_INDEX.set(w, i));

// Decode a phrase per BIP-39: 11 bits per word, the last words/3 bits are a
// checksum equal to the first bits of sha256(entropy). Returns the entropy
// bytes when the checksum is valid, otherwise null.
function bip39Entropy(words) {
  if (![12, 15, 18, 21, 24].includes(words.length)) return null;
  let bits = '';
  for (const w of words) bits += WORD_INDEX.get(w).toString(2).padStart(11, '0');
  const checksumBits = words.length / 3;
  const entropyBits = bits.slice(0, bits.length - checksumBits);
  const entropy = Buffer.alloc(entropyBits.length / 8);
  for (let i = 0; i < entropy.length; i += 1) entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  const hash = createHash('sha256').update(entropy).digest();
  let hashBits = '';
  for (const byte of hash) hashBits += byte.toString(2).padStart(8, '0');
  return hashBits.slice(0, checksumBits) === bits.slice(bits.length - checksumBits) ? entropy : null;
}

function isRepeatedByte(entropy) {
  for (const b of entropy) if (b !== entropy[0]) return false;
  return true;
}

function findMnemonics(text, report) {
  // Words are maximal runs of ASCII letters. Two words are consecutive when
  // only whitespace or punctuation separates them (no digit or other word),
  // which covers space-separated phrases and quoted arrays alike.
  const re = /[A-Za-z]+/g;
  let run = [];
  let lastEnd = -1;
  const flush = () => {
    if (run.length >= 12) checkRun(text, run, report);
    run = [];
  };
  let m;
  while ((m = re.exec(text)) !== null) {
    // Compare in lower case, so a capitalized or upper-case phrase is caught too.
    const word = m[0].toLowerCase();
    const gap = lastEnd < 0 ? '' : text.slice(lastEnd, m.index);
    const inList = WORD_INDEX.has(word);
    if (!inList || /[0-9_$]/.test(gap)) flush();
    if (inList) run.push({ word, index: m.index });
    lastEnd = m.index + word.length;
  }
  flush();
}

function checkRun(text, run, report) {
  const words = run.map((r) => r.word);
  const covered = new Array(words.length).fill(false);
  // Longest phrase first; once a stretch is accounted for, shorter windows
  // inside it (which pass the checksum by chance about 1 time in 16) are not
  // reported again.
  for (let start = 0; start < words.length; start += 1) {
    for (const len of [24, 21, 18, 15, 12]) {
      if (start + len > words.length) continue;
      if (covered.slice(start, start + len).some(Boolean)) continue;
      const entropy = bip39Entropy(words.slice(start, start + len));
      if (!entropy) continue;
      if (isRepeatedByte(entropy)) {
        for (let i = start; i < start + len; i += 1) covered[i] = true;
      } else {
        report('mnemonic', run[start].index, `valid ${len}-word BIP-39 phrase starting "${words[start]} …"`);
        for (let i = start; i < start + len; i += 1) covered[i] = true;
      }
    }
  }
  // Whatever is not part of an allowed or already reported phrase: 12 or
  // more consecutive wordlist words is suspicious even without a checksum
  // (a phrase with a typo, or a partial copy).
  let count = 0;
  for (let i = 0; i <= words.length; i += 1) {
    if (i < words.length && !covered[i]) {
      count += 1;
    } else {
      if (count >= 12) {
        const first = i - count;
        report('mnemonic', run[first].index, `${count} consecutive BIP-39 wordlist words starting "${words[first]} …"`);
      }
      count = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// .dev-wallet literals
// ---------------------------------------------------------------------------

// The .dev-wallet directories to compare against: the one in this checkout
// and, when committing from a linked worktree, the one in the main checkout
// (git's common directory is <main checkout>/.git).
function devWalletDirs() {
  const dirs = [path.join(REPO_ROOT, '.dev-wallet')];
  try {
    const common = path.resolve(REPO_ROOT, git(['rev-parse', '--git-common-dir'], { cwd: REPO_ROOT }).toString().trim());
    dirs.push(path.join(path.dirname(common), '.dev-wallet'));
  } catch (error) {
    // Not fatal: the checkout's own .dev-wallet is still checked.
  }
  const seen = new Set();
  return dirs.filter((d) => {
    if (!fs.existsSync(d)) return false;
    const real = fs.realpathSync(d);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function loadDevWalletLiterals() {
  const literals = [];
  const add = (value, label) => {
    const v = value.trim().replace(/^['"]|['"]$/g, '');
    if (v.length < 12) return; // too short to be a meaningful secret match
    if (ALLOWED_LITERALS.includes(v)) return;
    literals.push({ value: v, label, normalized: v.replace(/\s+/g, ' ') });
  };
  let dirRoot = '';
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const rel = `.dev-wallet/${path.relative(dirRoot, full)}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (fs.statSync(full).size > 1024 * 1024) continue;
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      const envLike = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#')).every((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l.trim()));
      if (envLike) {
        for (const line of lines) {
          const t = line.trim();
          if (t === '' || t.startsWith('#')) continue;
          const name = t.slice(0, t.indexOf('='));
          if (ALLOWED_ENV_NAMES.includes(name)) continue;
          const value = t.slice(t.indexOf('=') + 1);
          add(value, `the value of ${name} in ${rel}`);
          // A URL value usually embeds a key in its path or query; match the
          // key on its own as well, in case the URL is rebuilt elsewhere.
          const parts = value.split(/[/?&=#]/);
          for (const part of parts) if (/[0-9]/.test(part) && part.length >= 16) add(part, `part of ${name} in ${rel}`);
        }
      } else {
        add(content, `the contents of ${rel}`);
        for (const line of lines) add(line, `a line of ${rel}`);
      }
    }
  };
  for (const dir of devWalletDirs()) {
    dirRoot = dir;
    walk(dir);
  }
  // The same value can be listed twice (a whole file and its only line).
  const unique = new Map();
  for (const l of literals) if (!unique.has(l.value)) unique.set(l.value, l);
  return [...unique.values()];
}

// ---------------------------------------------------------------------------
// Scanning one file
// ---------------------------------------------------------------------------

function scanText(file, text, literals) {
  const findings = [];
  const seen = new Set();
  const report = (rule, index, message) => {
    const line = lineOf(text, index);
    const key = `${rule}:${line}`; // one finding per rule and line is enough to act on
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, line, rule, message });
  };

  let m;
  const alchemy = /\/(?:v2|nft\/v3)\/([A-Za-z0-9_-]{20,})/g;
  while ((m = alchemy.exec(text)) !== null) {
    const token = m[1];
    if (/^0x[0-9a-fA-F]+$/.test(token)) continue; // an address or hash, not a key
    if (/^[A-Z0-9_-]+$/.test(token) && /[A-Z]{3}/.test(token) && !/[0-9]/.test(token)) continue; // YOUR_API_KEY style placeholder
    report('alchemy-key', m.index, `API key in a URL path (${mask(token)})`);
  }

  const zerodevUrl = new RegExp(`rpc\\.zerodev\\.app[^\\s'"\`]*?(${UUID})`, 'g');
  while ((m = zerodevUrl.exec(text)) !== null) report('zerodev-project', m.index, `ZeroDev project id in a URL (${mask(m[1])})`);
  const zerodevName = new RegExp(`ZERODEV_PROJECT_ID['"]?\\s*[=:]\\s*['"]?(${UUID})`, 'g');
  while ((m = zerodevName.exec(text)) !== null) report('zerodev-project', m.index, `ZeroDev project id assigned (${mask(m[1])})`);

  const nownodesName = /NOWNODES_(?:API_)?KEY['"]?\s*[=:]\s*['"]?([A-Za-z0-9-]{16,})/g;
  while ((m = nownodesName.exec(text)) !== null) report('nownodes-key', m.index, `NOWNodes key assigned (${mask(m[1])})`);
  const apiKeyHeader = new RegExp(`api-?key['"]?\\s*[:=]\\s*['"\`](${UUID}|[A-Za-z0-9]{32,})['"\`]`, 'gi');
  while ((m = apiKeyHeader.exec(text)) !== null) report('nownodes-key', m.index, `api-key value (${mask(m[1])})`);
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (/nownodes/i.test(line)) {
      const k = new RegExp(`(${UUID})`).exec(line);
      if (k) report('nownodes-key', offset + k.index, `key-shaped UUID on a NOWNodes line (${mask(k[1])})`);
    }
    offset += line.length + 1;
  }

  const privateKey = /(key|priv|secret)[A-Za-z0-9_\s'"`:=(),.[\]{}-]{0,40}?\b0x([0-9a-fA-F]{64})(?![0-9a-fA-F])/gi;
  while ((m = privateKey.exec(text)) !== null) {
    const hex = m[2].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ALLOWED_PRIVATE_KEYS, hex)) continue;
    // 32 or more leading zero digits (e.g. storage slot 0x00…01) cannot come
    // from a random 256-bit secret (probability 2^-128); not a key.
    if (/^0{32}/.test(hex)) continue;
    report('private-key', m.index, `32-byte hex value after "${m[1]}" (0x${mask(hex)})`);
  }

  if (WORDLIST) findMnemonics(text, report);

  if (literals.length > 0) {
    const normalized = text.replace(/\s+/g, ' ');
    for (const literal of literals) {
      const index = text.indexOf(literal.value);
      if (index >= 0) report('dev-wallet', index, `matches ${literal.label}`);
      else if (literal.normalized.includes(' ') && normalized.includes(literal.normalized)) report('dev-wallet', 0, `matches ${literal.label} (whitespace-normalized)`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function isBinary(buffer) {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function stagedFiles() {
  const out = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: REPO_ROOT }).toString();
  return out.split('\0').filter(Boolean).map((p) => ({ path: p, read: () => git(['show', `:${p}`], { cwd: REPO_ROOT }) }));
}

function treeFiles(rev) {
  const out = git(['ls-tree', '-r', '-z', '--name-only', rev], { cwd: REPO_ROOT }).toString();
  return out.split('\0').filter(Boolean).map((p) => ({ path: p, read: () => git(['show', `${rev}:${p}`], { cwd: REPO_ROOT }) }));
}

function diskFiles(paths) {
  return paths.map((p) => ({ path: path.relative(REPO_ROOT, path.resolve(p)), read: () => fs.readFileSync(p) }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let files;
let what;
if (args[0] === '--tree') {
  const rev = args[1] || 'HEAD';
  files = treeFiles(rev);
  what = `every file in ${rev}`;
} else if (args[0] === '--files') {
  files = diskFiles(args.slice(1));
  what = `${files.length} file(s) on disk`;
} else if (args.length === 0 || args[0] === '--staged') {
  files = stagedFiles();
  what = 'staged changes';
} else {
  console.error('usage: secret-scan.mjs [--staged | --tree <rev> | --files <path>...]');
  process.exit(2);
}

if (!WORDLIST) {
  console.error('secret-scan: cannot find the BIP-39 English wordlist (node_modules/@scure/bip39).');
  console.error('Run `npm ci` at the repository root first. Refusing to continue without the mnemonic check.');
  process.exit(2);
}

const literals = loadDevWalletLiterals();
const findings = [];
let scanned = 0;
let skippedBinary = 0;
for (const file of files) {
  if (file.path.split('/').includes('.dev-wallet')) {
    findings.push({ file: file.path, line: 0, rule: 'dev-wallet', message: 'a file inside .dev-wallet/ is staged; that directory must never be committed' });
    continue;
  }
  const buffer = file.read();
  if (isBinary(buffer)) {
    skippedBinary += 1;
    continue;
  }
  scanned += 1;
  for (const f of scanText(file.path, buffer.toString('utf8'), literals)) findings.push(f);
}

const devWalletNote = literals.length > 0 ? `, ${literals.length} .dev-wallet value(s) checked` : ', no local .dev-wallet';
if (findings.length === 0) {
  console.log(`secret-scan: clean — ${scanned} file(s) in ${what}${skippedBinary ? `, ${skippedBinary} binary skipped` : ''}${devWalletNote}.`);
  process.exit(0);
}

console.error(`secret-scan: ${findings.length} possible secret(s) in ${what}:`);
for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.message}`);
console.error('');
console.error('This repository is public. Remove the value (keep keys in the git-ignored .dev-wallet/');
console.error('or in runtime settings). If a finding is a deliberate public value, add it with a');
console.error('reason to the allow list at the top of scripts/githooks/secret-scan.mjs.');
process.exit(1);
