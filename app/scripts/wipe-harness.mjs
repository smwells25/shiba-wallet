// A helper for check-storage-seam and check-records-backup (not a suite):
// runs the two wipe lists of WalletContext.tsx against an in-memory store,
// in the order the wipe callback calls them.
//
// The wipe itself is a React callback (WalletContext.tsx `wipe`), which
// Node cannot render. This helper reads that callback's source with the
// TypeScript compiler API, takes the functions it calls by name, in source
// order, separately for the plain path and for the app-PIN path's
// resetRecords, and runs each one that touches the records store through
// WIPE_STORE_RUNNERS, passing the fake store explicitly (in the app the
// plain path passes AsyncStorage, and resetAccounts() takes its default,
// which is AsyncStorage too). Calls that touch only the secure store or
// React state are listed in WIPE_NON_STORE_CALLS and skipped; any other
// call is refused, so a reset added to the wipe without a runner here
// fails the suites instead of being skipped silently.
//
// Pass p23-devbuild-recheck follow-up 1 (phase 24 item B): the wipe now
// REMOVES each wallet-scoped key instead of writing an empty document;
// the suites use this helper to prove it on the real lists.

import ts from 'typescript';

import { forgetAllSessions } from '../src/wallet/sessions.ts';
import { wipeRecoveryData } from '../src/wallet/recovery.ts';
import { resetPasskeys } from '../src/wallet/passkeys.ts';
import { resetSpendingLimits } from '../src/wallet/spending-policy.ts';
import { forgetBrowserConnections } from '../src/wallet/browser-sites.ts';
import { wipeTransactionNotes } from '../src/wallet/notes.ts';
import { resetMultisigRecords } from '../src/wallet/multisig.ts';
import { resetPendingRegistry } from '../src/wallet/pending-transactions.ts';
import { resetPriceAlerts } from '../src/wallet/price-alerts.ts';
import { resetBridgeTransfers } from '../src/wallet/bridge.ts';
import { wipeInbox } from '../src/wallet/inbox.ts';
import { resetPendingHandles } from '../src/wallet/handle.ts';
import { resetContacts } from '../src/wallet/contacts.ts';
import { resetTrackedTokens } from '../src/wallet/tokens.ts';
import { resetTakeoverScanStates } from '../src/wallet/inheritance.ts';
import { clearAllEip7702Owners } from '../src/wallet/aa.ts';
import { resetAccounts } from '../src/wallet/accounts.ts';

/** A session-key vault stand-in: the records hold no key in these runs, so nothing is removed from it. */
const NO_KEYS_VAULT = { remove: async () => undefined };

/** The reset functions of the wipe, each run on the given records store. */
export const WIPE_STORE_RUNNERS = {
  forgetAllSessions: (s) => forgetAllSessions(s, NO_KEYS_VAULT),
  wipeRecoveryData: (s) => wipeRecoveryData(s),
  resetPasskeys: (s) => resetPasskeys(s),
  resetSpendingLimits: (s) => resetSpendingLimits(s),
  forgetBrowserConnections: (s) => forgetBrowserConnections(s),
  wipeTransactionNotes: (s) => wipeTransactionNotes(s),
  resetMultisigRecords: (s) => resetMultisigRecords(s),
  resetPendingRegistry: (s) => resetPendingRegistry(s),
  resetPriceAlerts: (s) => resetPriceAlerts(s),
  resetBridgeTransfers: (s) => resetBridgeTransfers(s),
  wipeInbox: (s) => wipeInbox(s),
  resetPendingHandles: (s) => resetPendingHandles(s),
  resetContacts: (s) => resetContacts(s),
  resetTrackedTokens: (s) => resetTrackedTokens(s),
  resetTakeoverScanStates: (s) => resetTakeoverScanStates(s),
  clearAllEip7702Owners: (s) => clearAllEip7702Owners(s),
  resetAccounts: (s) => resetAccounts(s),
};

/**
 * Calls of the wipe that touch only the secure store (the phrase, the public
 * address cache, both wallets of an app PIN) or React state; they do not
 * read or write the records store and are skipped here.
 */
export const WIPE_NON_STORE_CALLS = new Set([
  'deleteMnemonic', 'deletePublicAccounts', 'wipeBothWallets', 'createProfileVault', 'appSecureBackend',
  'dropPhraseTicket', 'setDerived', 'setMultisigInfo', 'commitAccounts', 'setPendingMnemonic', 'setSessionSlot',
  'setProfileKey', 'setStatus',
  // The risk overview's in-memory snapshots (wallet/insights.ts; phase 25 item 2): no store.
  'forgetInsightSnapshots',
]);

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function callsInOrder(node) {
  const names = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.push(n.expression.text);
  });
  return names;
}

/** The functions the wipe calls by name, in source order: { plain, pin } (pin = resetRecords). Null when the callback is not found. */
export function wipeCallOrder(walletContextText) {
  const sf = ts.createSourceFile('WalletContext.tsx', walletContextText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = null;
  walk(sf, (n) => {
    if (body || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== 'wipe') return;
    const init = n.initializer;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback') {
      const fn = init.arguments[0];
      if (fn && ts.isArrowFunction(fn) && ts.isBlock(fn.body)) body = fn.body;
    }
  });
  if (!body) return null;
  const pinIf = body.statements.find((st) => ts.isIfStatement(st) && st.expression.getText(sf) === 'appPinPresence.get()');
  if (!pinIf) return null;
  let resetRecords = null;
  walk(pinIf, (n) => {
    if (!resetRecords && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'resetRecords' && n.initializer && ts.isArrowFunction(n.initializer)) {
      resetRecords = n.initializer;
    }
  });
  if (!resetRecords) return null;
  const plain = [];
  for (const st of body.statements) if (st !== pinIf) plain.push(...callsInOrder(st));
  return { plain, pin: callsInOrder(resetRecords.body) };
}

/**
 * Runs one wipe list on `store`. Returns the names it ran; throws on a call
 * that is neither a known reset nor a known secure-store or state call.
 */
export async function runWipeList(names, store, runners = WIPE_STORE_RUNNERS) {
  const ran = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(runners, name)) {
      await runners[name](store);
      ran.push(name);
    } else if (!WIPE_NON_STORE_CALLS.has(name)) {
      throw new Error(`The wipe calls ${name}, which wipe-harness.mjs does not know: add a runner or list it as a non-store call.`);
    }
  }
  return ran;
}

/** An in-memory AsyncStorage stand-in (getItem, setItem, removeItem, getAllKeys) that logs every write and removal. */
export function wipeMemStore(initial = []) {
  const map = new Map(initial);
  const writes = [];
  const removals = [];
  return {
    map,
    writes,
    removals,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => {
      writes.push(k);
      map.set(k, v);
    },
    removeItem: async (k) => {
      removals.push(k);
      map.delete(k);
    },
    getAllKeys: async () => [...map.keys()],
  };
}
