# TROPIC01 and Shiba Wallet: Stage 1 research

Phase 23 item 10, Stage 1 (research only; no code). Written 2026-10-25 for the
Chairperson and for engineers. Every statement about the chip, its software or
its boards is taken from a primary source fetched on 2026-10-25 and listed in
section 8; where a fact was not found in those sources, the text says
"not found in the sources read". Nothing about the Chairperson's own hardware
is assumed: every such point is a question in section 1. No one has touched the
Chairperson's chips, boards or network for this document.

## Summary

- **TROPIC01 cannot sign an Ethereum transaction.** Its signing engine offers
  ECDSA on NIST P-256 (secp256r1) and EdDSA on Ed25519 only, plus X25519 for
  its own secure channel. secp256k1, the curve every Ethereum account key and
  every signature this wallet verifies with `ecrecover` uses, is not offered by
  the datasheet, the user API, the application firmware or the website
  (section 2.4).
- **What it can do for this wallet** falls into two families:
  1. *Protect a secp256k1 key that lives on the host.* The chip's
     MAC-and-Destroy PIN engine can release a 32-byte secret only after a
     correct PIN, with a hard limit of wrong guesses enforced inside the chip,
     so a key encrypted under that secret cannot be copied off a stolen
     Raspberry Pi's SD card and tried offline. Tropic Square's own sample
     application derives a BIP-32 secp256k1 master key from a recovery phrase
     and seals it this way (section 2.7). The key is still used in the
     Raspberry Pi's memory once released.
  2. *Hold a P-256 key that never leaves the chip.* The smart-account
     validator the wallet already pins for passkeys (Kernel WebAuthnValidator
     v0.0.3) accepts any P-256 ECDSA signature presented in the WebAuthn
     envelope; it does not check the origin, the relying-party hash or a
     counter, so a host that builds the envelope and asks the chip for the
     signature can produce an accepted signature (section 2.5). Such a key is
     an additional, independent owner of the smart account, not a second
     factor that must also approve.
- **Ranked candidate roles** (section 4): (1) an air-gapped signer on the
  Raspberry Pi whose secp256k1 key is sealed by MAC-and-Destroy, speaking the
  wallet's existing cold-signing QR format for a watch-only account or the
  existing multisig co-signer approval format; (2) a P-256 owner of the smart
  account through the WebAuthn validator; (3) a second factor for the app lock;
  (4) a direct multisig co-signer (not possible on the chip; only through role
  1); (5) a hardware-bound records backup (little value).
- **The board is a developer board.** The Raspberry Pi shield has no display
  and no buttons on the chip side; whatever the Raspberry Pi shows on its own
  screen and accepts from its own input is what a user would trust. A product
  would need its own device (section 7).

## 1. Open questions

### 1.1 For the Chairperson (only you know these)

Nothing below is assumed in this document. The answers decide what the Stage 2
design may use and what a Stage 3 demo may touch.

1. **The Raspberry Pi.** Which model exactly (the plan says "believed a 3B+")?
   Which operating system and version? libtropic's Linux SPI port lists Raspberry
   Pi 4 and Raspberry Pi 5 as tested (section 3.1); a 3B+ is not listed.
2. **The board.** Which Tropic Square board is fitted: the TROPIC01 Raspberry Pi
   Shield (hardware revision TS1501 is the only one listed), or another? Is the
   CS2 jumper fitted as the tutorial asks?
3. **The chip's part number** (for example TR01-C2P-T301; it is printed in the
   chip identification output and encoded in the package marking) and the
   **firmware versions** it reported (application firmware, SPECT firmware,
   bootloader). Did you save the output of the chip-identification example, as
   Tropic Square recommends doing before anything else?
4. **Firmware updates.** Have you updated either firmware? To which versions?
5. **libtropic.** Which version (a release tag, or a commit), and which program
   did you run: one of libtropic's examples, `libtropic-util` (`lt-util`), the
   Python `tropic01_util` (written for the USB DevKit, not the Raspberry Pi
   shield), or your own code? Neither the Linux SPI examples nor `lt-util`
   contain a MAC-and-Destroy command (sections 2.7 and 3.1), so the earlier
   PIN run must have used something else.
6. **Pairing keys.** Which pairing-key slot did you open sessions with? Is slot 0
   still valid (its private key is published in libtropic, so anyone with
   access to the SPI bus can open a session while it is valid), and have you
   written your own key into slot 1, 2 or 3? Writing and invalidating pairing
   keys cannot be undone (section 2.3). Where is your own pairing private key
   stored today?
7. **Configuration.** Have you written any I-Config (irreversible) or R-Config
   object? An erratum published 2026-01-08 is titled "R-Config write triggers
   permanent Alarm Mode" (section 2.14).
8. **State of the chip.** Which ECC key slots (0–31), User Data slots (0–511),
   MAC-and-Destroy slots (0–127) and monotonic counters (0–15) hold something
   you want to keep? A MAC-and-Destroy call on a slot used by your earlier PIN
   set-up would destroy that slot's state.
9. **The earlier MAC-and-Destroy run.** How many attempt slots did you set up,
   what did the released key protect, and where were the host-side ciphertexts
   and tag stored (the Raspberry Pi's SD card, or a User Data slot on the
   chip)?
10. **The spare chip.** Is it in the same state as delivered (never powered, or
    never written)? Which board is it on, if any? This document proposes nothing
    that touches it.
11. **Peripherals and connectivity of the Raspberry Pi.** Does it have a screen,
    a camera, a keyboard? Is it on your home network, on Wi-Fi, or kept
    offline? Would you accept it being network-connected for a demo, or should
    every exchange with the phone be by QR code only?
12. **Ownership intent.** For a demo, is the chip a lab instrument (we may
    generate and erase keys freely in agreed slots) or the seed of a product
    (we must never change its pairing or configuration)?
13. **The product question.** Is the goal (a) a demonstration that the wallet
    can work with a separate hardware signer, (b) a design that could later
    become a Shiba-branded device, or (c) integration with existing hardware
    wallets? Section 7 differs for each.
14. **Mainnet.** Should any role in section 4 be considered for mainnet, or test
    networks only (as for every smart-account feature today)?

### 1.2 For Tropic Square's documents (what the sources read do not say)

1. Is secp256k1 on any roadmap, or available through custom SPECT firmware
   signed by Tropic Square? The custom-firmware route needs a chip batch with a
   customer vendor key (section 2.11); nothing says whether the SPECT engine's
   arithmetic could be extended to secp256k1. Not found in the sources read.
2. Does the chip ever return a "high-s" ECDSA signature? No low-s normalization
   was found in the SPECT signing routine; the wallet's validator rejects high
   s, so the host must normalize (section 2.5).
3. Is there any signed attestation that an ECC key in a slot was generated on
   the chip? `ECC_Key_Read` returns an ORIGIN field over the secure channel, but
   a signed statement binding a key to the chip was not found in the sources
   read.
4. Can the secure channel be relayed: may the libtropic host run on one machine
   while a second machine forwards the raw SPI traffic (as libtropic's TCP port
   does for the software model)? Are there chip-side timeouts that a network
   relay would break? Not found in the sources read.
5. Does a Raspberry Pi 3B+ work with the shield and libtropic's Linux SPI port?
   Only Raspberry Pi 4 and 5 are listed as tested.
6. Which hardware revisions and firmware versions do the six public security
   reports cover, and is any formal certification (for example Common
   Criteria) planned? Not found in the sources read.
7. The content of each erratum (the Atlassian pages were not read; only their
   titles on the part-number page were).
8. Is the MAC-and-Destroy engine's behaviour on a power loss during a call
   documented (whether a slot can be left half-written)? Not found in the
   sources read.
9. libtropic's documentation says the TROPIC01 Model runs on Linux only, with
   macOS "TBA". Is there a supported way to run it on macOS?

## 2. The chip as the sources describe it

Short source labels used below are defined in section 8. Datasheet page numbers
are the printed page numbers (they equal the PDF page numbers). User API page
numbers are the printed numbers (one less than the PDF page).

### 2.1 Family and variants

- TROPIC01 is "an auditable secure element built around a RISC-V core and a
  custom cryptographic coprocessor named SPECT" [T01 README.md]. The datasheet
  calls it "A Cryptographic Coprocessor and Secure Storage IC" [DS p.1].
- Part numbers encode silicon revision, package, production or sample status,
  vendor key, factory configuration and API compatibility [CAT §1]. Released
  part numbers: TR01-B2S-T005, TR01-C2P-T101, -T103, -T202, -T301, -T310
  [CAT §2]; the GitHub part-number page marks TR01-C2P-T301 "recommended for
  new designs" and the others deprecated (T310 is not on that page) [T01
  doc/pages/part-numbers.md lines 11–17]. Silicon revisions: ABAA and ABAB are
  pre-production samples (bootloader 1.0.1), ACAB is the production device
  (bootloader 2.0.1) [CAT §1]. Pre-production samples outside the scheme "are
  not supported" [CAT §2].
- The behaviour of a chip is defined by its (updatable) firmware versions and
  its (permanent) factory provisioning, both recorded in the part number [T01
  doc/pages/part-numbers.md lines 3–8]. The newest firmware listed on that page
  is application firmware 2.1.0 with datasheet A.11 and User API 1.4.0 [lines
  26–29]; libtropic 4.2.0's changelog adds update files for application
  firmware 2.2.0 [LT CHANGELOG.md, "4.2.0"].

### 2.2 Host interface

- 4-wire SPI slave, CPOL = 0 and CPHA = 0, byte-oriented, most significant bit
  first; the chip answers each transfer's first byte with a CHIP_STATUS byte
  [DS §7.3.2 p.25, Table 7].
- Three protocol layers: L1 physical (SPI), L2 data link (not encrypted; used
  for information requests and to set up L3), L3 secure session (encrypted;
  needs an established secure channel) [DS Table 6 p.25].
- Supply 3.0–3.6 V (3.3 V typical) [DS §9.1 p.57]. Minimum SPI clock period
  37 ns [DS §9.4 p.59]; libtropic's Raspberry Pi examples use 5 MHz [LT
  examples/linux/spi/hello_world/main.c line 92].

### 2.3 Secure channel and pairing keys

- L3 traffic is protected by a session set up with a Noise handshake named
  `Noise_KK1_25519_AESGCM_SHA256`, using X25519, SHA-256, HKDF and AES-256-GCM
  [DS §7.4.1 pp.39–41]. The datasheet states that the design prevents a
  man-in-the-middle from observing or altering the plaintext [DS §5.3 p.9].
- The chip holds up to **4 pairing-key slots**, each storing a host's X25519
  public key; establishing a session with slot *i* proves to the chip that the
  host owns the matching private key, and proves to the host that the chip owns
  the private key whose public key is in Tropic Square's X.509 certificate
  [DS §5.2 p.9; Table 5 p.22].
- **Factory key.** Tropic Square writes a public key into slot 0 at
  manufacturing and "provides SH0PRIV to TROPIC01 customers" [DS §5.4 p.10].
  For the default option, "The private Pairing Key is publicly available in
  the TROPIC01 SDK – Libtropic" [AN005 §2.1]; libtropic ships the production
  key pair as `lt_sh0priv_prod0` / `lt_sh0pub_prod0` and the engineering-sample
  pair separately [LT docs/reference/default_pairing_keys.md lines 9–13;
  include/libtropic_common.h lines 105–123]. Tropic Square's warning: customers
  "shall only use the Secure Channel on the first Pairing Key slot to store
  their own generated Pairing Key to the next slot. Then customers shall
  invalidate the first Pairing Key" [AN005 §2.1]. A customer-specific first
  pairing key is available by agreement with Tropic Square, under a custom part
  number [AN005 §2.2].
- **States and irreversibility.** A slot is Blank, Valid or Invalidated; a
  write to a Valid or Invalidated slot fails; invalidation "is impossible to
  change"; "When all Pairing Key slots are Invalidated, Secure Channel Sessions
  cannot be established and TROPIC01 is unusable" [DS §7.5.3 p.44]. Each slot
  can be written only once [AN005 §1.2].
- **What happens when a pairing private key is lost:** the slot can no longer
  be used by anyone; the chip remains usable only through another Valid slot
  (inferred from the two statements above; the sources do not describe a
  recovery procedure, and none exists if every Valid slot's private key is
  lost).
- **User access privileges** restrict each L3 command per pairing-key slot,
  reversibly (R-Config) or irreversibly (I-Config); the effective setting is
  the bitwise AND of the two [DS §7.2 p.23, §7.5 pp.42–43, Table 17]. A
  configuration change applies from the next power cycle [DS §7.2 p.23].
- **What the secure channel does not protect:** the host itself. Whoever holds
  a valid pairing private key and can reach the SPI bus can issue every command
  that slot is allowed to issue. The chip has no display or button of its own
  (its pins are power, ground, the four SPI lines and one general-purpose
  output, GPO [DS §3 Table 1 p.6]).

### 2.4 Cryptographic operations and curves (the decisive fact)

- "All ECC operations are supported on the following Elliptic Curves: ECDSA –
  NIST Curve P-256 (secp256r1); EdDSA – Curve Ed25519" [DS §7.7 p.47]. The
  front page lists "P-256 (ECDSA) and Ed25519 (EdDSA) curve support" [DS p.1];
  the security-domain table lists P-256, Curve25519 and Ed25519 [DS Table 2
  p.8]; the ECC engine has "Arithmetics for P-256, Ed25519 and Curve25519"
  [DS §8.1.3 p.56].
- The User API's CURVE field has exactly two values, `P256 (0x01)` and
  `ED25519 (0x02)` [API Tables 28–30, pp.36–38]; the application firmware's L3
  API header defines the same two and no other [APP main/api/tropic01_l3_api.h
  lines 388–389, 415–416, 442–443].
- Tropic Square's product page lists "Diffie-Helman X25519 key exchange,"
  "Ed25519 EdDSA signing," and "P-256 ECDSA signing" and does not mention
  secp256k1 [WEB tropicsquare.com/tropic01].
- **secp256k1 is not offered.** The only occurrences of "secp256k1" in the
  Tropic Square repositories read are in host-side code: the Python
  `tropic01_util` derives a BIP-32 secp256k1 key on the PC [LT
  examples/applications/tropic01_util/tropic01_util_app/commands/pin_set.py
  lines 12–23], and some ESP32 test configurations enable the host's mbedTLS
  curve. **Consequence: the chip cannot produce an Ethereum transaction
  signature, a Kernel ECDSA-validator signature, or a WeightedECDSAValidator
  approval.**
- **ECDSA_Sign** takes a 32-byte hash computed by the host ("the 256 left-most
  bits of the calculated hash result in the MSG_HASH field") and returns (r, s)
  [DS §7.7.4 p.49; API Table 32 p.41]. libtropic since 4.0.0 passes a 32-byte
  hash ("provided data are not hashed anymore") [LT CHANGELOG.md "4.0.0"]; in
  3.2.1 the library computed SHA-256 of the message on the host before sending
  [LT v3.2.1 src/libtropic_l3.c lines 1215–1235]. The nonce is
  `k = TMAC[512](w, h || n || z, 0xB)` with the session hash *h* and nonce *n*
  as inputs [DS Fig. 19 p.50; SPECT src/ecc_crypto/ecdsa_sign.s lines 42–47],
  so signatures differ between sessions (not RFC 6979). The routine verifies
  its own signature before returning it [SPECT ecdsa_sign.s lines 171–193].
- **EdDSA_Sign** signs messages up to 4,096 bytes [DS §7.7.5 p.50; API Table 33
  p.42].
- Other primitives: SHA-256, SHA-512, AES-GCM (secure channel), Keccak-based
  TMAC, ISAP flash encryption [DS p.1, Table 2 p.8, §5.7.3 p.13].

### 2.5 P-256 and the wallet's own WebAuthn validator

The wallet already pins ZeroDev's WebAuthnValidator v0.0.3
(`0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69`) for passkeys
(`packages/chains-evm/src/kernel-webauthn.ts`). From that file's header,
recorded from the validator's verified source:

- The signature is `abi.encode(bytes authenticatorData, string clientDataJSON,
  uint256 responseTypeLocation, uint256 r, uint256 s, bool usePrecompiled)`;
  the signed message is `sha256(authenticatorData || sha256(clientDataJSON))`;
  the challenge is the raw 32-byte userOpHash, base64url without padding, at a
  fixed offset, so clientDataJSON must begin exactly with
  `{"type":"webauthn.get","challenge":"`; the UP (0x01) and UV (0x04) flags
  must be set; s must be at most n/2 (kernel-webauthn.ts lines 75–93).
- "The origin, rpIdHash, signature counter and backup state are NOT checked
  on-chain" (line 94).
- One key per account per validator contract (line 73); the key is an
  ADDITIONAL validator with the `execute` selector, and a stolen key could call
  `changeRootValidator` — the wallet refuses passkey self-calls only in its
  own client (lines 116–131).
- v0.0.3 is treated as unaudited for mainnet (line 113; AUDIT_SCOPE.md C1).
- P-256 verification uses the RIP-7212 / EIP-7951 precompile at `0x100` where
  present, else Daimo's verifier (lines 57–67, 91–93). The record reports the
  precompile on Ethereum Sepolia and mainnet (`docs/HISTORY.md` phase 8), Base
  Sepolia (`docs/HISTORY.md`, the Base profile entry), Arbitrum Sepolia, OP
  Sepolia and Hoodi (`AGENTS.md` phase 14 and 18 entries); the validator's code
  is recorded byte-identical on Sepolia and OP Sepolia, and a module-by-module
  check on Base and Arbitrum Sepolia is not recorded (`docs/AUDIT_SCOPE.md`
  lines 253 and 259). Hoodi has no Kernel stack at all.

**Can a raw TROPIC01 P-256 signature satisfy this validator?** Reasoned from the
two sources, not tested:

- The validator needs an ECDSA P-256 signature over a 32-byte digest it
  recomputes. The host can build `authenticatorData` (at least 37 bytes, flags
  UP and UV set) and `clientDataJSON` (the exact prefix with the challenge),
  compute the digest, and pass it to `ECDSA_Sign` as MSG_HASH (libtropic 4.x),
  or pass `authenticatorData || sha256(clientDataJSON)` as the message to
  libtropic 3.x, which hashes it with SHA-256 on the host. Either yields a
  signature over the same digest the validator verifies.
- The host must normalize s to the low half; no normalization was found in the
  chip's signing routine (SPECT ecdsa_sign.s lines 139–169), and the engine's
  `normalizeP256LowS` already does it (kernel-webauthn.ts lines 335–338). The
  engine's `WebAuthnAssertion` type expects a DER signature (lines 271–280), so
  the chip's raw r‖s would need DER encoding or a small adapter; the engine's
  `checkWebAuthnAssertion` then verifies it locally before anything is
  submitted (lines 374–419).
- **Honest caveat:** the UP and UV flags would be bytes the host writes. They
  would not prove that a person was present or verified; any such proof would
  come only from what the host software does before it asks the chip to sign.

### 2.6 Key slots

- **32 ECC key slots** (0–31), each holding one key pair; only the public part
  can be read [DS §7.7.1 p.47; Table 4 p.21; API Tables 28–31]. A key can be
  generated on the chip (`ECC_Key_Generate`, using TRNG1) or imported from the
  host (`ECC_Key_Store`); `ECC_Key_Read` reports which (ORIGIN) [DS §7.7.1,
  §7.7.3 pp.47–49; API Table 30]. Private keys are masked with a 256-bit TRNG
  mask and encrypted before being written; "The private part never occurs in
  the chip in a raw form again" [DS §7.7.1 p.47].
- A slot that already holds a key refuses a new one until erased with
  `ECC_Key_Erase` [DS §7.7.1 p.47].
- The ownership use case in the datasheet shows an OEM restricting
  key generation, storage and erasure for chosen slots so an end customer can
  sign but not change keys [DS §7.5.4 pp.44–45].

### 2.7 The PIN engine ("MAC-and-Destroy")

From the PIN Verification Application Note v1.2 [AN002] and the datasheet:

- **Purpose:** "to release a high-entropy cryptographic key k based on a
  potentially low-entropy PIN entered by the user" [AN002 §1].
- **The chip's part** is one command, `MAC_And_Destroy(slot, DATA_IN)`, which
  returns 32 bytes [API Table 37 p.46]. Inside the chip, two Keccak-based
  KMAC256 cores keyed from the chip's own OTP + PUF key source read the slot's
  old value V1, compute and **store** a new value V2 = F1(v_in‖i), then output
  F2(V1‖V2‖i) [AN002 Appendix A]. Reading a slot's old value and overwriting
  it happen in one call; there is no comparison or branch to skip [AN002 §1,
  Appendix B, C].
- **The host's part** (the full scheme): at set-up the host picks a 32-byte
  master secret s (or is given one: "Optionally, the master secret s can be
  provided as an input"), initializes n slots, and stores in ordinary,
  unprotected memory one ciphertext of s per slot, a tag and an attempt
  counter; the released key is k = KDF(s, 0x02) [AN002 §3.3–§3.4]. A PIN check
  uses the next slot: a wrong PIN leaves that slot destroyed; a right PIN
  decrypts s, checks the tag, re-initializes the destroyed slots and releases k
  [AN002 §3.5].
- **How many tries:** n, the number of slots set up; "TROPIC01 supports up to
  128 slots" [AN002 §3.3]; libtropic defines `TR01_MACANDD_ROUNDS_MAX 128` [LT
  include/libtropic_common.h line 1002]. The limit holds against a
  compromised host because each guess consumes a slot inside the chip, and only
  someone who knows s can re-initialize a slot [AN002 §3.5.1 last paragraph,
  Appendix B].
- **What is destroyed:** the slot's value. Once every slot has been consumed by
  wrong PINs, the stored ciphertexts can no longer be decrypted and k is gone
  — unless s exists somewhere else (for example, if s was derived from a
  recovery phrase the user still holds) [AN002 §3.1, §3.5.1].
- **Threat model and its limits (Tropic Square's own):** the internal key source
  is assumed unreadable; an attacker able both to read and to write the flash
  arbitrarily "would be able to achieve unlimited PIN entry attempts", which is
  assumed to need "non-negligible effort" [AN002 Appendix B]. The PIN is mixed
  in twice so that even a rigged chip cannot weaken a high-entropy PIN [AN002
  Appendix C].
- **Extensions:** several PINs for one key, and a **Wiping PIN** that destroys k
  when entered [AN002 §3.6–§3.7] — directly relevant to the wallet's duress
  design (`docs/DURESS_WALLET.md`).
- **Libraries:** libtropic implements only the single command
  (`lt_mac_and_destroy`); the full scheme is example code: "As the overall
  scheme is implemented by the host MCU, we avoid to provide official support"
  [AN002 §4]. Examples: `examples/model/mac_and_destroy/main.c` (for the
  software model; it keeps its host data in User Data slot 511, lines 30 and
  59) and the USB DevKit firmware of `tropic01_util`, which uses XOR as the
  cipher with the comment "In production, replace it with some encryption
  standard!" [LT examples/applications/tropic01_util/firmware/Src/app_cmd/
  pin_set.c lines 113–115]. No MAC-and-Destroy example exists for the Linux SPI
  port [LT examples/linux/spi: four examples, none for PIN].
- **Cost:** `MAC_And_Destroy` takes about 28 ms [DS §9.3 p.58]; flash
  endurance is 100,000 reprogram cycles with 10-year retention [DS §9.6 p.61].
  A set-up of n slots makes 3n calls (AN002 §3.4 steps 6.1, 6.2, 6.5).

### 2.8 Monotonic counters

16 counters of 32 bits, initialized to a chosen value and decremented by one
per update until 0, after which updates fail; non-volatile; "Protection
against glitching attacks" [DS §7.10 pp.52–53; API Tables 34–36].

### 2.9 User data memory

512 User Data slots; datasheet A.11 says "Each R-Memory slot offers 475 Bytes"
[DS §7.6 p.46] (application firmware 2.0.0 raised it from 444 bytes [T01
part-numbers.md line 29]; the datasheet's own example adds up to 476, a small
inconsistency). Contents are encrypted with a per-chip ISAP key derived from the
PUF [DS §5.7.3 p.13]. A slot must be erased before it is written again [DS §7.6
p.46]. The front page gives "237 KiB for general purpose data" [DS p.1].

### 2.10 Random number generation

Two TRNGs: TRNG1 for the chip's own engines, TRNG2 for the host; "NIST800-90b,
AIS31 compliant", "Up to 128 KiBit/s" [DS p.1, §7.12 p.54]. One
`Random_Value_Get` returns 0–255 bytes [API Table 27 p.35].

### 2.11 Firmware update and custom firmware

- The bootloader is in ROM and holds Tropic Square's bootloader public key; a
  vendor public key in OTP memory, signed by the bootloader key, verifies every
  CPU and SPECT firmware image (EdDSA signatures) [AN007 §2; DS §8.1.1 p.55].
  Firmware is not encrypted, so anyone can compare a signed binary with the
  published source [AN007 §2 note].
- Custom firmware is possible only on chips manufactured with the customer's
  own vendor public key ("Alternative Scenario"); such chips get their own part
  number [AN007 §4]. On a chip with Tropic Square's vendor key, only Tropic
  Square-signed firmware runs.
- On silicon ACAB the update procedure in AN007 applies; older silicon (ABAB
  and earlier) "have a different firmware update API and e.g. allow a
  downgrade" [AN007 §1 warning].
- libtropic's README says the SDK, bootloader, application and SPECT firmware
  versions must be compatible, with a table [LT README.md "Firmware
  compatibility"].

### 2.12 Attestation

- The chip carries a certificate chain (device certificate, an intermediate,
  Tropic01 CA, Tropic Square Root CA); the device certificate holds the chip's
  X25519 static public key, and the host "shall verify the certificate chain
  before using" it [DS §7.8 p.51; §5.1 p.8]. A successful handshake then proves
  the chip is the holder of that key [DS §5.2 p.9].
- A signed statement that a particular ECC key was generated inside the chip
  was not found in the sources read (only the ORIGIN field returned over the
  secure channel, section 2.6).

### 2.13 Timing

Handshake about 163 ms; P-256 key generation about 79 ms; ECDSA_Sign about
199 ms; EDDSA_Sign (100-byte message) about 96 ms; MAC_And_Destroy about 28 ms;
start-up 225 ms [DS §9.3 p.58].

### 2.14 Openness, licences, evaluations, advisories, errata

- **Open:** the RTL, the application firmware, the internal SDK, the SPECT
  compiler and firmware are on GitHub; the bootloader "cannot be opened due to
  legal issues with silicon IP providers" [T01 README.md]; analog blocks and
  layout are not public [DS §5.6 p.12].
- **Licences:** libtropic and the SPECT firmware: The Clear BSD License, which
  states "NO EXPRESS OR IMPLIED LICENSES TO ANY PARTY'S PATENT RIGHTS ARE
  GRANTED BY THIS LICENSE" [LT LICENSE.md; SPECT LICENSE]; `libtropic-util`:
  BSD 3-Clause [UTIL LICENSE]; the datasheet: "No license is implicitly or
  otherwise granted to any Tropic Square patents" [DS p.1]. The GitHub API
  reports no licence for the `tropic01` documentation repository and the shield
  repositories [repository list, 2026-10-25].
- **Evaluations:** six public reports — PUF and TRNG (by Tropic Square), ISAP and
  AES-GCM side channels (Security Pattern), decapsulation (FEE UWB Pilsen), and
  fault injection (KU Leuven COSIC) [T01 doc/pages/security-reports.md]. The
  KU Leuven summary: sensors "generally active and effective", but "faults could
  be injected without triggering any sensor" and a laser fault attack on the
  SPECT EdDSA signature verification that protects secure boot was
  demonstrated; Tropic Square released a firmware fix for the voltage monitor
  and is hardening the ROM bootloaders in future silicon [FI pp.1–2].
- **Advisory** ODR_TR01_SA_2026012900 (2026-06-03, reported by Ledger's Donjon):
  laser fault injection may bypass firmware verification on all production part
  numbers; CVSS 3.1 5.7 MEDIUM; needs desoldering, decapsulation, equipment
  above €30,000 and an expert for 3–4 weeks; "All confidential data in
  TROPIC01 might be compromised by a challenging combined attack"; a silicon
  update is in development [SA pp.2–4].
- **Formal certification** (Common Criteria or similar): not found in the
  sources read.
- **Errata** listed for TR01-C2P-T301 include "Nonce endianity of Noise
  Protocol", "L3 commands R_Mem_Data_Write/Read limited to 444B", "Verification
  of Memory writes", "R-Config write triggers permanent Alarm Mode" and "Voltage
  monitor not enabled during Immutable FW operation" [T01
  doc/pages/parts/TR01-C2P-T301.md]. Only the titles were read.
- **Hardware wallets:** Tropic Square names hardware wallets as an application
  and Trezor Safe 7 as an example [WEB tropicsquare.com/tropic01]; Trezor says
  TROPIC01 "works together with an NDA-free EAL6+ Secure Element (Optiga) and a
  security-hardened STM32U5 microcontroller" in the Safe 7 [TRZ safe-7]. How
  the Safe 7 uses TROPIC01 is not described on the pages read.

## 3. The host side

### 3.1 libtropic and the Raspberry Pi

- **libtropic** is "the official C SDK for TROPIC01" [LT README.md]; latest tag
  read v4.2.0 (master at commit 9085ea5387a8, 2026-10-02). Its public API is a
  flat set of C functions that mirror the chip's commands — `lt_init`,
  `lt_session_start`, `lt_verify_chip_and_start_secure_session`,
  `lt_ecc_key_generate`, `lt_ecc_ecdsa_sign`, `lt_mac_and_destroy`,
  `lt_r_mem_data_write`, `lt_random_value_get`, `lt_mcounter_*`,
  `lt_pairing_key_write`, `lt_pairing_key_invalidate`, `lt_i_config_write`,
  `lt_do_mutable_fw_update` and others [LT include/libtropic.h lines 42–829].
  Host cryptography comes from a chosen provider: mbedTLS, wolfCrypt,
  trezor-crypto or OpenSSL [LT docs/compatibility/cfps/].
- **Other SDKs** exist in Rust (`libtropic-rs`) and Go (`libtropic-go`) [GitHub
  repository list]; no JavaScript or TypeScript implementation was found, and
  no Python binding to libtropic was found (the Python code found is the
  software model `ts-tvl` and the USB DevKit CLI `tropic01_util`).
- **Raspberry Pi port:** the Linux port uses the kernel's spidev and GPIO
  character-device interfaces and "was tested on: Raspberry Pi 4, Raspberry
  Pi 5" [LT docs/compatibility/host_platforms/linux.md lines 11–15]. The
  tutorial uses a Raspberry Pi 4 with the shield, says to "short the CS2 pins
  with a jumper", to enable SPI with raspi-config, and to join the `spi` and
  `gpio` groups [LT docs/tutorials/linux/spi/index.md lines 4–53]. Defaults:
  `/dev/spidev0.0`, `/dev/gpiochip0`, chip select on GPIO 25, interrupt on
  GPIO 5 [LT examples/linux/spi/fw_update/CMakeLists.txt lines 24–30;
  hello_world/main.c lines 92–95]. Wiring: MOSI GPIO10, MISO GPIO9, CLK
  GPIO11, CS GPIO25 [UTIL docs/Linux_SPI.md lines 10–33].
- **The shield** (TS15, hardware revision TS1501) "connect[s] the TROPIC01 device
  to a Raspberry Pi via the standard 40-pin GPIO header" and is "intended for
  development, evaluation, and prototyping use" [SHIELD README.md].
- **`lt-util`** is a command-line tool for the shield with random, ECC key
  install / generate / download / clear / sign and memory store / read / erase
  commands, "not intended for production use", and no PIN command [UTIL
  README.md; docs/Linux_SPI.md lines 55–74].
- **The software model.** The TROPIC01 Model (from `ts-tvl`) runs on a
  computer; libtropic talks to it over TCP at 127.0.0.1:28992 with the same API,
  and "The model responses match those of the physical TROPIC01 chip"; Linux
  only, macOS "TBA" [LT docs/tutorials/model/index.md lines 4–5, 60–63]. Tropic
  Square recommends starting with it [T01 doc/pages/FAQ.md lines 9–11]. The
  TCP port uses `rand()` with a known seed for host randomness, so it is for
  the model only [LT docs/compatibility/host_platforms/posix.md lines 12–16].

### 3.2 What a Raspberry Pi can expose to a phone in this wallet's world

The chip's secure channel runs between the chip and its **host** (the
Raspberry Pi). The phone never talks to the chip directly in any design below;
it talks to the Raspberry Pi.

1. **QR codes (zero connectivity).** The wallet already has two QR formats a
   Raspberry Pi signer could answer:
   - The **cold-signing format** for a watch-only account (phase 22 item 3,
     commit 0b2d516; proven live in pass p22b): a request
     `shiba-wallet/cold-sign-request` carrying an EIP-1559 transaction and its
     signing hash, split into `SW-CS:n/total:` parts; the signature payload
     `shiba-wallet/cold-sign-signature` with yParity, r, s; the phone checks the
     request id, recomputes the hash, enforces low s (EIP-2) and recovers the
     signer with `ecrecover` before broadcasting
     (`app/src/wallet/cold-signing.ts` lines 71–93, 592–641). This needs a
     **secp256k1** signature, so the chip cannot answer it; a secp256k1 key held
     by the Raspberry Pi can (section 4, role a).
   - The **multisig co-signer approval** (phases 17 and 19): the co-signer signs
     the WeightedECDSAValidator's EIP-712 approval digest; the wallet accepts a
     bare 65-byte signature from another wallet (`AGENTS.md` phase 19 item 1).
     Also secp256k1 (`ecrecover` in the validator, `AGENTS.md` phase 19: kernel
     cd697c7e WeightedECDSAValidator.sol 215–220).
   A Raspberry Pi needs a screen to show QR codes and a camera to read them;
   whether the Chairperson's has either is question 1.1.11.
2. **A local network service.** The Raspberry Pi could serve requests over the
   home network. This needs its own authentication and encryption between phone
   and Raspberry Pi (the chip's secure channel does not cover that link), and it
   makes the signer an online device. For the emulator: Android's documentation
   gives `10.0.2.2` as "Special alias to your host loopback interface (127.0.0.1
   on your development machine)", and says that before emulator version 36.5
   each instance "runs behind a virtual router or firewall service that isolates
   it from your development machine network interfaces" [AND
   emulator-networking-address]. Whether the emulator in use here (37.1.11) can
   reach a Raspberry Pi on the LAN was not found in the sources read and was not
   tried.
3. **A relayed secure channel (an idea, not documented by Tropic Square).**
   libtropic's TCP port carries raw SPI operations (drive chip select low or
   high, send bytes, wait) as tagged messages [LT
   hal/posix/tcp/libtropic_port_posix_tcp.c lines 239–289]. In principle, a
   Raspberry Pi could forward such messages to `/dev/spidev0.0`, and the phone
   could act as the libtropic host, ending the Noise session on the phone so the
   Raspberry Pi sees only ciphertext. This would need a TypeScript
   implementation of the L2/L3 protocol (X25519, HKDF-SHA256 and AES-256-GCM
   are available in the wallet's audited noble libraries) and answers to
   questions 1.2.4. Not built, not tested, not described by Tropic Square.
4. **Bluetooth and USB.** Whether the Chairperson's Raspberry Pi has Bluetooth,
   and how a phone would reach it over USB, were not established from the
   sources read (question 1.1.1 and 1.1.11).

## 4. Candidate roles

Each role states what key sits where, what it protects against, what it does
not, and what the wallet would need. The wallet's own baseline is in
`docs/THREAT_MODEL.md` sections 3.2 (keys in the platform secure store), 4.2
(T-07 to T-10, the app PIN and its offline-guessing weakness) and T-78
(coercion). ADR D1 stands throughout: the recovery phrase remains the root, so
no role may create funds the phrase cannot recover.

### (a) An air-gapped signer on the Raspberry Pi, its secp256k1 key sealed by MAC-and-Destroy

- **What sits where.** A secp256k1 key (a watch-only account's key, or a
  multisig co-signer key) is generated on the Raspberry Pi — optionally from
  TRNG2 bytes — and stored on the Raspberry Pi only as ciphertext under the
  MAC-and-Destroy released key k. To sign, the user types the PIN on the
  Raspberry Pi; the chip releases k (one slot consumed by a wrong PIN); the
  Raspberry Pi decrypts the key into memory, signs the request the phone showed
  as QR, shows the signature as QR, and erases the key from memory. This is the
  same pattern as Tropic Square's `tropic01_util`, which seals a BIP-32
  secp256k1 master key with MAC-and-Destroy (section 2.7), and as Trezor's
  description of its own secure element: "This secret is used—along with your
  PIN—to encrypt the private keys stored on the main chip" [TRZ secure
  elements].
- **What the chip buys over a plain software key on the Raspberry Pi.** A stolen
  SD card, or a copy of the Raspberry Pi's files, cannot be brute-forced
  offline: each PIN guess needs the chip and consumes one of at most 128 slots.
  The chip's TRNG can supply the key's randomness. A monotonic counter can
  enforce a hard limit on the number of signatures.
- **What it does not protect against.** Malware or an attacker with control of
  the running Raspberry Pi: once the PIN is typed, the key is in the Raspberry
  Pi's memory and can be copied. A false display: the Raspberry Pi's own screen
  is the only place a user could check what is signed, and it is controlled by
  the same general-purpose computer. Physical attacks on the chip of the
  advisory's class (section 2.14). The phone side remains the phone (the QR
  request can be read by anyone who sees it; it contains no secret).
- **What the wallet needs.** For a watch-only account: nothing — the phone half
  exists and was proven live with a script standing in for the signer (pass
  p22b). For a multisig co-signer: nothing on the phone — the external-wallet
  approval path exists (phase 19). On the Raspberry Pi: a small signer program
  (libtropic for the chip, an audited secp256k1 library for signing), a screen
  and a camera or another QR route. Phase 23 item 5 (cold signing for smart
  accounts) would add a third format the same signer could answer.
- **Variant with a true on-chain second factor:** a 2-of-2 or 2-of-3 multisig in
  which the phone holds one key and the Raspberry Pi signer another. Operations
  then need both on-chain; messages, logins and permits remain refused for a
  multisig (the weighted validator's message check is weaker, `docs/MULTISIG.md`
  section 4).

### (b) A P-256 owner of the smart account through the Kernel WebAuthn validator

- **What sits where.** A P-256 key generated inside the chip (never readable,
  section 2.6), installed on the Kernel account as the WebAuthn validator's one
  key (section 2.5). The Raspberry Pi builds the WebAuthn envelope for each
  userOpHash, asks the chip to sign, normalizes s and returns the assertion.
- **What it protects against.** Extraction of the signing key: even full control
  of the Raspberry Pi gives only the ability to sign while in control, not a
  copy of the key. This is the only role in which the key never leaves the chip.
- **What it does not protect against.** It **adds** a way to spend; it is not a
  second factor. Kernel accepts an operation signed by the root ECDSA owner
  (the phone) OR by this key; a compromised Raspberry Pi can sign any
  operation, including a self-call that evicts the phone's key (the wallet's
  refusal of passkey self-calls is client-side only; kernel-webauthn.ts lines
  116–131). The UP / UV flags would be host-written bytes (section 2.5). The
  validator v0.0.3 is unaudited (C1). It occupies the account's single WebAuthn
  key, so a phone passkey and the chip cannot both be installed with this
  validator. Test networks only, like every smart-account signer today.
- **What the wallet needs.** An adapter that supplies the engine's `assert`
  callback (kernel-webauthn.ts line 744) from a remote signer; for a QR route,
  the smart-account cold-signing work of phase 23 item 5 with a P-256 variant of
  the request. A side benefit: this would exercise the WebAuthn validator live,
  which feature 21 has not done (it is built and simulated only; it waits for a
  development build and an rpId domain, `docs/FEATURE_UNIVERSE.md` row 21).

### (c) A second factor for the app lock or for high-value sends

- **App lock.** The app PIN record's known weakness is that "someone who copies
  the app's storage can try every 6-digit PIN on a computer" (THREAT_MODEL T-09).
  If the key that unwraps the wallet's secrets also required a MAC-and-Destroy
  release from the chip, offline guessing would end. Costs: the phone would
  need to reach the Raspberry Pi at every unlock (a network service, section
  3.2 item 2, or the relayed channel of item 3); a lost or unreachable chip
  would lock the app until the wallet is restored from the recovery phrase
  (acceptable under D1 only if the phrase restores everything, which it does
  for phrase-derived accounts but not for imported keys, T-67). The duress
  design's Wiping PIN extension (AN002 §3.7) could make a duress PIN
  irreversibly destroy the chip-held key.
- **High-value sends.** The chip could approve a hash (sign it with a P-256 key,
  or answer a MAC-and-Destroy challenge) before the phone signs. Without role
  (b) or a multisig, this is enforced only by the wallet's own code on the
  phone, like the app's spending limits: a compromised phone app skips it.
- **Verdict.** Valuable against the file-copy attack, but it turns the Raspberry
  Pi into an online dependency of every unlock and needs the most new design.

### (d) A co-signer of the wallet's multisig

- **Directly on the chip: not possible.** The deployed WeightedECDSAValidator
  verifies secp256k1 ECDSA signatures with `ecrecover` (section 3.2 item 1); the
  chip signs P-256 and Ed25519 only (section 2.4). No deployed validator that
  combines a secp256k1 threshold with a P-256 signer was found in this
  repository's record.
- **Through role (a): possible today**, with the key on the Raspberry Pi and
  sealed by the chip (the variant at the end of role a).

### (e) A hardware-bound backup of the records key

- The records-backup key is HKDF-SHA256 of the BIP-39 seed with a per-file salt
  (phase 22 item 4, `AGENTS.md`); the recovery phrase already restores every
  backup. Binding the backup to the chip instead would make it unrecoverable if
  the chip is lost, against the design's rule that the phrase restores the
  records. Storing an encrypted backup file in the chip's User Data (about
  237 KiB) adds a copy, not protection.
- **Verdict:** little value; not recommended.

### Ranking

| Rank | Role | Chip's real contribution | Wallet change | Main honest limit |
|---|---|---|---|---|
| 1 | (a) Air-gapped Raspberry Pi signer, key sealed by MAC-and-Destroy (watch-only cold signing, or a multisig co-signer) | Limits PIN guessing on a stolen Raspberry Pi to the slots set up (≤ 128); TRNG; counters | None on the phone | The key is in the Raspberry Pi's memory while signing; the Raspberry Pi's screen is the only display |
| 2 | (b) P-256 owner of the smart account via WebAuthnValidator v0.0.3 | The key never leaves the chip | An `assert` adapter; a P-256 cold-signing request for a QR route | Adds an independent owner (OR, not AND); one key per account; validator unaudited |
| 3 | (c) Second factor for the app lock | Ends offline guessing of the app PIN | New unlock design and phone-to-Raspberry Pi link | Online dependency at every unlock |
| 4 | (d) Multisig co-signer on the chip | None directly (no secp256k1) | — | Only possible through role (a) |
| 5 | (e) Hardware-bound records backup | A second copy | — | Conflicts with phrase-only recovery |

## 5. What a demo on the real board could show, and what it needs

**Principle:** nothing in Stage 3 may write a pairing key, invalidate a pairing
key, write I-Config, write R-Config, update firmware, run libtropic's functional
tests, or touch the spare chip, unless the Chairperson says so for that specific
step. Tropic Square itself warns that its functional tests "can **destroy** your
chip" [LT docs/for_contributors/tests/functional_tests.md lines 13–14], and the
irreversible operations are listed in section 2.3.

1. **Before any hardware: the software model.** The full flows (MAC-and-Destroy
   sealing a secp256k1 key, P-256 signing for the WebAuthn envelope) can run
   against the TROPIC01 Model on a Linux machine with the same libtropic code
   (section 3.1). This risks nothing.
2. **Read-only checks on the board** (with the Chairperson's agreement): chip
   identification and firmware versions (L2 information requests), a session on
   the slot the Chairperson names, a Ping, random bytes.
3. **Reversible operations in agreed free slots only:** generate a P-256 key in
   an ECC slot the Chairperson names, sign, read the public key, erase; write and
   erase one agreed User Data slot; MAC-and-Destroy only on slots the Chairperson
   confirms are unused (question 1.1.8).
4. **What the demo could show the wallet doing:** role (a) — the emulator's
   watch-only account shows a cold-signing request as QR; the Raspberry Pi
   reads it, asks for the PIN, unseals the key through the chip and shows the
   signature as QR; the wallet verifies and broadcasts on a test network. Role
   (b), if wanted, after phase 23 item 5.
5. **What it needs from the Chairperson:** the answers to section 1.1 (model,
   OS, part number, firmware, libtropic version, the pairing slot and where its
   private key lives, the slots in use); physical operation of the Raspberry Pi
   (or a decision on remote access, which this agent did not seek); a screen and
   camera or another QR route; a test-network funding plan for the watch-only
   address.

## 6. How this compares with the hardware wallets users know

- **Ledger.** Ledger says its devices have "a certified chip, designed to
  withstand sophisticated attacks", that "your private keys stay safe and
  isolated inside the Secure Element chips" and "never leave the security of
  the hardware", and that the devices run Ledger's own OS, BOLOS [LDG "Why is
  Ledger Nano so Secure?", updated 2024-07-31].
- **Trezor.** For the Safe models, Trezor says the secure element stores a
  secret that "is used—along with your PIN—to encrypt the private keys stored on
  the main chip", released "only if the correct PIN is entered", erased after 16
  wrong PINs on the Safe 3 and Safe 5 or 10 on the Safe 7; the Safe 7 adds
  TROPIC01 to an OPTIGA Trust M and the main microcontroller [TRZ secure
  elements; TRZ safe-7].
- **COLDCARD.** "a Bitcoin-only hardware wallet"; it signs PSBTs "using QR,
  MicroSD, NFC, or USB"; it uses "two Secure Elements, from different vendors"
  (Microchip ATECC608 and Maxim DS28C36B); a brick PIN "will destroy the dual
  secure element" [CC coldcard.com].
- **Where a TROPIC01 on a Raspberry Pi sits.** It is a development set-up, not a
  product: the shield is "intended for development, evaluation, and prototyping
  use" [SHIELD README.md]. Role (a) is architecturally the Trezor pattern
  (a secure element releasing a key-encryption secret after a PIN) running on a
  general-purpose Linux computer instead of a dedicated microcontroller with a
  trusted screen and buttons; role (b) is closer to Ledger's "keys never leave
  the chip", but on a curve Ethereum accounts cannot use directly. Neither
  matches a commercial device's protection of what the user sees and approves.

## 7. A production path, as requirements and questions

If the Chairperson approves a direction, a product built on TROPIC01 would need
at least the following. These are requirements to examine, not promises.

1. **A dedicated device** with its own display and physical confirmation, on a
   microcontroller rather than a general-purpose OS, so that what is signed is
   shown by trusted code. (Question: build, partner, or integrate with existing
   devices?)
2. **A decision on the curve:** secp256k1 signing on the microcontroller with
   the key sealed by MAC-and-Destroy (role a), or P-256 owners on smart accounts
   (role b) with an audited validator — or both. Question 1.2.1 to Tropic
   Square.
3. **Secure provisioning:** a customer-specific first pairing key and possibly a
   customer vendor key for firmware, both by agreement with Tropic Square
   (sections 2.3, 2.11); key ceremonies and storage for those keys.
4. **Firmware:** the device's own firmware, its update and signing process, and
   tracking of Tropic Square's firmware, advisories and errata (section 2.14).
5. **The transport** between phone and device (QR, USB, Bluetooth), with its own
   authentication and a review of what crosses it.
6. **An audit** of the device firmware and of the wallet's integration, in
   addition to the audit scoped in `docs/AUDIT_SCOPE.md`, and a review of the
   chip's public evaluations against the threat model.
7. **Recovery under D1:** losing the device must never lose funds; every key it
   holds must be derivable from, or replaceable by, the recovery phrase.
8. **Regulatory and supply questions** (hardware certification, export,
   manufacturing): not examined here.

## 8. Sources (all fetched 2026-10-25)

Tropic Square GitHub repositories, shallow-cloned on 2026-10-25 (commit prefix
and commit date):

- [T01] github.com/tropicsquare/tropic01 at 90747cac7c02 (2026-09-25):
  README.md; doc/pages/part-numbers.md, FAQ.md, security-reports.md,
  security-advisories.md, parts/TR01-C2P-T301.md, and the PDFs below.
- [DS] TROPIC01 datasheet Rev. A.11, November 11, 2025
  (doc/datasheet/ODD_TR01_datasheet_vA_11.pdf; SHA-256 ae647fa59ace0f38…).
- [API] TROPIC01 User API v1.4.0, git commit ed7a424
  (doc/api/ODU_TR01_user_api_v1_4_0.pdf; SHA-256 377fdef6a88ae495…).
- [AN002] PIN Verification Application Note v1.2, February 4, 2026
  (doc/application_notes/ODN_TR01_app_002_pin_verif_1v2.pdf; SHA-256
  014fd5457d8df419…).
- [AN005] First Pairing Key Application Note v1.3, May 5, 2026 (SHA-256
  f41942a27c17d455…).
- [AN007] Firmware Update Application Note v1.5 (SHA-256 5f96cc4507e1c61a…).
- [CAT] Catalog list v2.0, November 25, 2025 (SHA-256 0c5dec4c4c4f7d5b…).
- [SA] Security Advisory ODR_TR01_SA_2026012900 v1.0, June 3, 2026 (SHA-256
  299fa8f07ad0611c…).
- [FI] Security report ODR_TR01_PSR_006_FI_KUL v1.0, June 23, 2026 (SHA-256
  fb7ac302b29e8992…).
- [LT] github.com/tropicsquare/libtropic at 9085ea5387a8 (2026-10-02; CHANGELOG
  top entry 4.2.0; tags v1.0.0 to v4.2.0): README.md, CHANGELOG.md,
  LICENSE.md, include/libtropic.h, include/libtropic_common.h,
  docs/reference/default_pairing_keys.md, docs/tutorials/linux/spi/index.md,
  docs/tutorials/model/*.md, docs/compatibility/host_platforms/linux.md and
  posix.md, docs/for_contributors/tests/functional_tests.md,
  docs/applications/tropic01_util/*.md, examples/linux/spi/*,
  examples/model/mac_and_destroy/main.c, examples/applications/tropic01_util/*,
  hal/posix/tcp/libtropic_port_posix_tcp.c. Also tag v3.2.1:
  include/libtropic.h and src/libtropic_l3.c (raw.githubusercontent.com).
- [APP] github.com/tropicsquare/ts-tr01-app at 7c4c2eac7750 (2026-10-07):
  main/api/tropic01_l3_api.h.
- [SPECT] github.com/tropicsquare/ts-spect-fw at 3b4681caaf5f (2026-08-07):
  src/ecc_crypto/ecdsa_sign.s, LICENSE.
- [UTIL] github.com/tropicsquare/libtropic-util at cbc30f5ac37e (2025-09-12):
  README.md, docs/Linux_SPI.md, LICENSE.
- [SHIELD] github.com/tropicsquare/ts15-tropic01-rpi-shield at 5a54a6571f4d
  (2025-06-13) and tropic01-raspberrypi-shield-hw at 746b51db7cd8
  (2025-12-10): README.md files.
- Also cloned and skimmed: devboards (5457ca1e0534), security (96c036d57e75),
  libtropic-linux (748ce74cdd8f, archived). Repository list:
  api.github.com/orgs/tropicsquare/repos (53 repositories).

Websites:

- [WEB] tropicsquare.com/tropic01 and tropicsquare.com/order-devkit.
- [TRZ] trezor.io/learn/security-privacy/how-trezor-keeps-you-safe/secure-elements-in-trezor-safe-devices
  and trezor.io/trezor-safe-7.
- [LDG] ledger.com/academy/guide/ledger-ecosystem/ledger-nano-security-made-easy.
- [CC] coldcard.com.
- [AND] developer.android.com/studio/run/emulator-networking-address.

This repository (HEAD 16f5e72): `packages/chains-evm/src/kernel-webauthn.ts`,
`app/src/wallet/cold-signing.ts`, `AGENTS.md` (phases 8, 14, 17–19, 21, 22,
23), `docs/HISTORY.md` (phase 8), `docs/THREAT_MODEL.md` (sections 3.2, 4.2),
`docs/AUDIT_SCOPE.md`, `docs/FEATURE_UNIVERSE.md` (rows 11, 21, 24, 47),
`docs/MULTISIG.md`, `docs/DURESS_WALLET.md`.

## 9. What could not be verified

- Anything about the Chairperson's own chips, board, Raspberry Pi, software or
  earlier runs (section 1.1). Nothing was run against any hardware.
- secp256k1 support in any future firmware or silicon; whether custom SPECT
  firmware could add it.
- Whether the chip ever returns a high-s signature (only the absence of a
  normalization step in the source was observed).
- That a TROPIC01-signed WebAuthn envelope is accepted by the deployed validator
  (reasoned from the two sources; not simulated).
- A signed key-origin attestation; the content of the errata; which revisions the
  security reports cover; any formal certification.
- That a Raspberry Pi 3B+ works with the shield and libtropic.
- That the secure channel can be relayed over a network; chip-side timeouts.
- Whether the emulator (37.1.11) can reach a Raspberry Pi on the LAN.
- MAC-and-Destroy behaviour on power loss mid-command.
- How Trezor Safe 7 uses TROPIC01.
- The TROPIC01 Model on macOS (documented as "TBA").
