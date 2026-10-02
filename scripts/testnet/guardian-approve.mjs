/**
 * Guardian helper for the in-app social-recovery checks (phase 8 item 4,
 * app half). Signs a guardian approval for a recovery request produced by
 * the app's "Recover an account with guardians" screen, with a key of the
 * DEV seed (.dev-wallet/mnemonic.txt, git-ignored), so a tester can play a
 * guardian without a second phone. Engine code only
 * (packages/chains-evm/src/kernel-recovery.ts); nothing is broadcast.
 *
 *   node scripts/testnet/guardian-approve.mjs addresses [FROM [TO]]
 *     prints the dev seed's EVM addresses m/44'/60'/0'/0/i (default 5..6),
 *     the guardian addresses to enter in the app's Guardians form.
 *
 *   GUARDIAN_INDEX=5 node scripts/testnet/guardian-approve.mjs approve <file>
 *     <file> holds the request as shared by the app (share text or JSON).
 *     The request is re-derived by the engine (parseGuardianRecoveryRequest),
 *     its chain must be Sepolia, the guardian must be in the account's
 *     ON-CHAIN guardian set (read through NODE_URL, default the public
 *     Sepolia RPC), and the proposal must still be ongoing. Prints the
 *     approval payload the app's "Add approval" box accepts (the same JSON
 *     shape as the app's encodeGuardianApprovalPayload).
 *
 * Run from the repository root after `npm run build`.
 */
import { readFileSync } from 'node:fs';
import { ChainRegistry, HdKeyring, evmKeyProvider } from '../../packages/core/dist/index.js';
import {
  httpTransport,
  parseGuardianRecoveryRequest,
  readGuardianState,
  readRecoveryProposal,
  signGuardianApproval,
  toBytes,
  toHex,
  verifyGuardianApproval,
} from '../../packages/chains-evm/dist/index.js';
import { SEPOLIA_RPC } from './config.mjs';

const NODE_URL = process.env.NODE_URL ?? SEPOLIA_RPC;
const SEPOLIA = '11155111';

function keyring() {
  const registry = new ChainRegistry();
  registry.register(evmKeyProvider);
  const mnemonic = readFileSync(new URL('../../.dev-wallet/mnemonic.txt', import.meta.url), 'utf8').trim();
  return HdKeyring.fromMnemonic(mnemonic, registry);
}

/** The first complete JSON object in a text (braces inside strings skipped). */
function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const keys = keyring();
  if (mode === 'addresses') {
    const from = Number(args[0] ?? 5);
    const to = Number(args[1] ?? from + 1);
    for (let i = from; i <= to; i++) {
      console.log(`m/44'/60'/0'/0/${i}  ${keys.getAccount('eip155:1', 0, i).address}`);
    }
    return;
  }
  if (mode !== 'approve' || !args[0]) {
    console.error('Usage: addresses [FROM [TO]] | GUARDIAN_INDEX=n approve <request-file>');
    process.exit(1);
  }
  const json = firstJsonObject(readFileSync(args[0], 'utf8'));
  if (!json) throw new Error('No JSON request found in the file');
  const parsed = JSON.parse(json);
  const request = parseGuardianRecoveryRequest(parsed.type === 'shiba-wallet/guardian-recovery-request' ? parsed.request : parsed);
  if (request.chainId !== SEPOLIA) throw new Error(`Request is for chain ${request.chainId}; this helper signs Sepolia requests only`);
  const index = Number(process.env.GUARDIAN_INDEX ?? '5');
  const guardian = keys.getAccount('eip155:1', 0, index);
  const node = httpTransport(NODE_URL);
  const state = await readGuardianState(node, request.account);
  if (!state.active || !state.set) throw new Error(`${request.account} has no active guardians`);
  if (!state.set.guardians.some((g) => g.address.toLowerCase() === guardian.address.toLowerCase())) {
    throw new Error(`${guardian.address} (index ${index}) is not a guardian of ${request.account}`);
  }
  const proposal = await readRecoveryProposal(node, request.account, request.callDataAndNonceHash);
  if (proposal.status !== 'ongoing') throw new Error(`Proposal is ${proposal.status}; nothing to approve`);
  console.error(`Account   ${request.account}`);
  console.error(`NEW OWNER ${request.newOwner}`);
  console.error(`Proposal  ${request.callDataAndNonceHash}`);
  console.error(`Guardian  ${guardian.address} (m/44'/60'/0'/0/${index})`);
  const signature = signGuardianApproval(guardian, toBytes(request.approvalDigest));
  verifyGuardianApproval(request, signature, state.set);
  console.log(
    JSON.stringify({
      type: 'shiba-wallet/guardian-approval',
      version: 1,
      chainId: request.chainId,
      account: request.account,
      callDataAndNonceHash: request.callDataAndNonceHash,
      guardian: guardian.address,
      signature: toHex(signature),
    }),
  );
}

main().catch((error) => {
  console.error(`guardian-approve failed: ${error.message}`);
  process.exit(1);
});
