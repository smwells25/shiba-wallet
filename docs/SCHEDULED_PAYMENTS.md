# Scheduled and Recurring Payments (Features 25 and 63)

Phase 14, item 5. A design document for leadership and engineers. Nothing in
this document has been built yet; it says what can be scheduled honestly with
the modules this wallet already uses, what cannot, and which slice is worth
building next. Every factual claim cites the contract source, the engine code
or a recorded on-chain result. Claims that were reasoned rather than tested
say so.

## 1. Summary

The wallet can already make one kind of scheduled payment honestly: a
**payee-pulled subscription**, in which a merchant holds a session key that
the subscriber's Kernel v3.3 account limits on-chain to one recipient, one
token, a maximum amount per transfer, one transfer per period and a total fee
budget. That flow was proven live on Sepolia in phase 12 (item 2) and in the
app in phase 13 (item 5).

The same machinery supports a **user-pushed recurring payment** ("pay 50 USDC
to my landlord every 30 days"), because the only difference is who holds the
session key and who decides when to submit. Something must be online to
submit each payment: the user's own phone while the app is open, a small
keeper the user runs, or a third-party automation service. Each of these
holders can do exactly what a subscription merchant can do, including the one
weakness the deployed modules cannot close: a single operation may batch
several transfers, each within the per-transfer cap, up to the account's whole
balance of that token.

**Dollar-cost averaging (recurring swaps) should not be built on the deployed
modules.** A session-key policy can pin the arguments of exactly one kind of
swap call this document examined — Uniswap's SwapRouter02
`exactInputSingle`, whose arguments are all fixed-size — but even there it can
enforce only a static minimum output, not a fair price, so an unattended swap
is exposed to price manipulation up to that floor. Aggregator calldata (0x)
and Uniswap's Universal Router cannot be pinned at all.

**Recommendation:** build the user-pushed recurring payment next, for the
native currency and USDC only, with the batching weakness stated first, the fee
budget mandatory, and the phone ("pay when I open the app") as the first
submitter, with export to a keeper the user runs as the second step. Do not
build recurring swaps until a policy that checks the price on-chain exists in
audited, deployed form.

## 2. What the deployed policies enforce

The wallet's session keys are Kernel v3.3 permissions made of one signer and
several policies (engine: `packages/chains-evm/src/kernel-permissions.ts` and
`kernel-subscription.ts`; sources are the verified ZeroDev plugin contracts,
Sourcify full matches on Ethereum mainnet with identical runtime code on
Sepolia, as recorded in those files):

- **CallPolicy v0.0.4** (`0x9a52283276A0ec8740DF50bF01B28A80D880eaf2`) allows
  a list of (target, function selector) pairs, each with a cap on the ETH value
  of the call and rules on the call's arguments. A rule compares one 32-byte
  word of the calldata, read at a fixed byte offset after the selector, with
  one of seven conditions: equal, greater than, less than, greater than or
  equal, less than or equal, not equal, or one of a list
  (`kernel-permissions.ts`, the `SessionParamCondition` comment and
  `SessionParamRule.offset`). Comparisons are on the raw word, unsigned. For a
  batch operation, every execution is checked against the single-call rules on
  its own; the policy never adds amounts up, and a permission cannot forbid
  batch mode (`kernel-subscription.ts`, policy facts).
- **RateLimitPolicy** (`0xf63d4139B25c836334edD76641356c6b74C86873`) holds an
  interval, a count and a start time. Each operation uses up one count and is
  valid only from `startAt + k × interval`; when the count reaches zero, every
  further operation fails. The count is the total number of operations, not a
  per-period number, and missed periods are not lost: after a gap, several
  operations can be valid at once (`kernel-subscription.ts`). The interval is a
  fixed number of seconds, so "every calendar month" can only be approximated
  (for example 30 days).
- **TimestampPolicy** (`0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F`) bounds the
  whole grant to a start and an end time.
- **GasPolicy** (`0xaeFC5AbC67FfD258abD0A3E54f65E70326F84b23`) charges
  `(preVerificationGas + verificationGasLimit + callGasLimit) × maxFeePerGas`
  of every operation against a total budget. It is mandatory for any grant
  whose key holder can bundle its own operations: without it, that holder could
  declare a very high fee and collect the difference from the account's ETH
  (`kernel-subscription.ts`).
- The session **signer** is installed with the SKIP_SIGNATURE flag, so a
  session key can never produce an ERC-1271 signature for the account: it
  cannot sign permits, orders or logins (`kernel-permissions.ts`).

**Recorded live behaviour** (AGENTS.md, phase 12 item 2, Sepolia, ZeroDev's
bundler): three scheduled pulls by a keeper holding only the session key
succeeded; an immediate second pull was refused at submission with "AA22
expired or not due"; an over-cap pull was refused with the CallPolicy error
`CallViolatesValueRule()`; a fourth pull was refused with `PolicyFailed(3)`
when the rate limit's count was used up; and a pull after revocation was
refused. The GasPolicy charged roughly 300,000 to 370,000 gas at the declared
fee per pull.

### 2.1 The two limits every scheduled payment inherits

1. **Batching.** One operation may be an ERC-7579 batch of several transfers,
   each within the per-transfer cap. CallPolicy checks them one by one and
   never adds them up, no deployed and audited Kernel v3.3 hook restricts the
   execution mode (phase 11 item 1 found that ZeroDev's hooks implement the
   Kernel v3.0 hook interface and revert on v3.3), and the GasPolicy cannot
   bound the number of calls because the key holder chooses the declared fee.
   A dishonest key holder can therefore take up to the account's whole balance
   of the token in one operation. This was demonstrated against the real
   contracts: 10 USDC moved in one operation under a 5 USDC cap
   (`scripts/testnet/subscription-keeper.mjs --dry-run`, recorded in AGENTS.md
   phase 12 item 2). The only mitigation available today is to keep in the
   paying account no more than the user is willing to lose to that key holder,
   for example by paying from a separate smart account.
2. **The fee budget.** Every grant needs a total fee budget. It must cover the
   expected payments at realistic fees; when it runs out, payments stop until
   the user grants a new budget.

## 3. What can be scheduled honestly today

### 3.1 Payee-pulled subscriptions (built)

The merchant, or a keeper acting for it, holds the session key and decides
when to pull. The account enforces everything listed in section 2. This is
feature 69, proven live; it is listed here only because every other option
below reuses its grant shape.

### 3.2 User-pushed recurring payments (the design question)

"Pay X every period to Y" is the same grant with the roles changed: one
allowed call, `transfer(Y, amount)` on the token with the rules "recipient
equals Y" and "amount at most X" (or, for the native currency, a call to Y
with no function and a value cap of X), the rate limit at one operation per
period starting on the first due date, a validity window, the fee budget and
the SKIP_SIGNATURE flag. The engine already produces exactly this grant
(`subscriptionToGrant` in `kernel-subscription.ts`); a recurring payment is a
subscription whose "merchant" is the payee and whose key the user keeps.

Something must submit each payment, because an account cannot act by itself.
The three possible submitters, and what each can and cannot do:

| Submitter | Who holds the session key | What the holder can do | What the holder cannot do | Failure mode |
|---|---|---|---|---|
| The user's phone, when the app is open | The phone's secure storage (the same vault class as the recovery phrase) | Submit a due payment without a prompt; within the limits of section 2, including the batching limit | Pay anyone else, pay another token, exceed the per-transfer cap, act before a slot or after the end, sign messages as the account, install or remove modules | Payments are late while the app is not opened; the rate limit's catch-up then allows the missed ones at once |
| A keeper the user runs (a small script on a computer or server the user controls; `scripts/testnet/subscription-keeper.mjs` is a working prototype) | The keeper's key file | The same as the phone, unattended | The same as the phone | If the keeper's machine is compromised, the key holder can use the batching limit against the paying account until the grant is revoked |
| A third-party automation service | The service | The same as the phone, unattended | The same as the phone | The service sees the schedule and the payee; if it is dishonest or breached, the batching limit applies; if it stops, payments stop |

In every case the owner can revoke the grant at any time with one root-signed
operation (`permissionRevokeCall`), and in no case does the holder ever see the
recovery phrase or the owner key. The holder's power is the same in all three
rows; what differs is who must be trusted not to misuse the batching limit and
who must stay online.

A note on the simplest alternative: a payment **reminder**, in which the app
prepares the due payment and the owner approves it with the normal confirm and
biometric prompt, needs no session key and no account abstraction at all, and
works for every chain the wallet supports. It is not feature 25 (the payment
does not happen while the user is away), but it is a safe baseline and could
share the scheduling screens.

### 3.3 "Pay X every month to Y" pushed by a keeper

This is section 3.2 with the keeper as the submitter. The grant shape is
unchanged: transfer to Y only, at most X per transfer, one operation per 30
days (an interval in seconds; calendar months are not expressible), an end
date and a fee budget. The keeper submits on or after each due slot. Because a
missed slot can be caught up, a keeper that was down for two months may submit
two payments in a row; the account allows this by design, and the user should
know it. Because of the batching limit, a stolen keeper key can empty the
paying account of that token in one operation; the screen must say so before
anything else, as the subscription review already does.

## 4. Dollar-cost averaging (recurring swaps)

"Buy 50 USDC worth of ETH every Friday" needs a session key that may call a
swap. A CallPolicy rule reads a fixed 32-byte word of the calldata, so a swap
call can be pinned only when every argument the policy must check sits at a
fixed offset.

### 4.1 A call whose arguments can be pinned: SwapRouter02 `exactInputSingle`

Uniswap's SwapRouter02 interface (`Uniswap/swap-router-contracts` at commit
`70bc2e40dfca294c1cea9bf67a4036732ee54303`,
`contracts/interfaces/IV3SwapRouter.sol`) declares
`exactInputSingle(ExactInputSingleParams params)` with the struct fields
`tokenIn`, `tokenOut`, `fee` (uint24), `recipient`, `amountIn`,
`amountOutMinimum` and `sqrtPriceLimitX96` (uint160). Every field is
fixed-size, so the struct is encoded in place and the fields sit at offsets 0,
32, 64, 96, 128, 160 and 192 after the selector. A CallPolicy permission on
the router address and this selector could require:

- `tokenIn` equal to the token being sold (offset 0);
- `tokenOut` equal to the token being bought (offset 32);
- `fee` equal to, or one of, the pool fee tiers the user accepts (offset 64);
- `recipient` equal to the account itself (offset 96), so the bought tokens
  cannot be sent elsewhere;
- `amountIn` at most the per-period amount (offset 128), and greater than
  zero, because the interface comment says that an `amountIn` of zero makes
  the router swap its own balance;
- `amountOutMinimum` at least a fixed floor (offset 160);
- a value cap of zero on the call (the function is payable).

The account would also need to approve the router to spend the sold token,
either as a second allowed call (`approve(router, at most X)`) or as a
standing allowance, and both widen what the key holder can do.

What this cannot enforce:

- **A fair price.** The floor on `amountOutMinimum` is a fixed number of
  tokens written into the grant. The key holder chooses the actual minimum for
  each swap, and the policy only checks that it is at or above the floor. A
  dishonest or compromised holder can therefore swap at the floor price every
  period, and an honest holder's swap can still be pushed down to its own
  minimum by someone who trades just before and after it in the same block (a
  "sandwich"). The loss per swap is bounded by the difference between the fair
  price and the minimum used, and the floor cannot follow the market.
- **A deadline.** The SwapRouter02 struct has no deadline field; the router's
  deadline lives in a `multicall(uint256 deadline, bytes[] data)` wrapper,
  whose arguments are dynamic and cannot be pinned (section 4.2). An operation
  that waits in a mempool executes whenever it is included, at whatever price
  then holds, subject only to its minimum.
- **The batching limit.** One operation may batch several swaps, each within
  the cap.

Whether a UserOperation that carries a swap is visible to third parties before
inclusion depends on the bundler's mempool; this was not measured for the
bundlers the wallet uses.

### 4.2 Calls whose arguments cannot be pinned

- SwapRouter02's multi-hop `exactInput(ExactInputParams params)` carries the
  route as `bytes path` (same file), a dynamic argument.
- Uniswap's Universal Router takes
  `execute(bytes commands, bytes[] inputs, uint256 deadline)`
  (`Uniswap/universal-router` at `543e1a19d6e21e31ced2512eec5792b50f13a0ba`,
  `contracts/UniversalRouter.sol`), where each command's real arguments are
  ABI-encoded inside `inputs`.
- The 0x Swap API returns a ready transaction whose `to` and `data` come from
  the API for each quote (`packages/chains-evm/src/swap.ts`, from the 0x Swap
  API v2 allowance-holder documentation), so neither the target nor the
  calldata layout is known in advance.

A dynamic argument is located through an offset stored in the calldata. A
policy that checks a fixed byte position cannot tell whether the decoder will
read the argument from that position, because the caller writes the offsets.
This is reasoned from the ABI encoding rules and was not demonstrated in this
task; it is the reason no rule set for these calls is proposed.

### 4.3 On-chain price primitives that exist

- Every Uniswap v3 pool exposes a time-weighted price oracle,
  `observe(uint32[] secondsAgos)` (`Uniswap/v3-core` at
  `d0831dc6b8a318df3872b6d68f6de135c9f3ec29`, `contracts/UniswapV3Pool.sol`).
  A policy that compared a swap's minimum output with that oracle would remove
  the "fair price" gap above, but CallPolicy compares only fixed values, and no
  deployed, audited Kernel v3.3 policy that reads an oracle was found.
- CoW Protocol publishes a TWAP order type, `src/types/twap/TWAP.sol` in
  `cowprotocol/composable-cow` at `c0435953ac8312a606d66c91554f2bb4d22ec686`,
  which splits a sale into parts executed over time. Its README describes it as
  designed for a Safe whose fallback handler is set to CoW's
  `ExtensibleFallbackHandler`, and lists an audit of `ComposableCoW` and
  `ExtensibleFallbackHandler` by Ackee Blockchain. Using it from a Kernel
  account would need an ERC-1271 route to `ComposableCoW` that this wallet does
  not have; it was not evaluated further.

### 4.4 Conclusion on recurring swaps

With the deployed modules, a recurring swap can be limited in what it trades,
how much, how often, and where the output goes, but not in the price it
accepts beyond a fixed floor. Offering "buy every Friday" on that basis would
present a custodial-grade promise ("we buy at the market price") that the
account does not enforce. It should wait for an audited policy that checks the
price against an on-chain oracle, or for a protocol-level order type (such as a
TWAP order) that the account can sign safely.

## 5. Recommendation

### 5.1 The smallest slice worth building next

**User-pushed recurring payment, submitted by the phone.**

- Scope: the native currency and USDC on the test networks, one payee per
  grant, a fixed amount per period, a period of at least one day, an end date,
  and a mandatory fee budget, with the install fee kept back from the
  balance as the subscription form already does.
- Grant: exactly the engine's subscription grant
  (`subscriptionToGrant`), with the payee as the "merchant". No engine change
  is needed.
- Submission: when the app is opened and a payment is due, the app shows it
  and submits it with the session key alone (no owner prompt), then records the
  result. Missed payments are listed, and the app explains that the account
  will allow them to be caught up.
- Key: generated on the device and kept in the same secure-storage vault as
  other session keys; never shown, never exported in this slice.
- Copy: the batching limit stated first, as on the subscription review; the
  statement that payments happen only while the app is opened; revocation one
  tap away.
- Proof: a live Sepolia run in which the phone pays three periods compressed
  to minutes, an early payment and an over-cap payment are refused on-chain,
  and revocation ends the schedule — the same checks as the subscription run.

The second step, after the first is proven, is an "export to my own keeper"
option that hands the key to `subscription-keeper.mjs`-style software the user
runs, with the same warnings as the subscription key hand-over.

This slice touches `app/src/wallet/subscriptions.ts`, `app/src/wallet/sessions.ts`
and `app/src/screens/SessionsScreen.tsx`, which belong to other work in this
phase, so it is described here for a later wave and not built now. It needs
no new engine code, no new contract and no new dependency.

### 5.2 What must not be built

- Recurring swaps through an aggregator, through Uniswap's Universal Router or
  through any call whose route is a dynamic argument (section 4.2).
- A recurring swap of any kind whose only price protection is a fixed floor,
  presented as "buying at the market price" (section 4.1).
- A keeper or automation service that holds the owner key or the recovery
  phrase. Only a session key with the policies in section 2 may be delegated.
- A scheduled payment without the GasPolicy fee budget.
- Any wording that calls the per-transfer cap a "budget" or a "spending
  limit": with batching, it is neither (section 2.1).

## 6. Open questions

- Whether the bundlers the wallet uses expose pending UserOperations publicly,
  which decides how visible a scheduled swap would be before inclusion.
- Whether ZeroDev or another vendor will ship an audited Kernel v3.3 hook that
  forbids batch execution, which would close the batching limit for every
  scheduled payment at once.
- Whether an oracle-checking policy or a Kernel-compatible TWAP order type
  appears in audited, deployed form, which is the precondition for recurring
  swaps.
