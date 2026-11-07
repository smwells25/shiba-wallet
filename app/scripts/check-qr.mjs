// QR support checks (phase 4 item 4), offline, no key material beyond the
// standard public BIP-39 test mnemonic. Two halves:
//
// 1. Encoder round-trip. The Receive screen renders QR codes through
//    react-native-qrcode-svg 6.3.26, whose matrix comes from
//    `QRCode.create(value, { errorCorrectionLevel: 'M' })` in the `qrcode`
//    npm package (see node_modules/react-native-qrcode-svg/src/genMatrix.js
//    and the `ecl = 'M'` default in src/index.js). This script calls the
//    exact same encoder entry point on real derived addresses for all four
//    chains, rasterizes the module matrix, and decodes it with an
//    independent decoder (jsqr, a devDependency used only by this script).
//    A round-trip through an unrelated decoder implementation is the
//    strongest offline evidence the rendered codes are scannable.
//
// 2. Scanned-payload parsing. extractScannedAddress (src/wallet/scan.ts)
//    is exercised edge by edge: scheme stripping only for the active
//    chain, EIP-681 pay-/@/?// handling, BIP-21 and Solana Pay queries,
//    case-insensitive schemes, and mismatched schemes passed through
//    untouched (so the send screen's validation rejects them).
//
//   export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
//   node scripts/check-qr.mjs

import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  bitcoinKeyProvider,
  dogecoinKeyProvider,
  evmKeyProvider,
  mnemonicToSeed,
  solanaKeyProvider,
} from '@shiba-wallet/core';
import { SCHEME_BY_CHAIN, extractScannedAddress } from '../src/wallet/scan.ts';
import {
  BITCOIN_CHAIN_ID,
  DOGECOIN_CHAIN_ID,
  EVM_CHAIN_ID,
  SOLANA_CHAIN_ID,
} from '../src/wallet/send.ts';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const okay = actual === expected;
  if (okay) passed++;
  else failed++;
  console.log(`${okay ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!okay) console.log(`      expected ${expected}\n      actual   ${actual}`);
}

// ---------------------------------------------------------------------------
// Addresses derived through the engine (never hand-typed).
// ---------------------------------------------------------------------------
const seed = mnemonicToSeed(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
);
const ETH = evmKeyProvider.deriveAccount(seed, 0, 0).address;
const BTC = bitcoinKeyProvider.deriveAccount(seed, 0, 0).address;
const DOGE = dogecoinKeyProvider.deriveAccount(seed, 0, 0).address;
const SOL = solanaKeyProvider.deriveAccount(seed, 0, 0).address;
seed.fill(0);

// ---------------------------------------------------------------------------
// 1. Encoder round-trip through the independent jsqr decoder.
// ---------------------------------------------------------------------------

/** Rasterizes a qrcode module matrix into RGBA pixels jsqr can read. */
function rasterize(modules, scale, quiet) {
  const size = modules.size;
  const px = (size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules.get(y, x)) continue; // qrcode's BitMatrix.get(row, col)
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        }
      }
    }
  }
  return { rgba, px };
}

function roundTrip(name, payload) {
  // Exactly react-native-qrcode-svg's genMatrix call (ecl default 'M').
  const code = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const { rgba, px } = rasterize(code.modules, 8, 4);
  const decoded = jsQR(rgba, px, px);
  check(`round-trip ${name} (v${code.version}, ${code.modules.size}x${code.modules.size})`,
    decoded?.data ?? '<decode failed>', payload);
}

roundTrip('ETH address', ETH);
roundTrip('BTC address', BTC);
roundTrip('DOGE address', DOGE);
roundTrip('SOL address', SOL);
// A realistic WalletConnect v2 pairing URI shape (dApp side renders these;
// we only scan them — this proves the decoder half of the pipeline copes
// with long URI payloads too).
roundTrip(
  'wc: pairing URI',
  'wc:7f6e504bfad60b485450578e05678ed3e8e8c4751d3c6160be17160d63ec90f9@2?relay-protocol=irn&symKey=587d5484ce2a2a6ee3ba1962fdd7e8588e06200c46823bd18fbd67def96ad303',
);
// jsQR reports no error-correction repairs, so also assert a deliberately
// corrupted matrix does NOT decode to the payload silently mangled: flip a
// data region pixel block and require either correct data (ECC fixed it)
// or a clean failure — never wrong data.
{
  const code = QRCode.create(ETH, { errorCorrectionLevel: 'M' });
  const { rgba, px } = rasterize(code.modules, 8, 4);
  const mid = Math.floor(px / 2);
  for (let dy = 0; dy < 8; dy++) {
    for (let dx = 0; dx < 8; dx++) {
      const p = ((mid + dy) * px + mid + dx) * 4;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = rgba[p] ? 0 : 255;
    }
  }
  const decoded = jsQR(rgba, px, px);
  check(
    'corrupted module never yields wrong data',
    decoded === null || decoded.data === ETH,
    true,
  );
}

// ---------------------------------------------------------------------------
// 2. extractScannedAddress parsing discipline.
// ---------------------------------------------------------------------------

// scan.ts writes the CAIP-2 ids out literally (it must stay import-free to
// run under Node's TS type stripping); this pins them to send.ts's
// constants so the two can never drift apart.
check(
  'scan.ts chain ids match send.ts',
  JSON.stringify(Object.keys(SCHEME_BY_CHAIN).sort()),
  JSON.stringify([BITCOIN_CHAIN_ID, DOGECOIN_CHAIN_ID, EVM_CHAIN_ID, SOLANA_CHAIN_ID].sort()),
);

// Plain addresses pass through untouched on every chain.
check('plain ETH untouched', extractScannedAddress(EVM_CHAIN_ID, ETH), ETH);
check('plain BTC untouched', extractScannedAddress(BITCOIN_CHAIN_ID, BTC), BTC);
check('plain DOGE untouched', extractScannedAddress(DOGECOIN_CHAIN_ID, DOGE), DOGE);
check('plain SOL untouched', extractScannedAddress(SOLANA_CHAIN_ID, SOL), SOL);
check('whitespace trimmed', extractScannedAddress(EVM_CHAIN_ID, `  ${ETH}\n`), ETH);

// Active chain's own scheme is stripped.
check('ethereum: stripped', extractScannedAddress(EVM_CHAIN_ID, `ethereum:${ETH}`), ETH);
check('bitcoin: stripped', extractScannedAddress(BITCOIN_CHAIN_ID, `bitcoin:${BTC}`), BTC);
check('dogecoin: stripped', extractScannedAddress(DOGECOIN_CHAIN_ID, `dogecoin:${DOGE}`), DOGE);
check('solana: stripped', extractScannedAddress(SOLANA_CHAIN_ID, `solana:${SOL}`), SOL);

// Scheme matching is case-insensitive (RFC 3986 3.1); body case preserved.
check('scheme case-insensitive', extractScannedAddress(EVM_CHAIN_ID, `ETHEREUM:${ETH}`), ETH);
check(
  'BIP-21 uppercase-mode scheme',
  extractScannedAddress(BITCOIN_CHAIN_ID, `BITCOIN:${BTC}`),
  BTC,
);

// Query parameters are cut everywhere (BIP-21 / Solana Pay / EIP-681).
check(
  'bitcoin ?amount cut',
  extractScannedAddress(BITCOIN_CHAIN_ID, `bitcoin:${BTC}?amount=0.01&label=x`),
  BTC,
);
check(
  'solana ?amount cut',
  extractScannedAddress(SOLANA_CHAIN_ID, `solana:${SOL}?amount=1&reference=abc`),
  SOL,
);
check(
  'ethereum ?value cut',
  extractScannedAddress(EVM_CHAIN_ID, `ethereum:${ETH}?value=1e18`),
  ETH,
);

// EIP-681 extras: optional pay- prefix, @chain_id, /function_name.
check('EIP-681 pay- prefix', extractScannedAddress(EVM_CHAIN_ID, `ethereum:pay-${ETH}`), ETH);
check('EIP-681 @chain_id cut', extractScannedAddress(EVM_CHAIN_ID, `ethereum:${ETH}@1`), ETH);
check(
  'EIP-681 /function cut',
  extractScannedAddress(EVM_CHAIN_ID, `ethereum:${ETH}/transfer?address=x`),
  ETH,
);
check(
  'EIP-681 all together',
  extractScannedAddress(EVM_CHAIN_ID, `ethereum:pay-${ETH}@1?value=2014000000000000000`),
  ETH,
);

// Mismatched schemes pass through UNTOUCHED — the send screen's existing
// validation rejects them with its normal error; this module never guesses.
check(
  'bitcoin: URI while sending ETH passes through',
  extractScannedAddress(EVM_CHAIN_ID, `bitcoin:${BTC}`),
  `bitcoin:${BTC}`,
);
check(
  'ethereum: URI while sending BTC passes through',
  extractScannedAddress(BITCOIN_CHAIN_ID, `ethereum:${ETH}`),
  `ethereum:${ETH}`,
);
check(
  'bitcoin: URI while sending DOGE passes through',
  extractScannedAddress(DOGECOIN_CHAIN_ID, `bitcoin:${BTC}`),
  `bitcoin:${BTC}`,
);
check(
  'wc: URI in the send scanner passes through',
  extractScannedAddress(EVM_CHAIN_ID, 'wc:abc@2?x=y'),
  'wc:abc@2?x=y',
);
check(
  'unknown chain id: payload untouched',
  extractScannedAddress('eip155:137', `ethereum:${ETH}`),
  `ethereum:${ETH}`,
);
// A scheme-less payload containing "?" is not a URI; conservative
// stripping only ever happens after a matched scheme.
check(
  'no scheme, no stripping',
  extractScannedAddress(BITCOIN_CHAIN_ID, `${BTC}?amount=1`),
  `${BTC}?amount=1`,
);

// ---------------------------------------------------------------------------
// The scanner with no camera (phase 24 item 4, finding 6): the iOS Simulator
// has no camera and the scanner showed an empty preview. A fake camera module
// stands in for expo-camera's CameraView.getAvailableLensesAsync().
// ---------------------------------------------------------------------------
{
  const QC = await import('../src/components/qr-camera.ts');
  const { readFileSync } = await import('node:fs');
  const scannerSrc = readFileSync(new URL('../src/components/QrScanner.tsx', import.meta.url), 'utf8');
  const fakeCamera = (lenses, opts = {}) => {
    const calls = { lenses: 0 };
    return {
      calls,
      getAvailableLensesAsync: async () => {
        calls.lenses += 1;
        if (opts.throws) throw new Error('view not found');
        return lenses;
      },
    };
  };
  check('no-camera sentence (exact)', QC.QR_NO_CAMERA_MESSAGE,
    'This device has no camera that this app can use, so a QR code cannot be scanned here; paste the text instead.');
  const none = fakeCamera([]);
  check('iOS: an empty lens list after onCameraReady means no camera', await QC.availabilityAfterReady('ios', () => none.getAvailableLensesAsync()), 'none');
  check('iOS: the lens list was asked once', none.calls.lenses, 1);
  check('iOS: a back camera listed keeps the preview',
    await QC.availabilityAfterReady('ios', () => fakeCamera(['Back Camera']).getAvailableLensesAsync()), 'available');
  check('iOS: a failed lens read proves nothing and keeps the preview',
    await QC.availabilityAfterReady('ios', () => fakeCamera([], { throws: true }).getAvailableLensesAsync()), 'available');
  check('iOS: a malformed lens answer keeps the preview',
    await QC.availabilityAfterReady('ios', () => fakeCamera(undefined).getAvailableLensesAsync()), 'available');
  const android = fakeCamera([]);
  check('Android: onCameraReady means the camera opened; the lens list (not defined on Android) is never asked',
    (await QC.availabilityAfterReady('android', () => android.getAvailableLensesAsync())) + ':' + android.calls.lenses, 'available:0');
  check('a mount error (Android CameraX could not bind a camera) means no camera, with its message as the detail',
    JSON.stringify(QC.availabilityAfterMountError('Camera could not be started, it may be unavailable or in use by another app: no camera')),
    JSON.stringify({ availability: 'none', detail: 'Camera could not be started, it may be unavailable or in use by another app: no camera' }));
  check('the iOS session-reset mount error is not a missing camera', QC.availabilityAfterMountError('Camera session was reset'), null);
  check('a mount error with no message: no camera, no detail', JSON.stringify(QC.availabilityAfterMountError(undefined)), JSON.stringify({ availability: 'none', detail: null }));
  check('QrScanner wires onCameraReady (with the view\'s lens list) and onMountError, and shows the sentence instead of the preview',
    scannerSrc.includes('onCameraReady={onCameraReady}') && scannerSrc.includes('onMountError={onMountError}') &&
      scannerSrc.includes('ref={cameraRef}') && scannerSrc.includes('availabilityAfterReady(Platform.OS, async () => cameraRef.current?.getAvailableLensesAsync())') &&
      scannerSrc.includes("permission.granted && camera.availability === 'none' ? (") && scannerSrc.includes('{QR_NO_CAMERA_MESSAGE}') &&
      scannerSrc.indexOf("camera.availability === 'none'") < scannerSrc.indexOf('<CameraView\n'), true);
  check('…and the state starts over each time the scanner closes', scannerSrc.includes("setCamera({ availability: 'checking', detail: null });"), true);
  // Mutant: the empty-list rule removed (the Simulator's empty preview again).
  const src = readFileSync(new URL('../src/components/qr-camera.ts', import.meta.url), 'utf8');
  const anchor = "  if (Array.isArray(lenses) && lenses.length === 0) return 'none';\n";
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'check-qr-mutant-'));
  try {
    writeFileSync(join(dir, 'qr-camera.ts'), src.replace(anchor, ''));
    const m = await import(join(dir, 'qr-camera.ts'));
    check('mutant caught: the empty lens list ignored (an empty preview with no camera)',
      src.includes(anchor) && (await m.availabilityAfterReady('ios', async () => [])) !== 'none', true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
