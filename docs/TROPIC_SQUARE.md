# TROPIC01 and Shiba Wallet: Stage 1 research

Phase 23 item 10, Stage 1 (research only; no code). Written 2026-10-25 for the
Chairperson and for engineers. Every statement about the chip, its software or
its boards is taken from a primary source fetched on 2026-10-25 and listed in
section 8; where a fact was not found in those sources, the text says
"not found in the sources read". Nothing about the Chairperson's own hardware
is assumed: every such point is a question in section 1. No one has touched the
Chairperson's chips, boards or network for this document.

**Updated 2026-11-07 (Stage 2).** The Chairperson's answers to section 1.1 are
recorded under it; questions 5 to 9 are answered from the Chairperson's own
proof-of-concept repository. Section 10 is the Stage 2 design for the role
section 4 ranked first, section 11 the Stage 3 demo plan, section 12 the
questions that remain and section 13 the sources added. Sections 2 to 9 are
the Stage 1 text of 2026-10-25, unchanged except for one note under section 7.

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
- **Stage 2 (2026-11-07).** The Chairperson's proof of concept drove this chip
  from a Raspberry Pi 3B+ in Python (pytropicsquare 0.0.3) on the published
  factory pairing key, signed Ed25519 on a toy ledger and never used
  MAC-and-Destroy (section 1.1, answers). The design in section 10 seals a
  secp256k1 key with MAC-and-Destroy on the Pi, answers the wallet's existing
  cold-signing formats, forbids every irreversible chip operation, and keeps
  the proof of concept's key slots; section 11 orders the read-only checks
  before the smallest live Sepolia demo.

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

#### Answers received 2026-11-07

The Chairperson answered the questions above on 2026-11-07. Questions 5 to 9
were answered by pointing at the Chairperson's own proof-of-concept repository,
`tropic_wallet_poc` (a local repository, read read-only for this section at
commit 5025353, branch `device-split-and-hardware-validation`, last commit
2026-09-26; its only uncommitted change is its own `.claude/settings.json`).
Nothing in it was run. Short label below: [POC path:line]. Where the
repository does not settle a point, the text says so; those points are listed
again in section 12.

| # | Answer (2026-11-07) | What it settles, and what stays open |
|---|---|---|
| 1 | "yes it is 3B+ but I've tested it before with lite raspi OS so I know it works it is just on the very low end of the spec requirements" | Raspberry Pi 3 Model B Plus, Raspberry Pi OS Lite (version not given). The proof of concept records its hardware run on "a TS1501 shield on a Raspberry Pi 3 Model B Plus, Raspberry Pi OS based on Debian 13, Python 3.13.5, pytropicsquare 0.0.3" [POC docs/security-status.md lines 67–69] and its test suite passing on "aarch64 Raspberry Pi OS" [line 15]. Whether today's card is that same image is open. |
| 2 | "yes TS1501" | The board is the TROPIC01 Raspberry Pi Shield, revision TS1501. The proof of concept found the chip-select jumper J2 in the CS2 position (GPIO25, physical pin 22) and confirmed it "three ways: the schematic, the SDK, and the chip answering" [POC docs/tropic01.md lines 237–256; hw/transport_config.py lines 64–68]. Whether the jumper is still there today is open (the file itself says to look). |
| 3 | Not given (the answer field read "###") | **Open.** The part number, the firmware versions and a saved chip-identification output are the first things the read-only step in section 11.2 must capture. The proof of concept recorded, on 2026-09-20, silicon revision ACAB, a "Part Number ID" field of 0x103, RISC-V (application) firmware 2.0.0.0 and SPECT firmware 1.0.0.0, and states that "the part number itself has not been read from the board and the bootloader version has not been read from the chip"; it matched the firmware pair to the TR01-C2P-T310 row of the 2026 advisory [POC docs/tropic01.md lines 97–119]. The serial number and batch id it printed (lines 103–104) are deliberately not copied into this public repository. |
| 4 | "I did update firmware to latest but that was a while ago so I'll need to confirm version" | **Open, and the record disagrees.** The proof of concept states that it "never issues a maintenance restart or a firmware update" [POC docs/firmware.md line 85], and its 2026-09-20 read showed application firmware 2.0.0.0 [docs/tropic01.md lines 105–106], while Tropic Square's part-number page already listed 2.1.0 [section 2.1] and libtropic 4.2.0 carries 2.2.0 update files [section 2.1]. So either the update happened outside that repository after 2026-09-21, or "latest" was 2.0.0 at the time. Only a fresh read settles it (section 11.2 step R2). |
| 5 | "I think I used my own code but you can check tropic_wallet_poc in Downloads to see what we did exactly" | The proof of concept is Python and talks to the chip through **pytropicsquare 0.0.3**, "a third-party SDK by Petr Kracík, MIT licensed, not Tropic Square's official library", chosen "because this proof of concept is in Python" [POC docs/tropic01.md lines 83–86; requirements-hardware.txt lines 8–10: `pytropicsquare>=0.0.3`, `spidev>=3.5`, `gpiod>=2.0`]. It does **not** use libtropic (any version), `lt-util` or `tropic01_util`. Its SPI settings are bus 0, device 0, chip select GPIO25, 1 MHz [hw/transport_config.py lines 65–68], not libtropic's 5 MHz. |
| 6 | (from the repository) | **Pairing key: slot 0, the published factory key, never changed.** Every session opens with pytropicsquare's `FACTORY_PAIRING_PRIVATE_KEY_PROD0` / `FACTORY_PAIRING_PUBLIC_KEY_PROD0` on `FACTORY_PAIRING_KEY_INDEX` [POC hw/tropic_wallet_hw.py lines 41–45, 95–99]. No pairing key was written or invalidated: "Owner pairing keys. … not implemented" [docs/security-status.md lines 149–154], the provisioning plan is "on hold at the owner's instruction. Nothing in this document has been run" [docs/pairing-key-plan.md lines 1–4]. There is therefore no private pairing key of the Chairperson's own anywhere. The repository cannot say whether any other program ever wrote slots 1–3; the read in section 11.2 step R3 does. |
| 7 | (from the repository) | **No configuration write by the proof of concept.** Its code calls no I-Config, R-Config, maintenance-mode or firmware-update command (a search of `device/`, `host/`, `hw/`, `chain/`, `demo/`, `scripts/` and `tests/` for those calls finds only comments), and it did not apply the advisory's maintenance-mode mitigation [POC docs/firmware.md lines 86–90]. Anything done outside the repository (for example the firmware update of answer 4) is open. |
| 8 | (from the repository) | **ECC key slot 0** holds the proof of concept's wallet key: an Ed25519 key generated on the chip, account 0 [POC hw/tropic_wallet_hw.py line 51 `DEFAULT_WALLET_KEY_SLOT = 0`, line 174; demo/run.sh line 146]. **ECC key slot 1** was used by the destructive hardware tests, which "have been run … destructive ones included" [docs/testing.md lines 167–169]: one test stores RFC 8032's published test key there and erases it afterwards [tests/hardware/test_tropic01_hil.py lines 383–412], and a later test generates an on-chip Ed25519 key in slot 1 when it is empty and does not erase it [lines 454–473]. So slot 1 most likely holds a chip-generated Ed25519 key — an inference from the test order, to be confirmed by the read in step R4. **User Data slots, monotonic counters and MAC-and-Destroy slots:** the proof of concept's code never calls the commands that touch them (same search as answer 7). Both ECC keys are proof-of-concept keys on a toy ledger and hold nothing of value, but this design preserves them (section 10.8). |
| 9 | (from the repository) | **The proof of concept never ran MAC-and-Destroy.** It records that `mac_and_destroy` "is present … Its exact semantics have not been investigated" and that it has no PIN [POC docs/tropic01.md lines 406–411; docs/security-status.md lines 158–159]; its plan lists "A PIN, ideally using `mac_and_destroy`" as outstanding work [docs/progress.md line 374]. There are no host-side ciphertexts, tags or attempt counters anywhere in it. It signed **Ed25519 on its own toy ledger** (a 141-byte payload beginning with the domain tag `tropic-wallet-poc/transfer/v1` [docs/decisions/0001-domain-separated-payload.md lines 22–31]), never secp256k1, never Ethereum and never a public test network [README.md lines 71–82]. **Open:** the Stage 1 plan says the Chairperson had driven the PIN feature successfully; if that happened, it was outside this repository, and which program, which MAC-and-Destroy slots and where its data lives are unknown (question 12.1.4). |
| 10 | "never plugged in it is same rasp pi shield" | The spare chip sits on a second TS1501 shield and has never been powered. Nothing in this document touches it (section 10.8). |
| 11 | "it does not, I've only connected via SSH but I have plenty of peripherals available to use as needed" | No screen, camera or keyboard today; reached over SSH on the network. Section 10.4 states what each channel option needs and what it costs in trust. |
| 12 | "yes you can consider it lab equipment... while keys are sensitive we don't intend to store any mainnet assets (or if we do we should limit accordingly)... do not perform any destructive actions that are irreversible such as making the chip unusable ever again... destructive actions that do not permanently and irreversibly change the state of the chip are okay (my understanding is MAC and destroy feature is destructive but only makes it so you can't use the slot again until re-initialized with new keys... this is okay... but if we destroy and we can never use it ever again even with new keys and new prototype that is not permitted)" | Lab equipment, test assets only. The understanding of MAC-and-Destroy is **correct**, with four caveats; section 10.1 checks it against the sources and sorts every chip operation into "forbidden" and "consumes state that can be set up again". |
| 13 | "I'd like to see if the design could later become a Shiba branded hardware device that can be utilized in combination with the hot wallet (i.e. the mobile device we are building right now)" | Option (b). Section 10.10 reconciles section 7 with it. |
| 14 | "similarly to our other features for the Shiba wallet prototype, testnet only please... if testnets are not available or not viable let me know and we can revisit" | Test networks only. They are available and viable for this role: the phone half was proven live on Ethereum Sepolia (passes p22b and p23-coldaa, `AGENTS.md`). Section 10.9 says where the rule is enforced, because the app itself offers regular-account cold signing on every network. |

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

*Note added 2026-11-07: the Chairperson chose option (b), a design that could
become a Shiba-branded device; section 10.10 reconciles this list with it.*

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

## 10. Stage 2 design: an air-gapped signer on the Raspberry Pi, its secp256k1 key sealed by MAC-and-Destroy

Written 2026-11-07 for the role section 4 ranked first, after the answers in
section 1.1. It is a design, not code: nothing here has been built or run, and
nothing has touched the Chairperson's hardware. Sources added for this section
are listed in section 13 (the datasheet, the PIN note AN002, the configuration
note AN006 and the firmware-update note AN007 were fetched again on 2026-11-07
and their SHA-256 prefixes match those recorded in section 8, except AN006,
which section 8 did not list). It is written as the first version of a device
that could become a Shiba-branded product (answer 13), with every place where
the Raspberry Pi falls short of a product stated.

**What this design deliberately does that the Chairperson's proof of concept
deliberately did not.** The proof of concept decided "for the current PoC, we
do not implement real secp256k1 signing or a 'release secret, then sign' flow
on the Raspberry Pi", because "Any secret released by TROPIC01 to a process
running on the Pi is exposed the moment that process's memory is exposed"
[POC ARCHITECTURE_DECISIONS.md lines 96–114]. That reasoning is correct and
stands. This design builds the flow anyway, as lab equipment on test networks
only (answers 12 and 14), because it is the only way to exercise the wallet's
existing cold-signing and multisig formats against the chip, and because the
parts that carry over to a product (the request formats, the display rules,
the PIN scheme, the key derivation, the slot plan) do not depend on the Pi.
The parts that do not carry over are named in section 10.10.

### 10.1 Which chip operations are forbidden, and which only consume state (answer 12 checked)

**The Chairperson's understanding of MAC-and-Destroy is correct.** A
MAC-and-Destroy call overwrites its slot: the sequence "computes value S_i and
overwrites the slot i with it" [AN002 §3.2 p.6]; after a wrong PIN "the slot cannot
be used again, until its reinitialization", and after a correct PIN "the
destroyed slots are initialized again" [AN002 p.11]. The slots are ordinary
R-Memory slots in the MAC-and-Destroy data partition, which the chip "Reads,
writes, and erases" [DS §7.9 p.52], and R-Memory supports erase back to 1
[DS §7.1.1 p.20]. So a destroyed slot can be set up again with a new master
secret and new PIN; nothing about the chip is used up for good. Four caveats:

1. **The secret, not the slot, can be lost for good.** "Without the knowledge
   of s the slots cannot be reinitialized to the correct value S_i" [AN002
   p.11]. If every attempt of a set-up is used, or a Wiping PIN is entered
   ("the way for the key k is forever closed" [AN002 p.13]), the key that
   set-up protected is gone. The slots can then carry a new set-up; whatever
   was sealed under the old key can be recovered only from its own backup
   (in this design, the device's recovery phrase, section 10.6).
2. **A slot's state cannot be inspected without changing it.** The only
   command that touches the partition is MAC_And_Destroy itself [AN002 §3.2 p.6;
   libtropic `lt_mac_and_destroy`, include/libtropic.h lines 636–652], and it
   overwrites. Whether an earlier PIN run (outside the proof of concept,
   answer 9) left anything in a slot can only be answered from memory, never
   read.
3. **Flash wears.** Endurance is 100,000 reprogram cycles [DS §9.6 p.61];
   AN002 treats the flash write cost as part of the rate limiting [AN002
   Appendix B p.21]. A demo uses a few hundred cycles at most.
4. **An ECC key erased is gone, even though its slot can be reused.** The
   proof of concept calls `ecc_key_erase` "the genuinely destructive operation
   on this chip" [POC hw/tropic_wallet_hw.py lines 176–185]. Slot reuse is
   fine under answer 12; losing the proof of concept's keys is a separate
   decision, so this design leaves ECC slots 0 and 1 alone (section 10.8).

**The two classes, for every operation this project might issue:**

| Operation | Class | Why (source) |
|---|---|---|
| Write a pairing key (`Pairing_Key_Write`) | **FORBIDDEN** | Each slot can be written once, and pairing keys live in I-Memory, where "it is impossible to revert the value back to 1" [DS §7.1.2 p.23; AN005 §1.2]. It does not make the chip unusable, but it permanently uses one of four slots. Needs the Chairperson's explicit yes for that step, and is not needed by this design (section 10.7). |
| Invalidate a pairing key | **FORBIDDEN** | "Once the Pairing Key slot is Invalidated, the state is impossible to change"; "When all Pairing Key slots are Invalidated … TROPIC01 is unusable" [DS §7.5.3 p.44]. |
| Write any I-Config object | **FORBIDDEN** | I-Config is I-Memory; a write changes a bit "from 1 to 0" [libtropic include/libtropic.h line 416] and cannot be reverted [DS §7.1.2 p.23]. |
| Write or erase R-Config, including maintenance-mode and user-access-privilege settings | **FORBIDDEN** | Reversible by design, but libtropic warns "Writing R-config before erasing it first can brick the TROPIC01 chip. Refer to Erratum OI_TR01_ERR_2026010800: R-Config write triggers permanent Alarm Mode" [libtropic include/libtropic.h lines 366–367]; AN006 adds that "incorrect configuration might lead to irreversible consequences" — disabling configuration changes for every pairing key leaves the configuration "permanently" [AN006 p.18], and an R-Config field can return from 0 to 1 only by erasing the whole R-Config first, "Otherwise the state of R-Config is undefined!" [AN006 p.13]. Whether the erratum applies to this chip's part number is unknown (answer 3), so the class is forbidden outright. |
| Write to reserved configuration locations | **FORBIDDEN** | "We strongly advise the user not to write to these locations" [AN006 p.10]. |
| Update either firmware, or enter maintenance mode for it | **FORBIDDEN** | No downgrade: "If the FW version of the incoming update is lower than the FW version in the protected bank, the bootloader rejects the update" [AN007 p.8]; mismatched application and SPECT firmware leave the chip "in Start-up mode" [AN007 p.10]. The firmware question (answer 4) is answered by reading, never by updating. |
| Run libtropic's functional tests | **FORBIDDEN** | Tropic Square warns they "can **destroy** your chip" [LT docs/for_contributors/tests/functional_tests.md lines 13–14]. |
| Run the proof of concept's destructive hardware tests (`TROPIC01_HIL_DESTRUCTIVE=1`) or its `init --force` | **FORBIDDEN in this design** | Not chip-destroying, but they erase ECC slots 0 and 1 [POC tests/hardware/test_tropic01_hil.py lines 289–330, 383–412; docs/hardware-bringup.md lines 122–138], which this design preserves. |
| Anything on the spare chip | **FORBIDDEN** | Answer 10; the spare stays unpowered. |
| `MAC_And_Destroy` on an agreed slot | Consumes state; can be set up again | Above. |
| Erase and write an agreed User Data slot | Consumes state; can be set up again | A slot "must be erased before it is written again" [DS §7.6 p.46]; endurance as above. |
| Initialise, decrement or reset an agreed monotonic counter | Consumes state; **can be reset** | The datasheet lists "The option to reset, decrement, or read"; `MCounter_Init` sets any start value; at 0 an update returns UPDATE_ERR and the value stays 0 [DS §7.10 pp.52–53]. Each counter spans two R-Memory slots. Because anyone holding a session with the default privileges can reset it, a counter is not a security control on this board (section 10.7). This design does not need one. |
| Generate or erase an ECC key in an agreed slot | Consumes state; can be set up again (the old key is lost) | Section 2.6 and caveat 4 above. Not needed by this design. |
| Start a session on pairing slot 0, Ping, Get_Info, read chip id and firmware versions, read ECC public keys, read User Data, read configuration, Random_Value_Get, read a counter | Read only | No state change except the session nonce and, for Ping, the sleep timer [DS §7.11 p.53]. |

One further fact, outside anyone's control: if the chip detects a hardware
failure during a command it "remembers the HW failure, and enters Alarm Mode
upon each next power cycle. The chip will not function anymore" [DS
p.32]. No design can prevent that; it is the reason the spare chip stays
unpowered.

### 10.2 The shape of the device

```
 phone (Shiba Wallet)                    Raspberry Pi 3B+ "signer"                 TROPIC01 (TS1501)
 ───────────────────                     ───────────────────────────               ─────────────────
 watched address ──request (QR/file)──▶  parse + recompute every hash
 or multisig                             show decoded fields; user approves
                                         user types PIN on the Pi  ──MAC_And_Destroy──▶ releases k
                                         decrypt sealed seed with k  ◀── (one slot used,
                                         derive secp256k1 key            re-initialised on success)
                                         sign; normalise s; wipe
 checks signature, ◀──signature (QR/file)
 broadcasts
```

- The **phone** keeps doing exactly what it does today for a watched address
  or a multisig: it prepares the request, checks the signature it gets back
  against the request it stored, and broadcasts. No phone change is needed
  for the first version (section 4, role a).
- The **Raspberry Pi** is the signer. It holds the device's secp256k1 key only
  as ciphertext; it decodes the request itself and never trusts the request's
  summary; it asks the user to approve and to type the PIN on the Pi.
- The **chip** does one job: it decides, with a hard attempt limit enforced
  inside the chip, whether the PIN releases the 32-byte key that decrypts the
  seed (section 2.7). It never sees the secp256k1 key and never signs the
  Ethereum transaction (section 2.4).

### 10.3 How the Pi learns what to sign: the wallet's existing formats

The signer answers three request formats that already exist in this
repository. Every one carries a plain-sentence `summary` that the signer must
never trust; every one carries the hash the signer will sign, which the signer
must recompute from the fields and compare. All three use the same numbered
QR-part scheme, `<PREFIX><n>/<total>:<chunk>`, from 2 to 20 parts of at most
858 bytes each (version 20 at error-correction level L), collected in any
order, a part that contradicts one already read refused
[app/src/wallet/qr-parts.ts lines 1–14, 76–140; app/src/wallet/cold-signing.ts
lines 83–93].

1. **A regular send for a watched address** (`shiba-wallet/cold-sign-request`,
   version 1, QR prefix `SW-CS:`; app/src/wallet/cold-signing.ts lines 71–84,
   146–188). Fields: `requestId` (16 random bytes), `chainId`, `from` (the
   watched address), `tx` (an EIP-1559 type 0x2 transaction: `nonce`,
   `maxPriorityFeePerGas`, `maxFeePerGas`, `gasLimit`, `to`, `value`, `data`,
   an always-empty `accessList`), `summary` and `signingHash` =
   keccak256(0x02 ‖ rlp(the nine fields)). The answer is
   `shiba-wallet/cold-sign-signature` with `requestId`, `signer`,
   `signingHash`, `yParity`, `r`, `s`. The phone refuses a signature unless
   the request id matches, the hash recomputed from its stored request
   matches, yParity is 0 or 1, r and s are 32 bytes, s is at most n/2, the
   stated signer is the watched address and `ecrecover` returns it (lines
   592–641). A type 0x04 (EIP-7702) request is refused (the record, phase 22
   item 3). A native send is about 696 bytes (one QR code); a USDC send about
   871 bytes (two parts).
2. **A smart-account operation for a watched owner**
   (`shiba-wallet/cold-sign-userop-request`, version 1, QR prefix `SW-CU:`;
   packages/chains-evm/src/cold-userop.ts lines 62–162;
   app/src/wallet/cold-aa.ts lines 88–106). Fields: `requestId`, `chainId`,
   `entryPoint`, `sender` (the Kernel account), `owner`, `scheme`
   (`kernel-v3.3-ecdsa-root/eip191-userop-hash`), `nonceKey`, `accountIndex`,
   the thirteen operation fields, `summary`, `userOpHash` (EntryPoint v0.7),
   `signingDigest` = the EIP-191 hash of the userOpHash, `createdAt` and
   `expiresAt` (30 minutes by default, at most 24 hours; lines 91–98). The
   signature is r ‖ s ‖ (27 + yParity) (lines 74–88). A deploying request is
   about 2.3–2.5 KB, three parts (cold-aa.ts lines 91–95; the record, pass
   p23-coldaa). The fees are inside the userOpHash, so a signed operation
   cannot be repriced (lines 55–58).
3. **A multisig co-signer approval** (`shiba-wallet/multisig-signing-request`
   and `shiba-wallet/multisig-approval`, QR prefix `SW-MS:`;
   app/src/wallet/multisig.ts lines 1127–1129). The engine part
   (packages/chains-evm/src/kernel-multisig.ts lines 376–420) carries
   `chainId`, `account`, `weightedValidator`, `callData`, `nonce`,
   `callDataAndNonceHash` and the EIP-712 `approvalDigest`, which the reader
   recomputes (lines 446–470). The co-signer signs Approve(callDataAndNonceHash),
   which covers the calls and the nonce but "does NOT cover the gas limits,
   the gas fees, the paymaster" (lines 383–390). The phone also accepts a bare
   65-byte r ‖ s ‖ v signature, v 27/28 or 0/1 (multisig.ts lines 1915–1945).

**Order of support.** Version 1 of the signer answers format 1 only, which is
the smallest and was proven live through the app with a script standing in for
the signer (pass p22b). Format 3 is next: it makes the device a co-signer of a
2-of-N multisig with the phone, which is the arrangement that turns the device
into a real on-chain second factor (section 4, role a variant). Format 2 is
last; it needs the request's expiry checked against the Pi's clock, which an
air-gapped Pi without a network time source may not have right (question
12.1.10).

**The existing stand-in to copy.** `scripts/testnet/cold-signer.mjs` already
plays this off-line signer: it reads a request (or its parts), decodes it
"FROM THE TRANSACTION FIELDS (never trusting the request's own summary)",
signs, and prints the signature payload, all "through the app's own
app/src/wallet/cold-signing.ts", and it refuses any chain outside its test
list (lines 1–55, 65, 304–313). The Pi signer is that script with three
changes: the key comes from the sealed seed instead of the dev phrase, the
approval and PIN are asked on the Pi, and the output goes back by the chosen
channel.

### 10.4 The channel between phone and Pi (the Pi has no screen today)

The chip's secure channel ends at the Pi (section 3.2); none of the options
below changes that. They differ in what the Pi is exposed to.

| Option | What is needed | Trust statement |
|---|---|---|
| (a) **QR both ways**: a small display on the Pi shows the signature as QR codes; a camera reads the phone's request codes | A display, a camera, a QR decoder and encoder on the Pi, a keypad or keyboard for the PIN | The only option that keeps the Pi air-gapped: nothing but QR images crosses, and both payload kinds hold no secret ("They contain no key and no secret", cold-signing.ts `COLD_SIGN_QR_CONTENTS`, line 695). The Pi's network interfaces can be switched off. The display and keypad are driven by the same general-purpose computer that holds the key while signing, so they are only as trustworthy as that computer (section 4, role a). Which display, camera and keypad suit a 3B+ is question 12.1.8. |
| (b) **A USB or serial cable** to a computer or phone | A cable and a small protocol | Not air-gapped: the Pi now has an attack surface on a wire. Narrower than a network, because only one peer exists. The proof of concept's host and device spoke length-framed messages over a pipe, which it describes as standing in "for a wallet plugged into a USB port" and as "a much weaker boundary than a physical device provides" [POC host/client.py lines 178–185; device/wire.py]. A phone-to-Pi cable route was not established (section 3.2 item 4). |
| (c) **A local-network service** on the Pi | The Pi on the network, its own authentication and encryption between phone and Pi | An online signer. Every network-facing component of a full Linux system is then in scope. Not recommended for a signer that holds keys; it is the shape role (c) of section 4 would need. |
| (d) **Files over SSH** (today's only path: answer 11) | Nothing new | **For the first lab demo only.** The request text and the signature text are copied by hand between the Mac (the emulator's clipboard) and the Pi. The Pi stays networked, and the approval prompt and the PIN are typed into an SSH session from the Mac, so the Mac's terminal sees both. Acceptable only for a throwaway device phrase with test funds (section 11). |

**What the proof of concept did for "a channel the host does not control".**
It asked for approval on the controlling terminal, `/dev/tty`, not on the
standard input the host process wrote to: "If confirmation were read from
standard input, the host would be supplying it" [POC device/confirm.py
lines 4–14], and the user had to type the amount, not press a key (lines
24–35). That separates the host program from the approval inside one machine.
In this design the "host" is the phone, which is a separate device, so the
separation is physical; the lesson that carries over is that the PIN and the
approval are entered on the Pi's own input and never relayed from the phone.
The proof of concept also notes that its interactive confirmation was
rehearsed only "over a non-interactive SSH session" on the software backend
[POC docs/known-limitations.md lines 108–112], so option (d) is no weaker than
what it showed.

### 10.5 What the Pi shows before signing, and how the user approves

The signer shows only what it decoded itself, in this order, and refuses
before showing anything if a check fails:

1. **Refusals first.** A chain id outside the test list (section 10.9); a
   request whose recomputed signing hash, userOpHash, digest or approval
   digest differs from the one it carries; an expired smart-account request;
   a `from`, `owner` or co-signer that is not this device's address; any
   EIP-7702 material; any request type or version the signer does not know.
2. **The network** by name and chain id.
3. **What moves:** for a plain transfer, the recipient in full and the exact
   amount; for an ERC-20 `transfer`, the token contract, the recipient and the
   exact base-unit amount (the same decoding as `decodeColdSignCall`,
   cold-signing.ts lines 294–306); anything else is shown as "a contract call"
   with the full calldata, and version 1 refuses it.
4. **The worst-case fee** (gas limit × max fee for a transaction; the
   operation's gas fields × max fee for a smart-account operation; for a
   multisig approval, the sentence that the approval does not fix the fee).
5. **The nonce**, and for a multisig the account and the nonce it approves.

Addresses are shown in full and never abbreviated: the proof of concept gives
the reason — "An attacker can grind a key whose address shares a short prefix
and suffix with the intended one" [POC docs/decisions/0005-address-encoding-scope.md
lines 67–69].

**Approval** is two steps on the Pi's own input: the user types the amount (the
proof of concept's control), then types the PIN. A refusal or a missing
terminal means no signature (the proof of concept's fail-closed rule,
docs/security-status.md lines 44–48). The PIN is never typed on the phone.

### 10.6 The secp256k1 key: how it is made, sealed and used

**Three approaches compared.**

| | Where the coin key is made | What protects it at rest | Backup |
|---|---|---|---|
| The proof of concept | On the chip, Ed25519, never leaves [POC docs/decisions/0002-on-chip-key-no-recovery.md lines 16–17] | The chip | "There is no recovery" (line 29); not usable for Ethereum (section 2.4) |
| Tropic Square's `tropic01_util` | A BIP-32 secp256k1 master key derived on the host from a recovery phrase [section 2.4, `pin_set.py` lines 12–23] | MAC-and-Destroy, with XOR as the cipher in its DevKit firmware and the comment "In production, replace it with some encryption standard!" [section 2.7] | The phrase |
| **This design** | A BIP-39 phrase of the device's own, generated on the Pi; the account key derived from it on the standard Ethereum path | MAC-and-Destroy releases k; the seed is sealed under k with an authenticated cipher | The phrase, written on paper |

AN002 itself says XOR is enough only "If the scheme is implemented exactly as
defined in Subsections 3.4 and 3.5", and that "Using standardized symmetric
ciphers is always the safe solution" [AN002 §3.3 p.6]. Sealing the seed is
outside that scheme, so this design uses an authenticated cipher (for example
AES-256-GCM, which the proof of concept's Python dependency `cryptography`
provides) for the seal, and follows AN002 §3.4–3.5 exactly for the PIN layer.

**Provisioning (once):**

1. Generate 32 bytes of entropy on the Pi from the operating system's random
   source, mixed (by hashing) with 32 bytes from the chip's `Random_Value_Get`
   (TRNG2, section 2.10). Mixing means neither source alone decides the key.
   Turn the entropy into a 24-word BIP-39 phrase.
2. Show the phrase once; the Chairperson writes it on paper. In the SSH-only
   demo (option d) the phrase passes through the Mac's terminal: acceptable
   only because this phrase is a throwaway for test funds, and stated as such.
3. Derive the 64-byte BIP-39 seed (no passphrase) and the account key at
   m/44'/60'/0'/0/0, the path this repository's own `evmKeyProvider` uses for
   phrase accounts (cold-signer.mjs line 18 prints "m/44'/60'/0'/0/3" for
   index 3). Show the address; the phone will watch it.
4. Set up the PIN per AN002 §3.4 on the agreed MAC-and-Destroy slots
   (section 10.8): a random 32-byte master secret s, n slots initialised, one
   ciphertext of s per slot, a tag, an attempt counter. AN002 says this host
   data "does not require any kind of protection" [AN002 §3.3 p.6]. The
   released key is k = KDF(s, 0x02) [AN002 §3.3–3.4].
5. Seal the 64-byte seed under k with AES-256-GCM (a fresh 12-byte nonce).
   Store the sealed seed and the AN002 host data together in one agreed User
   Data slot on the chip (or on the SD card; either is allowed by AN002). By
   this document's own arithmetic, eight 32-byte ciphertexts, a 32-byte tag,
   a counter and a sealed seed of 92 bytes come to about 390 bytes, inside one
   475-byte slot [DS §7.6 p.46]; the exact AN002 field sizes must be taken
   from AN002 §3.4 before n is fixed. Keeping it on the chip means the SD card
   holds no wallet data at all and the Pi can be rebuilt from scratch.
6. Erase s, k, the seed and the key from memory as far as the language allows
   (below), and run the unseal once with the correct PIN to prove the set-up.

**Signing (each request):** decode and show (section 10.5); approval; PIN;
the AN002 check uses the next slot and, on success, re-initialises the used
slots [AN002 §3.5 p.11]; k decrypts the seed; derive the key; check that its
address is the request's `from`, `owner` or co-signer; sign; normalise s
(section 10.9); verify the signature locally against the address; erase; output
the payload. A wrong PIN produces no signature and leaves one fewer attempt.

**Attempt limit.** n = 8 is proposed (a judgement; Trezor uses 16 or 10,
section 6). With a 6-digit PIN, an attacker holding the board gets 8 guesses
in a million. The sealed seed cannot be attacked offline from a copy of the
User Data or the SD card: k comes from the random 32-byte s, not from the PIN.

**Wiping PIN (optional, later).** AN002 §3.7 describes a PIN that destroys k
[AN002 p.13]. On this device it would leave only the paper phrase able to
restore the key. That fits the wallet's duress design (`docs/DURESS_WALLET.md`)
but is not in version 1.

**Memory.** The key exists in the Pi's memory from the unseal to the end of
signing. In a garbage-collected language a copy cannot be reliably zeroed —
this repository records the same limit for a private key held as a string in
the app (`AGENTS.md`, phase 13 item 3, "the hex string cannot be zeroed —
N-03"). The Pi's swap should be off for the signer, and the process should run
only for one request. These reduce, not remove, the exposure the proof of
concept's Decision 3 describes.

**Relation to ADR D1.** The device's key comes from the device's own phrase,
not from the phone's recovery phrase; if it came from the phone's phrase, the
phone would hold the device's key and the device would protect nothing. For a
watched address that is already the case today (the watched address is not
derived from the wallet's phrase), and for a multisig a co-signer key is
separate by nature. So the phone's phrase restores the phone's accounts, and
the device's phrase restores the device. Recorded as decision 12.1.13.

### 10.7 The pairing-key policy

**Today (answer 6):** every session opens on slot 0 with the factory key
whose private half is published in the SDKs (section 2.3; [POC
hw/tropic_wallet_hw.py lines 75–99]). As the proof of concept puts it, the
session "protects the SPI bus against a passive eavesdropper, and nothing
more" [POC docs/tropic01.md lines 202–205].

**What that means for this design, exactly.** Anyone who holds the board (or
runs code on the Pi) can open a session and issue every command the default
privileges allow. Against the MAC-and-Destroy layer they can (1) burn the
attempts, which destroys k and leaves only the paper phrase (a denial, not a
theft); (2) read the sealed seed and the AN002 host data from the User Data
slot, which does not help them, because k derives from the random s and the
slot values are keyed inside the chip [AN002 Appendix B p.21]; (3) erase that
User Data slot or any ECC slot (another denial); (4) reset any monotonic
counter, which is why no counter is used as a control. They cannot learn k
without the PIN within the attempt limit: the limit "holds" against a
compromised host because each guess consumes a slot inside the chip and only
the holder of s can re-initialise it [AN002 §3.5.1, Appendix B]. So the
published slot-0 key costs availability, not the key, under the chip's own
threat model. What it does cost is the ability to tell a genuine signer from a
substituted one, which attestation through the chip's certificate chain (Tropic Square's PKI note, recorded by the proof of concept as read only in part and not implemented [POC docs/tropic01.md lines 383–391]) would address.

**What a product needs.** A pairing key that only the device's own firmware
holds, ideally the customer-specific first pairing key Tropic Square programs
at manufacture under a custom part number, so no slot is spent in the field
[AN005 §2.2; the proof of concept reached the same conclusion, POC
docs/pairing-key-plan.md lines 93–105]; and user-access privileges that let
that session do only MAC_And_Destroy, User Data and random reads [DS §7.5.4
pp.44–45].

**What this design does on the lab board: nothing.** Writing a pairing key is
an irreversible act (section 10.1). It is not needed for any step in section
11. If the Chairperson ever wants it, it needs an explicit yes for each step,
on a chip the Chairperson is willing to commit, following the proof of
concept's order — write slot 1, prove a session on slot 1 in a separate
process, and only then consider invalidating slot 0 — whose two irreversible
steps it names itself [POC docs/pairing-key-plan.md lines 60–91]. Invalidating
slot 0 before slot 1 is proven would leave a chip nothing can talk to
[DS §7.5.3 p.44].

### 10.8 The slot plan

| Resource | Use in this design | Status |
|---|---|---|
| Pairing slot 0 | Sessions (factory key) | Unchanged |
| Pairing slots 1–3 | None | Unchanged; state read in step R3 |
| ECC key slots 0 and 1 | None. They hold the proof of concept's Ed25519 keys (answer 8) | **Preserved**: never erased, generated into or stored into |
| ECC key slots 2–31 | None | Read-only inventory in step R4 |
| MAC-and-Destroy slots | **n = 8 agreed slots, proposed 120–127** (high numbers, away from any example that starts at 0; a proposal only) | Consumed and re-initialised by every PIN check. Because a slot cannot be inspected (section 10.1), the Chairperson confirms first that no earlier PIN set-up must be kept in those slots (question 12.1.4) |
| User Data slots | **One agreed slot** for the sealed seed and the AN002 host data | Erased and written at provisioning; read at each signature. libtropic's model example keeps its PIN data in slot 511 (section 2.7); a different slot is proposed so the model example and this design can never collide on a chip that ran both |
| Monotonic counters | None | Read-only inventory in step R6, optional |
| I-Config, R-Config, firmware | None | **Forbidden** (section 10.1); read-only in step R7 |
| The spare chip | None | **Never powered** |

### 10.9 The signatures and where "test networks only" is enforced

**Low s.** Every signature this device produces is secp256k1 ECDSA made in
software on the Pi (the chip makes none, section 2.4), and the signer
normalises it: if s > n/2 it replaces s with n − s and flips yParity, then
re-verifies. Each consumer requires or tolerates exactly that:

- **A regular transaction** (format 1): the phone refuses s above n/2 before
  broadcasting, "EIP-2 (Homestead): a transaction whose s is above
  secp256k1n / 2 is" invalid [packages/chains-evm/src/eoa-tx.ts lines
  139–150], and recovers the signer with `recoverEip1559Signer` (line 158).
- **A Kernel v3.3 smart-account operation** (format 2): the root
  ECDSAValidator accepts the owner's signature over the EIP-191 form of the
  userOpHash [packages/chains-evm/src/cold-userop.ts lines 45–51, citing
  ECDSAValidator.sol lines 49–66 at kernel cd697c7e]; the engine refuses a
  zero or high s before submitting (`recoverExternalSigner`,
  packages/chains-evm/src/smart-account.ts lines 729–747), although the
  validator would also accept the high-s twin (lines 734–736).
- **A multisig approval** (format 3): the WeightedECDSAValidator recovers each
  approval with Solady's `ECDSA.recover`, which passes v to the `ecrecover`
  precompile unchanged and does not check s (app/src/wallet/multisig.ts lines
  1922–1931, citing WeightedECDSAValidator.sol lines 215–220 and Solady
  ECDSA.sol lines 50–77). The signer still emits low s with v = 27 or 28.

**Test networks only (answer 14).** The rule has to live on the device,
because the phone does not enforce it for format 1: a cold-signed regular send
is "an ordinary regular-account transaction, offered wherever Send is" with no
readiness row (the record, phase 22 item 3). Formats 2 and 3 are already
behind test-network-only readiness rows on the phone (`cold-aa`, `multisig`).
On the device, three independent locks:

1. **A chain-id allow-list** checked before anything is shown or the PIN is
   asked: the same list as `scripts/testnet/cold-signer.mjs`, `TEST_CHAINS =
   ['11155111', '84532', '421614', '560048', '11155420']` (Ethereum Sepolia,
   Base Sepolia, Arbitrum Sepolia, Hoodi, OP Sepolia; line 65, refusals at
   lines 304–313). For format 3 the chain id is inside the EIP-712 domain the
   signer recomputes, so a mainnet approval cannot pass as a test one.
2. **A device phrase used for nothing else.** Its addresses are never funded
   on a main network.
3. **A value cap** on what the device will sign per request (for example 0.01
   test ETH or 10 test USDC; a judgement, matching answer 12's "limit
   accordingly").

### 10.10 The product path: section 7 reconciled to option (b)

Answer 13 chose (b): a design that could later become a Shiba-branded device
used together with the phone wallet. Section 7's requirements, re-read for
that goal:

1. **A dedicated device, not a Raspberry Pi.** A microcontroller with secure
   boot, signed firmware, its own display and buttons, no general-purpose
   operating system — the Trezor pattern, which Tropic Square's sibling uses
   (section 6) and which the proof of concept's Decision 3 and decision record
   0004 describe as the requirement [POC ARCHITECTURE_DECISIONS.md lines
   88–114; docs/decisions/0004-no-firmware-update.md lines 30–49]. The Pi
   prototype carries over its request parsing, display rules, PIN scheme, key
   derivation and slot plan; it does not carry over any trust in its display,
   its memory or its boot.
2. **The curve.** secp256k1 in the device's own firmware with the key sealed
   by MAC-and-Destroy (this design), unless Tropic Square offers secp256k1 on
   the chip. The proof of concept records that custom application firmware
   "is available on request", "confirmed directly with Tropic Square"
   [POC ARCHITECTURE_DECISIONS.md lines 13–15]; this document has no source
   for that conversation and treats it as unverified (question 12.2.1).
3. **Provisioning.** A customer-specific first pairing key from Tropic Square
   (section 10.7) and privilege restrictions set at manufacture; possibly a
   customer vendor key for firmware [AN007 custom firmware, section 2.11];
   attestation of every device before the phone trusts it (section 2.12).
4. **The transport.** QR both ways (section 10.4 option a). The phone needs no
   change: the three request formats of section 10.3 are the interface. A
   written, versioned specification of those formats is needed before a
   second implementation exists; EIP-4527 was read and not adopted
   (the record, phase 22 item 3).
5. **Recovery under D1.** The device's own phrase restores the device; the
   phone's phrase restores the phone (section 10.6). The strongest pairing
   with the hot wallet is a 2-of-3 multisig — phone, device, and a third key
   kept offline — so losing any one leaves the funds movable. The multisig's
   honest limits (messages and permits refused) stay (`docs/MULTISIG.md`).
6. **Audits and certification** (section 7 items 6 and 8), the advisory's
   physical attack class (section 2.14), and test networks only until the
   mainnet conditions C1–C3 are met (`docs/MAINNET_READINESS.md`).

### 10.11 What runs on the Pi 3B+

- **Chip access:** the proof of concept's stack, which is the only one shown to
  work on this exact board: Python 3.13.5 with pytropicsquare 0.0.3, spidev and
  gpiod on aarch64 Raspberry Pi OS (answer 1). libtropic (C) lists only the
  Raspberry Pi 4 and 5 as tested (section 3.1); it stays the reference for a
  product. Whether pytropicsquare exposes every command this design needs is
  partly open: the proof of concept verified `mac_and_destroy(slot, data)` and
  `random(nbytes)` in its source [POC docs/tropic01.md lines 127–143] but did
  not list User Data, pairing-key read, counter or configuration-read calls
  (question 12.1.9). If User Data calls are missing, the AN002 host data and
  the sealed seed go on the SD card instead, which AN002 permits.
- **The signer logic:** the wallet's own TypeScript, run by Node.js on the Pi
  exactly as `cold-signer.mjs` runs it on the Mac, so the parsers, hashes and
  checks are the same pinned code the phone uses rather than a second
  implementation in Python that could disagree. The repository uses Node
  v24.21.0 (`AGENTS.md`, Toolchain); whether that version installs and runs
  the engine on a 3B+ is unverified. The alternative — one Python process —
  would need its own RLP, Keccak-256 and EIP-712 code: the proof of concept's
  installed `cryptography` 46.0.7 has a SECP256K1 curve
  (cryptography/hazmat/primitives/asymmetric/ec.py line 298) and SHA3-256
  (hashes.py line 149) but no Keccak function, and SHA3-256 is not the
  Keccak-256 Ethereum uses, so it must not be substituted.
- **How they meet:** a short-lived Python helper does only the PIN check and
  hands k to the Node signer over a pipe on the same Pi. That is no weaker
  than one process: both run on the same general-purpose system the proof of
  concept's Decision 3 already treats as one trust domain.
- **Nothing on the Pi needs the network** except option (d) of section 10.4
  for the first demo.

## 11. Stage 3 demo plan

### 11.1 Rules for every step

Every step is marked **READ** (no state change beyond the session nonce),
**CONSUMES** (changes state that can be set up again, only in the slots agreed
in section 10.8), or **FORBIDDEN** (section 10.1; not done without the
Chairperson's explicit yes for that step, and not part of this plan). The
Chairperson runs every command that talks to the chip, over SSH, on the board
in use. An agent prepares and reviews the commands, drives the emulator and
the Mac-side scripts, and reads chain data; an agent connects to the Pi only if
the Chairperson grants that for a named step (Stage 1 sought no remote access,
and none is assumed now). Output that names the chip's serial number stays
with the Chairperson unless he chooses to share it.

### 11.2 Read-only steps first (on the real board)

| Step | Who | What | Class |
|---|---|---|---|
| R0 | Chairperson | Look at the shield: J2 on CS2; the spare shield stays unpowered | READ (no power) |
| R1 | Chairperson, SSH | `cat /etc/os-release; uname -m; python3 --version; ls -l /dev/spidev*` — the operating system version, architecture and SPI devices | READ |
| R2 | Chairperson, SSH, in the proof of concept's environment | `python3 -m demo.healthcheck --backend tropic01` — opens a session on slot 0, prints the chip identity and both firmware versions, pings, and inspects ECC slot 0 "without being changed"; its docstring says "Every check here is read-only" [POC demo/healthcheck.py lines 4–6, 22–26; the calls at lines 160–260 are `pair_factory`, `chip_id`, `firmware_versions`, `ping`, `read_key_info`]. Save the full output. This answers question 3 (except the bootloader version, which the proof of concept never read [docs/tropic01.md lines 115–116]) and answer 4 | READ |
| R3 | Chairperson | Pairing-slot status. A session on slot 0 succeeding proves slot 0 is Valid. libtropic has a read-only `lt_pairing_key_read` for slots 0–3 [include/libtropic.h lines 333–343]; whether pytropicsquare has one is question 12.1.9. If neither is available on the Pi, this step is skipped and nothing is assumed about slots 1–3 | READ |
| R4 | Chairperson | `read_key_info` for ECC slots 0–31 [POC hw/tropic_wallet_hw.py lines 187–196]; an empty slot answers with an error [POC tests/hardware/test_tropic01_hil.py lines 327–330]. Record curve and origin per slot; confirms answer 8 | READ |
| R5 | Chairperson | Read the candidate User Data slot (if the SDK offers the read) | READ |
| R6 | Chairperson, optional | Read monotonic counters 0–15. The datasheet says a counter must be initialised before reading [DS §7.10.1 p.52]; what a read of an uninitialised counter returns is not stated | READ |
| R7 | Chairperson, optional | Read R-Config and I-Config (`lt_r_config_read`, `lt_i_config_read`, include/libtropic.h lines 368–436; pytropicsquare "exposes R-CONFIG and I-CONFIG registers" [POC docs/tropic01.md lines 395–404]) to learn whether anything was ever configured, maintenance mode included | READ |
| — | — | MAC-and-Destroy slots: **no read step exists**; they cannot be inspected without being overwritten (section 10.1). Their history is question 12.1.4 | — |

### 11.3 Rehearsal on the software model first

Tropic Square recommends starting with the TROPIC01 Model, which libtropic
documents as Linux only, macOS "TBA" (section 3.1). **Checked on this Mac on
2026-11-07** (nothing installed or started): `which docker colima podman
limactl` finds only `/usr/local/bin/docker`, a link into
`/Applications/Docker.app` (Docker Desktop 4.12.0, its client 20.10.17, built
2022); colima, podman and limactl are not installed; `docker version` reports
"Cannot connect to the Docker daemon … Is the docker daemon running?". So the
model cannot run on this Mac today without someone starting Docker Desktop,
and whether a 2022 Docker Desktop still starts on macOS 26.7.1 was not tried.
The options, each the Chairperson's call:

1. Start Docker Desktop (or update it) and run the model in a Linux container.
2. Run the model on the Raspberry Pi itself, which is Linux; whether it runs
   acceptably on a 3B+ is unverified.
3. A Linux virtual machine.

Two further gaps: whether pytropicsquare can talk to the model's TCP port is
not known (libtropic's TCP port can, section 3.1), and the model's PIN
behaviour has never been compared with the chip by this project. What can be
rehearsed with no model at all: everything except the chip, using the wallet's
own `cold-signer.mjs` with the public test phrase (its `selftest`), plus a
software stand-in for MAC_And_Destroy written from AN002 Appendix A, clearly
labelled as not the chip.

### 11.4 Prerequisites

- **Before any hardware step:** the signer program itself (section 10.11),
  written as a separate, reviewed slice in this repository, rehearsed with the
  public test phrase and the stand-in or the model. It does not exist today.
- **On the Pi** (the Chairperson installs; nothing here is installed by an
  agent): SPI enabled and the user in the `spi` and `gpio` groups [POC
  docs/hardware-bringup.md lines 42–60]; the proof of concept's Python
  environment with `requirements-hardware.txt`; Node.js (version to be agreed,
  question 12.1.9); the signer program and the engine's built packages copied
  from the Mac (building on the Pi is not needed).
- **Peripherals:** none for the first demo (option d). For the air-gapped
  version: a display, a camera and a keypad (question 12.1.8).
- **Test funds:** about 0.001 Sepolia ETH for the device address, sent by the
  CTO from the dev EOA with `scripts/testnet/fund.mjs`.

### 11.5 The smallest live demo: one Sepolia send, prepared on the emulator, signed on the Pi, broadcast from the wallet

| Step | Who | What | Class |
|---|---|---|---|
| P1 | Chairperson | Confirm the agreed MAC-and-Destroy slots and User Data slot (section 10.8) | — |
| P2 | Chairperson, SSH | Generate the device phrase (OS entropy mixed with `Random_Value_Get`), write it down, derive and show the address at m/44'/60'/0'/0/0 | READ (the random read changes nothing) |
| P3 | Chairperson, SSH | PIN set-up on the agreed slots per AN002 §3.4 (3n MAC_And_Destroy calls); seal the seed; erase and write the agreed User Data slot | CONSUMES |
| P4 | Chairperson, SSH | Unseal once with the correct PIN; the address must match P2 | CONSUMES (one slot used, re-initialised on success) |
| P5 | Chairperson, SSH | One deliberately wrong PIN: no key, attempts 8 → 7; then the correct PIN: attempts back to 8 | CONSUMES (restored) |
| D1 | agent, emulator | Watch the device address in the wallet ("Watch an address"; 0 prompts, as in pass p22b) | — |
| D2 | CTO, Mac | Fund the device address with about 0.001 Sepolia ETH (`fund.mjs`) | — |
| D3 | agent, emulator | "Send with an off-line signer": 0.0001 test ETH to Account 2 (an address already used, so no first-transfer surcharge); copy the request text (one QR code's worth, about 696 bytes) | — |
| D4 | Chairperson | Move the request text to the Pi over SSH (option d: not air-gapped, stated) | — |
| D5 | Chairperson, SSH | The signer refuses or shows (section 10.5); the Chairperson types the amount, then the PIN; the signer unseals, derives, checks the address equals `from`, signs, normalises s, verifies, erases, prints the signature payload | CONSUMES (one slot, re-initialised on success) |
| D6 | agent, emulator | Paste the signature; expect "Signature checked: made by the watched address … over exactly the transaction shown above." (cold-signing.ts line 645); Broadcast | — |
| D7 | agent | Read the receipt and both balances on two RPCs; reconcile to the wei | — |
| N1 | Chairperson | A request whose chain id is 1 is refused on the Pi before the PIN is asked | READ |
| N2 | Chairperson | A request with one character of `signingHash` changed is refused on the Pi before the PIN | READ |
| N3 | Chairperson | A wrong PIN produces no signature | CONSUMES (restored by the next correct PIN) |
| C1 | all | Sweep the test funds back with one more cold-signed send; remove the watched account | CONSUMES (one slot, restored) |
| C2 | Chairperson | Keep the sealed set-up for the next demo, or erase the agreed User Data slot (the paper phrase restores the address either way) | CONSUMES |
| — | — | Writing or invalidating a pairing key; any configuration write; a firmware update; libtropic's functional tests; the proof of concept's destructive tests; touching ECC slots 0–1; the spare chip | **FORBIDDEN** |

**What the demo would prove:** that a secp256k1 key sealed by the chip's
MAC-and-Destroy engine can sign the wallet's own cold-signing request on a
public test network, with the attempt limit enforced by the chip and the
phone unchanged. **What it would not prove:** that the Pi's display or memory
can be trusted, that the device is air-gapped (option d is not), anything
about physical attacks (section 2.14), or anything about main networks.

## 12. Remaining questions after the 2026-11-07 answers

### 12.1 For the Chairperson

1. **The chip's identity.** Please run step R2 (section 11.2) and keep the
   output; the part number, the firmware versions and, if any tool prints it,
   the bootloader version are still not recorded (answer 3).
2. **The firmware update (answer 4).** When was it done, with which program,
   and to which versions? The proof of concept read application firmware
   2.0.0.0 and SPECT 1.0.0.0 on 2026-09-20 and never updated it.
3. **Other programs.** Has anything other than the proof of concept ever run
   against this chip — libtropic's examples, `lt-util`, a vendor tool, and in
   particular libtropic's functional tests?
4. **The earlier PIN run.** The Stage 1 plan says the PIN ("MAC-and-destroy")
   feature was driven successfully before; the proof of concept never called
   it. Did that run happen, with which program, on which MAC-and-Destroy
   slots, and does any data from it (on the SD card or in a User Data slot)
   need keeping? Those slots cannot be read to find out (section 10.1).
5. **The slot plan (section 10.8).** Agree MAC-and-Destroy slots 120–127 (or
   others), one User Data slot, and that ECC slots 0 and 1 are kept.
6. **Pairing.** Confirm that the demo stays on factory slot 0 and that no
   pairing key is written (section 10.7).
7. **The first demo's channel.** Accept option (d), where the device phrase,
   the approval and the PIN pass through an SSH session from the Mac, for a
   throwaway phrase and test funds only — or attach a display and keyboard
   first?
8. **Peripherals for the air-gapped version.** Which display, camera and
   keypad or keyboard to attach to the 3B+ (answer 11: "plenty of peripherals
   available"), and may the Pi's network be switched off once they are?
9. **Software on the Pi.** Node.js on the Pi for the signer logic, with a
   Python helper for the chip (section 10.11) — acceptable? And may an agent
   read the installed pytropicsquare source on the Pi (or the Chairperson send
   its version) to settle which calls it offers: User Data read and write,
   pairing-key read, counter read, configuration read, a TCP transport for the
   model?
10. **The Pi's clock.** An air-gapped Pi has no network time. Is a real-time
    clock module available (needed before smart-account requests, whose expiry
    the signer checks), or should format 2 wait?
11. **The model rehearsal (section 11.3).** Start or update Docker Desktop on
    the Mac, run the model on the Pi, or skip the model and rehearse with the
    software stand-in?
12. **Funds and limits.** Agree the per-request cap (section 10.9) and the most
    the device address may hold (proposed 0.002 Sepolia ETH).
13. **ADR D1.** Accept that the device's key comes from the device's own
    phrase, not the phone's (section 10.6).
14. **Who runs what.** Confirm that the Chairperson runs every chip command,
    or name the read-only steps an agent may run over SSH.
15. **The product.** For option (b): build a microcontroller device, partner
    with a maker, or both? Is there a written record of the custom-firmware
    conversation with Tropic Square that the proof of concept mentions
    (question 12.2.1)?

### 12.2 For Tropic Square (adding to section 1.2)

1. **secp256k1.** The proof of concept records that custom application
   firmware is "available on request" [POC ARCHITECTURE_DECISIONS.md lines
   13–15]. Does that include secp256k1 on SPECT, on which silicon, and under
   what terms?
2. **Licence of the SPECT firmware.** Stage 1 read the Clear BSD licence in
   `ts-spect-fw` at 3b4681ca (section 2.14); the proof of concept records
   Apache 2.0 [POC ARCHITECTURE_DECISIONS.md line 25; docs/tropic01.md lines
   29–30]. Which applies, and did it change?
3. **Monotonic counters.** May `MCounter_Init` be issued again at any time on a
   counter that is already initialised (the datasheet's "option to reset",
   DS §7.10 p.52), and what does `MCounter_Get` return for a counter never
   initialised?
4. **Bootloader version.** Which command or tool reads it?
5. **Erratum OI_TR01_ERR_2026010800.** Which part numbers and firmware versions
   does it affect?
6. **The Raspberry Pi 3B+** with libtropic's Linux SPI port (section 1.2
   question 5 stands).

### 12.3 Not verified in this Stage 2 design

- Nothing in sections 10 and 11 has been built or run.
- Whether the chip's MAC-and-Destroy behaves as AN002 describes on this board
  (the proof of concept never called it).
- Whether pytropicsquare 0.0.3 offers the User Data, pairing-read, counter and
  configuration calls, and whether it can reach the software model.
- Whether Node v24.21.0 and the engine run on the 3B+; whether the model runs on
  the 3B+ or in Docker Desktop 4.12.0 on this Mac.
- The AN002 host-data sizes (the "about 390 bytes" figure is this document's
  arithmetic, not AN002's).
- Whether the WebAuthn path of section 4 role (b) works (unchanged from Stage 1).
- Today's state of the chip: everything in answers 3, 4, 6, 7 and 8 that the
  read-only steps of section 11.2 have not yet confirmed.

## 13. Sources added on 2026-11-07

- [POC] The Chairperson's proof-of-concept repository `tropic_wallet_poc`,
  read read-only at commit 5025353 (branch
  `device-split-and-hardware-validation`, 2026-09-26; history of eight commits
  from 2026-09-20): README.md, ARCHITECTURE_DECISIONS.md, docs/security-status.md,
  docs/known-limitations.md, docs/tropic01.md, docs/pairing-key-plan.md,
  docs/firmware.md, docs/progress.md, docs/testing.md, docs/hardware-bringup.md,
  docs/decisions/0001–0005, hw/tropic_wallet_hw.py, hw/transport_config.py,
  device/confirm.py, device/policy.py, device/signer.py,
  device/backends/tropic01.py, host/client.py, demo/healthcheck.py,
  demo/run.sh, tests/hardware/test_tropic01_hil.py, requirements*.txt. None of
  its code was run; no key from it is copied here.
- [DS] the datasheet Rev. A.11, fetched again (SHA-256 prefix
  ae647fa59ace0f38, equal to section 8): §7.1.1, §7.1.2, §7.5.3, §7.9,
  §7.10, §7.11 and page 32.
- [AN002] PIN Verification v1.2, fetched again (014fd5457d8df419, equal to
  section 8): §3.2–§3.3 p.6, §3.5 p.11, §3.7 p.13, Appendix B p.21.
- [AN006] Configuration Objects Application Note v1.3
  (doc/application_notes/ODN_TR01_app_006_config_obj_1v3.pdf, SHA-256 prefix
  09bcdcfe98d4615d): pp.8, 10, 13, 18.
- [AN007] Firmware Update v1.5, fetched again (5f96cc4507e1c61a, equal to
  section 8): pp.3, 8, 10.
- [LT] libtropic `include/libtropic.h` at tag v4.2.0 (SHA-256 prefix
  8222345edde8a586): lines 333–436 (pairing-key read and invalidation,
  R-Config and I-Config), 596–652 (counters, MAC-and-Destroy).
- This repository at HEAD 117e72c: `app/src/wallet/cold-signing.ts`,
  `app/src/wallet/cold-aa.ts`, `app/src/wallet/qr-parts.ts`,
  `app/src/wallet/multisig.ts`, `packages/chains-evm/src/cold-userop.ts`,
  `packages/chains-evm/src/kernel-multisig.ts`,
  `packages/chains-evm/src/eoa-tx.ts`, `packages/chains-evm/src/smart-account.ts`,
  `scripts/testnet/cold-signer.mjs`, `AGENTS.md`.
- This Mac, 2026-11-07: `which docker colima podman limactl`, `docker
  version` (section 11.3).
