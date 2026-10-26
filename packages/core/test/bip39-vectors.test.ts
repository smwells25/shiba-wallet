import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { wordlist as czech } from '@scure/bip39/wordlists/czech.js';
import { wordlist as french } from '@scure/bip39/wordlists/french.js';
import { wordlist as italian } from '@scure/bip39/wordlists/italian.js';
import { wordlist as japanese } from '@scure/bip39/wordlists/japanese.js';
import { wordlist as korean } from '@scure/bip39/wordlists/korean.js';
import { wordlist as portuguese } from '@scure/bip39/wordlists/portuguese.js';
import { wordlist as simplifiedChinese } from '@scure/bip39/wordlists/simplified-chinese.js';
import { wordlist as spanish } from '@scure/bip39/wordlists/spanish.js';
import { wordlist as traditionalChinese } from '@scure/bip39/wordlists/traditional-chinese.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { HDNodeWallet } from 'ethers';
import { derivePath as refDerivePath } from 'ed25519-hd-key';
import { isValidMnemonic, mnemonicToSeed } from '../src/keyring/mnemonic.js';
import { HdKeyring } from '../src/keyring/keyring.js';
import { ChainRegistry } from '../src/registry/registry.js';
import { evmKeyProvider } from '../src/chains/evm.js';
import { bitcoinKeyProvider, dogecoinKeyProvider } from '../src/chains/utxo.js';
import { solanaKeyProvider } from '../src/chains/solana.js';

/**
 * BIP-39's official test vectors, run through the wallet's own code path.
 *
 * Source of the specification: bitcoin/bips bip-0039.mediawiki at commit
 * 0d1b892ddb21c22def4af4541bfed7a2a3480e4a (fetched 2026-10-25; the file's
 * sha256 is afcbcbed36fe9eb734bd607398a8c124683ded2a75c3830e1b16c47b043a9134).
 * Its "Test vectors" section reads: "The test vectors include input entropy,
 * mnemonic and seed. The passphrase "TREZOR" is used for all vectors." and
 * links https://github.com/trezor/python-mnemonic/blob/master/vectors.json.
 *
 * Source of the vectors: trezor/python-mnemonic vectors.json at commit
 * b57a5ad77a981e743f4167ab2f7927a55c1e82a8 (the newest commit touching the
 * file when fetched on 2026-10-25; the file's sha256 is
 * fa3b937b7cff9c9b8ecd3aa011faeb8d6dd67993174b72326e83f4de8fdb30f8, 152,400
 * bytes). It holds 24 vectors for each of 12 languages, each entry being
 * [entropy, mnemonic, seed, xprv]. Before writing this file all 288 seeds
 * were recomputed off-line as PBKDF2-HMAC-SHA512(NFKD(mnemonic),
 * NFKD("mnemonic" + "TREZOR"), 2048) and every one matched, which confirms
 * the specification's statement that "TREZOR" is the passphrase of every
 * vector in this file.
 *
 * Every ENGLISH vector (all 24) is tested below: entropy → mnemonic, the
 * mnemonic plus "TREZOR" → the 64-byte seed through the wallet's own
 * mnemonicToSeed and HdKeyring.fromMnemonic, the seed → the vector's BIP-32
 * root key (xprv), and the wallet's derived Ethereum, Bitcoin, Dogecoin and
 * Solana accounts against an independent derivation (ethers from the
 * official xprv; ed25519-hd-key from the official seed).
 *
 * The other 11 languages are NOT run as vectors: the wallet accepts only the
 * English wordlist (isValidMnemonic in src/keyring/mnemonic.ts), so its
 * mnemonicToSeed refuses them by design. A separate check below records
 * that refusal for the nine languages @scure/bip39 ships a wordlist for and
 * whose vectors use the same 24 entropies as the English ones (Russian and
 * Turkish use other entropies and have no @scure/bip39 wordlist). Because
 * every English mnemonic and "TREZOR" are plain ASCII, these vectors cannot
 * detect a missing NFKD normalisation; that rule lives in @scure/bip39
 * (psalt / nfkd); the one check that reaches it through the wallet is the
 * fullwidth-passphrase check below, which follows from the specification's
 * NFKD rule rather than from a published vector.
 *
 * The mnemonics are pinned by their entropy and by the SHA-256 of each
 * official mnemonic text (UTF-8, words joined by single spaces, as in
 * vectors.json), never as literal words: the repository's pre-commit secret
 * scan (scripts/githooks/secret-scan.mjs) refuses any checksum-valid BIP-39
 * phrase in a file, and these public vectors are no exception. The wallet
 * itself has no entropy-to-mnemonic function (createMnemonic draws its own
 * entropy), so the mnemonic is rebuilt with @scure/bip39's entropyToMnemonic
 * over the same English wordlist the wallet validates with, and compared to
 * the official text through its fingerprint.
 */
const PASSPHRASE = 'TREZOR';
/** "TREZOR" in fullwidth letters (U+FF34 U+FF32 U+FF25 U+FF3A U+FF2F U+FF32). */
const FULLWIDTH_TREZOR = '\uff34\uff32\uff25\uff3a\uff2f\uff32';

/** SHA-256 of the 24 official English mnemonics joined by "\n", in file order. */
const ENGLISH_MNEMONICS_SHA256 =
  'fa7795219899de6fe38d068d79c96ee7fb7a4c021337e041dee1c6c0eb4ec3f5';

const VECTORS = [
  {
    entropy: '00000000000000000000000000000000',
    mnemonicSha256: 'c557eec878dfd852ba3f88087c4f350f09c55537ab5e549c3cd14320ec3cef38',
    seed:
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    xprv: 'xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF',
  },
  {
    entropy: '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    mnemonicSha256: 'ecb0e7ba498c5920991f0b3483e91f7abafa9ecc6bd82a9a51494589592b1a8f',
    seed:
      '2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607',
    xprv: 'xprv9s21ZrQH143K2gA81bYFHqU68xz1cX2APaSq5tt6MFSLeXnCKV1RVUJt9FWNTbrrryem4ZckN8k4Ls1H6nwdvDTvnV7zEXs2HgPezuVccsq',
  },
  {
    entropy: '80808080808080808080808080808080',
    mnemonicSha256: '3a64bcd9cea43c0aba67ba0bf2ddff8137a492bccbc672107fcbf7381086f698',
    seed:
      'd71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8',
    xprv: 'xprv9s21ZrQH143K2shfP28KM3nr5Ap1SXjz8gc2rAqqMEynmjt6o1qboCDpxckqXavCwdnYds6yBHZGKHv7ef2eTXy461PXUjBFQg6PrwY4Gzq',
  },
  {
    entropy: 'ffffffffffffffffffffffffffffffff',
    mnemonicSha256: '3c0949435a7e4277fac2fbe27975cdd9f5b5abf94d282112eaf4cebbb8560984',
    seed:
      'ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069',
    xprv: 'xprv9s21ZrQH143K2V4oox4M8Zmhi2Fjx5XK4Lf7GKRvPSgydU3mjZuKGCTg7UPiBUD7ydVPvSLtg9hjp7MQTYsW67rZHAXeccqYqrsx8LcXnyd',
  },
  {
    entropy: '000000000000000000000000000000000000000000000000',
    mnemonicSha256: '29aedb051d65bcc80e3379acb13afb2a0807f5f4bbb346a9846c056720e0a7cd',
    seed:
      '035895f2f481b1b0f01fcf8c289c794660b289981a78f8106447707fdd9666ca06da5a9a565181599b79f53b844d8a71dd9f439c52a3d7b3e8a79c906ac845fa',
    xprv: 'xprv9s21ZrQH143K3mEDrypcZ2usWqFgzKB6jBBx9B6GfC7fu26X6hPRzVjzkqkPvDqp6g5eypdk6cyhGnBngbjeHTe4LsuLG1cCmKJka5SMkmU',
  },
  {
    entropy: '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    mnemonicSha256: 'e770e8aa42a869cf269a5bda331f706a08e02a6223ffbd28d71580e2101e02a4',
    seed:
      'f2b94508732bcbacbcc020faefecfc89feafa6649a5491b8c952cede496c214a0c7b3c392d168748f2d4a612bada0753b52a1c7ac53c1e93abd5c6320b9e95dd',
    xprv: 'xprv9s21ZrQH143K3Lv9MZLj16np5GzLe7tDKQfVusBni7toqJGcnKRtHSxUwbKUyUWiwpK55g1DUSsw76TF1T93VT4gz4wt5RM23pkaQLnvBh7',
  },
  {
    entropy: '808080808080808080808080808080808080808080808080',
    mnemonicSha256: '15f41342748aa6c0718a6f4fa4e153acf61aa4dc073a6e77347fa2e4ef639162',
    seed:
      '107d7c02a5aa6f38c58083ff74f04c607c2d2c0ecc55501dadd72d025b751bc27fe913ffb796f841c49b1d33b610cf0e91d3aa239027f5e99fe4ce9e5088cd65',
    xprv: 'xprv9s21ZrQH143K3VPCbxbUtpkh9pRG371UCLDz3BjceqP1jz7XZsQ5EnNkYAEkfeZp62cDNj13ZTEVG1TEro9sZ9grfRmcYWLBhCocViKEJae',
  },
  {
    entropy: 'ffffffffffffffffffffffffffffffffffffffffffffffff',
    mnemonicSha256: 'c1db187b992c8ddddbe9dfab0e88542e9af36e1816c0d4c70353cd1175159bd9',
    seed:
      '0cd6e5d827bb62eb8fc1e262254223817fd068a74b5b449cc2f667c3f1f985a76379b43348d952e2265b4cd129090758b3e3c2c49103b5051aac2eaeb890a528',
    xprv: 'xprv9s21ZrQH143K36Ao5jHRVhFGDbLP6FCx8BEEmpru77ef3bmA928BxsqvVM27WnvvyfWywiFN8K6yToqMaGYfzS6Db1EHAXT5TuyCLBXUfdm',
  },
  {
    entropy: '0000000000000000000000000000000000000000000000000000000000000000',
    mnemonicSha256: '69be79ef3c28f55d7cb84db2dd3c18dfff45eeefebd09b8c5f7f3489b8ba09ac',
    seed:
      'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',
    xprv: 'xprv9s21ZrQH143K32qBagUJAMU2LsHg3ka7jqMcV98Y7gVeVyNStwYS3U7yVVoDZ4btbRNf4h6ibWpY22iRmXq35qgLs79f312g2kj5539ebPM',
  },
  {
    entropy: '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    mnemonicSha256: '3b1c5e02107409ea60548d8d8f686fd8d722791f3618deb1f9eb1e9f5c02cd35',
    seed:
      'bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87',
    xprv: 'xprv9s21ZrQH143K3Y1sd2XVu9wtqxJRvybCfAetjUrMMco6r3v9qZTBeXiBZkS8JxWbcGJZyio8TrZtm6pkbzG8SYt1sxwNLh3Wx7to5pgiVFU',
  },
  {
    entropy: '8080808080808080808080808080808080808080808080808080808080808080',
    mnemonicSha256: 'a5fe1cb4158ffd2a27ae93b5ac617903504c3ec9d8f6ac9737ecc207cb460e72',
    seed:
      'c0c519bd0e91a2ed54357d9d1ebef6f5af218a153624cf4f2da911a0ed8f7a09e2ef61af0aca007096df430022f7a2b6fb91661a9589097069720d015e4e982f',
    xprv: 'xprv9s21ZrQH143K3CSnQNYC3MqAAqHwxeTLhDbhF43A4ss4ciWNmCY9zQGvAKUSqVUf2vPHBTSE1rB2pg4avopqSiLVzXEU8KziNnVPauTqLRo',
  },
  {
    entropy: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    mnemonicSha256: 'e96bfc1d78867126dadff72e64807301e9bb837bcf329c86976647e529520528',
    seed:
      'dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad',
    xprv: 'xprv9s21ZrQH143K2WFF16X85T2QCpndrGwx6GueB72Zf3AHwHJaknRXNF37ZmDrtHrrLSHvbuRejXcnYxoZKvRquTPyp2JiNG3XcjQyzSEgqCB',
  },
  {
    entropy: '9e885d952ad362caeb4efe34a8e91bd2',
    mnemonicSha256: 'd6da54d12db9eac818868b841c1c9cc7c39f5294c8620ad24b7715b7820febc0',
    seed:
      '274ddc525802f7c828d8ef7ddbcdc5304e87ac3535913611fbbfa986d0c9e5476c91689f9c8a54fd55bd38606aa6a8595ad213d4c9c9f9aca3fb217069a41028',
    xprv: 'xprv9s21ZrQH143K2oZ9stBYpoaZ2ktHj7jLz7iMqpgg1En8kKFTXJHsjxry1JbKH19YrDTicVwKPehFKTbmaxgVEc5TpHdS1aYhB2s9aFJBeJH',
  },
  {
    entropy: '6610b25967cdcca9d59875f5cb50b0ea75433311869e930b',
    mnemonicSha256: 'b12ee277a669b18fb7c5d9d3642c9298ce06f0814a4166a6396ad9cb2eccc914',
    seed:
      '628c3827a8823298ee685db84f55caa34b5cc195a778e52d45f59bcf75aba68e4d7590e101dc414bc1bbd5737666fbbef35d1f1903953b66624f910feef245ac',
    xprv: 'xprv9s21ZrQH143K3uT8eQowUjsxrmsA9YUuQQK1RLqFufzybxD6DH6gPY7NjJ5G3EPHjsWDrs9iivSbmvjc9DQJbJGatfa9pv4MZ3wjr8qWPAK',
  },
  {
    entropy: '68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c',
    mnemonicSha256: '341c225b06c91708aa82ab8389075a8227fda76fb2b9cae2d445e36ca8c44da1',
    seed:
      '64c87cde7e12ecf6704ab95bb1408bef047c22db4cc7491c4271d170a1b213d20b385bc1588d9c7b38f1b39d415665b8a9030c9ec653d75e65f847d8fc1fc440',
    xprv: 'xprv9s21ZrQH143K2XTAhys3pMNcGn261Fi5Ta2Pw8PwaVPhg3D8DWkzWQwjTJfskj8ofb81i9NP2cUNKxwjueJHHMQAnxtivTA75uUFqPFeWzk',
  },
  {
    entropy: 'c0ba5a8e914111210f2bd131f3d5e08d',
    mnemonicSha256: '6d828debd306e21a02511899832f7ee5591de0693b2f2bd78967fb1e09bafdbb',
    seed:
      'ea725895aaae8d4c1cf682c1bfd2d358d52ed9f0f0591131b559e2724bb234fca05aa9c02c57407e04ee9dc3b454aa63fbff483a8b11de949624b9f1831a9612',
    xprv: 'xprv9s21ZrQH143K3FperxDp8vFsFycKCRcJGAFmcV7umQmcnMZaLtZRt13QJDsoS5F6oYT6BB4sS6zmTmyQAEkJKxJ7yByDNtRe5asP2jFGhT6',
  },
  {
    entropy: '6d9be1ee6ebd27a258115aad99b7317b9c8d28b6d76431c3',
    mnemonicSha256: 'cc95a8a1b5e9bf130a4468b1b4857b6a7fc64979970a06b806cb879460d15348',
    seed:
      'fd579828af3da1d32544ce4db5c73d53fc8acc4ddb1e3b251a31179cdb71e853c56d2fcb11aed39898ce6c34b10b5382772db8796e52837b54468aeb312cfc3d',
    xprv: 'xprv9s21ZrQH143K3R1SfVZZLtVbXEB9ryVxmVtVMsMwmEyEvgXN6Q84LKkLRmf4ST6QrLeBm3jQsb9gx1uo23TS7vo3vAkZGZz71uuLCcywUkt',
  },
  {
    entropy: '9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863',
    mnemonicSha256: '30452ba5605dd25289bc2ae7b1883a53b1cece62e2331fa105b88c9682dd37c7',
    seed:
      '72be8e052fc4919d2adf28d5306b5474b0069df35b02303de8c1729c9538dbb6fc2d731d5f832193cd9fb6aeecbc469594a70e3dd50811b5067f3b88b28c3e8d',
    xprv: 'xprv9s21ZrQH143K2WNnKmssvZYM96VAr47iHUQUTUyUXH3sAGNjhJANddnhw3i3y3pBbRAVk5M5qUGFr4rHbEWwXgX4qrvrceifCYQJbbFDems',
  },
  {
    entropy: '23db8160a31d3e0dca3688ed941adbf3',
    mnemonicSha256: 'b2e71100d10bee74156b69806498a2e3d90e432160c2e266465ba669a220d50b',
    seed:
      'deb5f45449e615feff5640f2e49f933ff51895de3b4381832b3139941c57b59205a42480c52175b6efcffaa58a2503887c1e8b363a707256bdd2b587b46541f5',
    xprv: 'xprv9s21ZrQH143K4G28omGMogEoYgDQuigBo8AFHAGDaJdqQ99QKMQ5J6fYTMfANTJy6xBmhvsNZ1CJzRZ64PWbnTFUn6CDV2FxoMDLXdk95DQ',
  },
  {
    entropy: '8197a4a47f0425faeaa69deebc05ca29c0a5b5cc76ceacc0',
    mnemonicSha256: 'b8ae5c99142647d1043595539d615197ee7dad5e7c031d5447e78c69e62ba01f',
    seed:
      '4cbdff1ca2db800fd61cae72a57475fdc6bab03e441fd63f96dabd1f183ef5b782925f00105f318309a7e9c3ea6967c7801e46c8a58082674c860a37b93eda02',
    xprv: 'xprv9s21ZrQH143K3wtsvY8L2aZyxkiWULZH4vyQE5XkHTXkmx8gHo6RUEfH3Jyr6NwkJhvano7Xb2o6UqFKWHVo5scE31SGDCAUsgVhiUuUDyh',
  },
  {
    entropy: '066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad',
    mnemonicSha256: '0f388b04e512d7a0eda5889c96ff034cf63499b73898965a8e187e3a8a25d198',
    seed:
      '26e975ec644423f4a4c4f4215ef09b4bd7ef924e85d1d17c4cf3f136c2863cf6df0a475045652c57eb5fb41513ca2a2d67722b77e954b4b3fc11f7590449191d',
    xprv: 'xprv9s21ZrQH143K3rEfqSM4QZRVmiMuSWY9wugscmaCjYja3SbUD3KPEB1a7QXJoajyR2T1SiXU7rFVRXMV9XdYVSZe7JoUXdP4SRHTxsT1nzm',
  },
  {
    entropy: 'f30f8c1da665478f49b001d94c5fc452',
    mnemonicSha256: 'b1bff22ae077ce1ae482e4dcb01c144ff8a44e97fbb3f3a5f62567f4ac19da7c',
    seed:
      '2aaa9242daafcee6aa9d7269f17d4efe271e1b9a529178d7dc139cd18747090bf9d60295d0ce74309a78852a9caadf0af48aae1c6253839624076224374bc63f',
    xprv: 'xprv9s21ZrQH143K2QWV9Wn8Vvs6jbqfF1YbTCdURQW9dLFKDovpKaKrqS3SEWsXCu6ZNky9PSAENg6c9AQYHcg4PjopRGGKmdD313ZHszymnps',
  },
  {
    entropy: 'c10ec20dc3cd9f652c7fac2f1230f7a3c828389a14392f05',
    mnemonicSha256: '662c451cc5886e1d6f185f418b815a175bfd197536556607272b36fdefa8c969',
    seed:
      '7b4a10be9d98e6cba265566db7f136718e1398c71cb581e1b2f464cac1ceedf4f3e274dc270003c670ad8d02c4558b2f8e39edea2775c9e232c7cb798b069e88',
    xprv: 'xprv9s21ZrQH143K4aERa2bq7559eMCCEs2QmmqVjUuzfy5eAeDX4mqZffkYwpzGQRE2YEEeLVRoH4CSHxianrFaVnMN2RYaPUZJhJx8S5j6puX',
  },
  {
    entropy: 'f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f',
    mnemonicSha256: '867f9f5929a7201c1116579e17be6ce501f8a8c5a8d0d1ac7173d72ae78fd945',
    seed:
      '01f5bced59dec48e362f2c45b5de68b9fd6c92c6634f44d6d40aab69056506f0e35524a518034ddc1192e1dacd32c1ed3eaa3c3b131c88ed8e7e54c49a5d0998',
    xprv: 'xprv9s21ZrQH143K39rnQJknpH1WEPFJrzmAqqasiDcVrNuk926oizzJDDQkdiTvNPr2FYDYzWgiMiC63YmfPAa2oPyNB23r2g7d1yiK6WpqaQS',
  },
] as const;

// Paths fixed here as literals (not read from the providers), so a changed
// derivation path in the wallet fails the comparison.
const EVM_PATH = "m/44'/60'/0'/0/0";
const BTC_PATH = "m/84'/0'/0'/0/0";
const DOGE_PATH = "m/44'/3'/0'/0/0";
const SOL_PATH = "m/44'/501'/0'/0'";

// The account check derives four chains twice (the wallet and the reference)
// and took up to 2.2 s per vector in a loaded CI run (load average about 140);
// vitest's default 5 s limit is too close for that, so these two tests get 20 s.
const SLOW_TEST_TIMEOUT_MS = 20_000;

function mnemonicOf(entropyHex: string): string {
  return entropyToMnemonic(hexToBytes(entropyHex), english);
}

function registry(): ChainRegistry {
  const r = new ChainRegistry();
  r.register(evmKeyProvider);
  r.register(bitcoinKeyProvider);
  r.register(dogecoinKeyProvider);
  r.register(solanaKeyProvider);
  return r;
}

describe('BIP-39 official vectors (passphrase "TREZOR") through the wallet', () => {
  it('uses every English vector of the pinned file', () => {
    expect(VECTORS.length).toBe(24);
    const words = VECTORS.map((v) => mnemonicOf(v.entropy).split(' ').length);
    expect(words.filter((n) => n === 12).length).toBe(8);
    expect(words.filter((n) => n === 18).length).toBe(8);
    expect(words.filter((n) => n === 24).length).toBe(8);
    const joined = VECTORS.map((v) => mnemonicOf(v.entropy)).join('\n');
    expect(bytesToHex(sha256(utf8ToBytes(joined)))).toBe(ENGLISH_MNEMONICS_SHA256);
  });

  for (const [i, v] of VECTORS.entries()) {
    describe(`vector ${i} (entropy ${v.entropy.slice(0, 8)}…, ${v.entropy.length * 4} bits)`, () => {
      const mnemonic = mnemonicOf(v.entropy);

      it('entropy → the official mnemonic, accepted by the wallet', () => {
        expect(bytesToHex(sha256(utf8ToBytes(mnemonic)))).toBe(v.mnemonicSha256);
        expect(isValidMnemonic(mnemonic)).toBe(true);
      });

      it('mnemonic + "TREZOR" → the official seed (mnemonicToSeed)', () => {
        const seed = mnemonicToSeed(mnemonic, PASSPHRASE);
        expect(seed.length).toBe(64);
        expect(bytesToHex(seed)).toBe(v.seed);
        // The empty passphrase (the wallet every user has today) is another seed.
        expect(bytesToHex(mnemonicToSeed(mnemonic))).not.toBe(v.seed);
      });

      it('the passphrase is NFKD-normalised: fullwidth "ＴＲＥＺＯＲ" gives the same seed', () => {
        // BIP-39: the salt is "mnemonic" + passphrase in UTF-8 NFKD. The
        // fullwidth letters U+FF34 U+FF32 U+FF25 U+FF3A U+FF2F U+FF32 are a
        // compatibility form whose NFKD is the ASCII "TREZOR", so the
        // official seed must come out. This is the only part of these
        // vectors that reaches the NFKD rule (every English mnemonic and
        // "TREZOR" itself are ASCII).
        expect(FULLWIDTH_TREZOR).not.toBe(PASSPHRASE);
        expect(FULLWIDTH_TREZOR.normalize('NFKD')).toBe(PASSPHRASE);
        expect(bytesToHex(mnemonicToSeed(mnemonic, FULLWIDTH_TREZOR))).toBe(v.seed);
      });

      it('seed → the official BIP-32 root key (xprv)', () => {
        const root = HDKey.fromMasterSeed(mnemonicToSeed(mnemonic, PASSPHRASE));
        expect(root.privateExtendedKey).toBe(v.xprv);
      });

      it('HdKeyring.fromMnemonic(…, "TREZOR") derives the accounts of the official root', () => {
        const keyring = HdKeyring.fromMnemonic(mnemonic, registry(), PASSPHRASE);
        const ref = HDNodeWallet.fromExtendedKey(v.xprv);
        if (!(ref instanceof HDNodeWallet)) throw new Error('xprv did not parse as a private node');

        const evm = keyring.getAccount(evmKeyProvider.chainId);
        expect(evm.path).toBe(EVM_PATH);
        expect(evm.address).toBe(ref.derivePath(EVM_PATH).address);

        const btc = keyring.getAccount(bitcoinKeyProvider.chainId);
        expect(btc.path).toBe(BTC_PATH);
        expect('0x' + bytesToHex(btc.publicKey)).toBe(ref.derivePath(BTC_PATH).publicKey);

        const doge = keyring.getAccount(dogecoinKeyProvider.chainId);
        expect(doge.path).toBe(DOGE_PATH);
        expect('0x' + bytesToHex(doge.publicKey)).toBe(ref.derivePath(DOGE_PATH).publicKey);

        const sol = keyring.getAccount(solanaKeyProvider.chainId);
        expect(sol.path).toBe(SOL_PATH);
        const solRef = refDerivePath(SOL_PATH, v.seed);
        expect(bytesToHex(sol.publicKey)).toBe(bytesToHex(ed25519.getPublicKey(solRef.key)));
        keyring.wipe();
      }, SLOW_TEST_TIMEOUT_MS);
    });
  }

  it('refuses the same entropies in the nine other wordlists (the wallet is English-only)', () => {
    const lists = {
      czech,
      french,
      italian,
      japanese,
      korean,
      portuguese,
      simplifiedChinese,
      spanish,
      traditionalChinese,
    };
    for (const [name, list] of Object.entries(lists)) {
      for (const v of VECTORS) {
        const foreign = entropyToMnemonic(hexToBytes(v.entropy), list);
        expect(isValidMnemonic(foreign), `${name} ${v.entropy}`).toBe(false);
        expect(() => mnemonicToSeed(foreign, PASSPHRASE)).toThrow(/Invalid BIP-39/);
      }
    }
  }, SLOW_TEST_TIMEOUT_MS);
});
