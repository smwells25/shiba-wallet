import { concatBytes } from '@noble/hashes/utils.js';
import { toChecksumAddress, type DerivedAccount } from '@shiba-wallet/core';
import { encodeFunctionCall, encodeSequence, type AbiValue } from './abi.js';
import { keccak, toBytes, toHex, toWord } from './encoding.js';
import type { JsonRpcTransport } from './rpc.js';
import {
  toEthSignedMessageHash,
  withEthereumV,
  type Call,
  type SmartAccountSpec,
} from './smart-account.js';
import { ENTRYPOINT_V07, computeCreate2Address } from './userop.js';

/**
 * SmartAccountSpec for ZeroDev Kernel v3.3, an ERC-7579 modular smart
 * account, with the ECDSA validator installed as the ROOT validator and the
 * wallet's seed-derived EOA as its owner (ADR D1: the seed phrase stays the
 * root of recovery; the counterfactual address is a pure function of the
 * owner address, the index, and the pinned deployment below).
 *
 * Every fact below was taken from primary sources fetched 2026-10-01:
 *
 *  [K] github.com/zerodevapp/kernel, tag v3.3, commit
 *      cd697c7e21715d015e0643af22310a99aa17433b (the latest v3.x tag; the
 *      default branch is now Kernel v4, which targets EntryPoint v0.9 and is
 *      NOT what this spec implements).
 *  [S] github.com/zerodevapp/sdk at commit
 *      cd7c05b53b6ae6bede7dfefe9e59fbddfadf0c0a (packages/core/constants.ts,
 *      plugins/ecdsa/constants.ts, accounts/kernel/createKernelAccount.ts),
 *      used to confirm addresses and as a reference encoder.
 *  [E] ERC-7579 text, ethereum/ERCs ERCS/erc-7579.md at commit
 *      3f5f41b4ca4eb630eaf558960716e1604bff3de1 (eips.ethereum.org/EIPS/eip-7579).
 *  [L] Vectorized/solady at commit 3f2f5345261904463f5429c9031c3d2185c0f4fe
 *      (the lib/solady submodule pinned by [K] v3.3): LibClone, ECDSA,
 *      LibERC7579.
 *
 * Deployment (factory -> account):
 *  - KernelFactory.createAccount(bytes data, bytes32 salt) and the view
 *    getAddress(bytes data, bytes32 salt) both use
 *    actualSalt = keccak256(abi.encodePacked(data, salt)) and deploy an
 *    ERC-1967 minimal proxy of `implementation` via
 *    LibClone.createDeterministicERC1967 / predictDeterministicAddressERC1967;
 *    createAccount then calls the new proxy with `data` [K
 *    src/factory/KernelFactory.sol]. So `data` is the account's
 *    initialize(...) calldata and is part of the address preimage.
 *  - FactoryStaker ("meta factory") deployWithFactory(KernelFactory factory,
 *    bytes createData, bytes32 salt) forwards to factory.createAccount and
 *    only allows approved factories [K src/factory/FactoryStaker.sol]. The
 *    staker holds the EntryPoint stake, which is why the ZeroDev SDK uses it
 *    as the UserOperation `factory` by default [S createKernelAccount.ts
 *    getAccountInitCode / getFactoryArgs]. The CREATE2 deployer is the
 *    KernelFactory either way, so both paths produce the same address
 *    (confirmed on Sepolia with EntryPoint.getSenderAddress for both).
 *  - The ZeroDev SDK uses salt = toHex(index, { size: 32 }) [S], i.e. the
 *    account index as a big-endian bytes32. This spec does the same, so the
 *    same owner + index yields the same address in ZeroDev tooling.
 *
 * initialize(ValidationId _rootValidator, IHook hook, bytes validatorData,
 *            bytes hookData, bytes[] initConfig)  [K src/Kernel.sol]
 *  - ValidationId is bytes21 [K src/types/Types.sol]; for a plain validator
 *    module it is 0x01 (VALIDATION_TYPE_VALIDATOR) followed by the 20-byte
 *    validator address [K ValidatorLib.validatorToIdentifier in
 *    src/utils/ValidationTypeLib.sol; constants in src/types/Constants.sol].
 *  - hook = address(0): _installValidation maps it to address(1), meaning
 *    "installed, no hook", so validateUserOp does not require the
 *    executeUserOp prefix and callData can be execute(...) directly
 *    [K src/core/ValidationManager.sol _installValidation; Kernel.sol
 *    validateUserOp].
 *  - validatorData = the 20-byte owner address: ECDSAValidator.onInstall
 *    reads address(bytes20(_data[0:20])) [K src/validator/ECDSAValidator.sol].
 *  - hookData = empty, initConfig = [] (matches [S] getKernelInitData).
 *
 * Execution (ERC-7579 execute(bytes32 mode, bytes executionCalldata)):
 *  - mode = callType (1 byte) | execType (1 byte) | unused (4 bytes) |
 *    modeSelector (4 bytes) | modePayload (22 bytes) [E "Execution Behavior";
 *    K ExecLib.decode]. callType 0x00 = single call, 0x01 = batch; execType
 *    0x00 = revert on failure [E; K src/types/Constants.sol].
 *  - single: executionCalldata = abi.encodePacked(target, value, callData)
 *    [E; L LibERC7579.decodeSingle reads target at 0, value at 20, data at 52].
 *  - batch: executionCalldata = abi.encode(Execution[]) with
 *    Execution(address target, uint256 value, bytes callData) [E; K
 *    src/types/Structs.sol; L LibERC7579.decodeBatch].
 *
 * Validation routing and signature:
 *  - Kernel v3 selects the validator from the UserOperation NONCE KEY, not
 *    from a signature prefix: nonce = mode (1 byte) | type (1 byte) |
 *    identifier (20 bytes) | parallel key (2 bytes) | sequence (8 bytes),
 *    and type 0x00 (VALIDATION_TYPE_ROOT) means "use the root validator"
 *    whatever the identifier bytes hold [K Kernel.sol validateUserOp
 *    comment "v3 uses userOp.nonce's first 2 bytes to check the mode";
 *    ValidatorLib.decodeNonce]. The engine's SmartAccountClient reads the
 *    EntryPoint nonce with key 0, which decodes to mode DEFAULT + type ROOT,
 *    so no spec hook for the nonce key is needed. (The ZeroDev SDK puts the
 *    validator address into the identifier bytes of its root-mode key; the
 *    contract ignores them for type ROOT, so that is simply a different,
 *    equally valid nonce lane.)
 *  - In default mode the signature is passed unchanged to the validator
 *    (only a leading 32-byte MAGIC_VALUE_SIG_REPLAYABLE switches to the
 *    chain-agnostic hash, which we never use) [K ValidationManager
 *    _validateUserOp].
 *  - ECDSAValidator.validateUserOp accepts the owner's signature over
 *    either the raw userOpHash or its EIP-191 form [K ECDSAValidator.sol].
 *    We sign the EIP-191 form with v = 27/28, exactly as the ZeroDev SDK
 *    does (signMessage({ raw: hash })) [S plugins/ecdsa/toECDSAValidatorPlugin.ts].
 *  - solady ECDSA.recover REVERTS on an unrecoverable signature [L
 *    src/utils/ECDSA.sol, "the recover variants will revert upon recovery
 *    failure"], so the gas-estimation stub must be a recoverable signature
 *    for any digest. We use the ZeroDev SDK's DUMMY_ECDSA_SIG [S
 *    packages/core/constants.ts]; tests prove it recovers on both paths.
 *
 * EntryPoint: Kernel v3.3 is deployed against EntryPoint v0.7
 * (0x0000000071727De22E5E9d8BAf0edAc6f37da032): [K script/DeployKernel.s.sol]
 * constructs Kernel with ENTRYPOINT_0_7_ADDR, and the deployed
 * implementation's entrypoint() returns it on Sepolia and mainnet.
 */

/**
 * Kernel v3.3 deployment, identical addresses on Ethereum mainnet and
 * Sepolia. Sources: [K] README.md "Addresses" -> v3.3 (meta factory,
 * factory, kernel) and [S] packages/core/constants.ts
 * KernelVersionToAddressesMap["0.3.3"]; the ECDSA validator from [S]
 * plugins/ecdsa/constants.ts (">=0.3.1") and [K] README v3.1 table (the v3.2
 * and v3.3 README tables do not repeat it).
 *
 * Verified on-chain 2026-10-01 (read-only eth_call / eth_getCode against
 * https://ethereum-sepolia-rpc.publicnode.com and
 * https://ethereum.publicnode.com) with the checks in
 * verifyKernelDeployment: all four have code, factory.implementation() ==
 * kernel, kernel.entrypoint() == EntryPoint v0.7, kernel.accountId() ==
 * "kernel.advanced.v0.3.3", kernel.eip712Domain() == ("Kernel", "0.3.3"),
 * metaFactory.approved(factory) == true, the meta factory is staked in the
 * EntryPoint (0.1 ETH, 86400 s unstake delay), and the validator reports
 * isModuleType(1) == true.
 */
export const KERNEL_V3_3 = {
  version: '0.3.3',
  accountId: 'kernel.advanced.v0.3.3',
  entryPoint: ENTRYPOINT_V07,
  metaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
  factory: '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9',
  implementation: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
  ecdsaValidator: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
} as const;

/** ERC-7579 call types and exec types [E; K src/types/Constants.sol]. */
export const ERC7579_CALLTYPE_SINGLE = 0x00;
export const ERC7579_CALLTYPE_BATCH = 0x01;
export const ERC7579_EXECTYPE_DEFAULT = 0x00;
export const ERC7579_EXECTYPE_TRY = 0x01;

/** Kernel's VALIDATION_TYPE_VALIDATOR prefix for a validator module id [K]. */
const VALIDATION_TYPE_VALIDATOR = 0x01;

/**
 * ZeroDev SDK DUMMY_ECDSA_SIG [S packages/core/constants.ts]: r < secp256k1
 * n, low s, v = 28. Recoverable for any digest, so solady's reverting
 * recover() accepts it during bundler simulation; it recovers to an address
 * that is not the owner, so validation reports SIG_VALIDATION_FAILED, which
 * bundlers tolerate during gas estimation.
 */
const KERNEL_STUB_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

/**
 * Runtime code template of solady's minimal ERC-1967 proxy, from
 * LibClone.initCodeHashERC1967 [L src/utils/LibClone.sol]: the hashed
 * 0x5f-byte region is 603d3d8160223d3973 || implementation || 6009 ||
 * the two 32-byte constants below. For the v3.3 implementation the hash is
 * 0xc452397f1e7518f8cea0566ac057e243bb1643f6298aba8eec8cdee78ee3b3dd,
 * equal to the ZeroDev SDK's published initCodeHash for 0.3.3 [S].
 */
const ERC1967_PROXY_PREFIX = '0x603d3d8160223d3973';
const ERC1967_PROXY_MIDDLE = '0x6009';
const ERC1967_PROXY_WORD_1 = '0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076';
const ERC1967_PROXY_WORD_2 = '0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';

export interface KernelAccountConfig {
  /** Node RPC transport used for the factory getAddress view call. */
  node: JsonRpcTransport;
  /**
   * Account index; becomes the bytes32 CREATE2 salt (big-endian). Same
   * owner + different index = independent account. Defaults to 0.
   */
  index?: bigint;
  /** KernelFactory (the CREATE2 deployer). Defaults to KERNEL_V3_3.factory. */
  factory?: string;
  /**
   * Account implementation behind the factory; used for the local CREATE2
   * cross-check. Must match factory.implementation(). Defaults to
   * KERNEL_V3_3.implementation.
   */
  implementation?: string;
  /**
   * FactoryStaker used as the UserOperation `factory` (staked in the
   * EntryPoint, as the ZeroDev SDK does by default). Pass null to call the
   * KernelFactory directly. Defaults to KERNEL_V3_3.metaFactory.
   */
  metaFactory?: string | null;
  /** ECDSA validator module address. Defaults to KERNEL_V3_3.ecdsaValidator. */
  ecdsaValidator?: string;
}

/** bytes32 mode word for ERC-7579 execute(): callType | execType | 30 zero bytes. */
export function encodeErc7579Mode(callType: number, execType = ERC7579_EXECTYPE_DEFAULT): Uint8Array {
  const mode = new Uint8Array(32);
  mode[0] = callType;
  mode[1] = execType;
  return mode;
}

/** Kernel ValidationId (bytes21) for a validator module: 0x01 || address. */
export function kernelValidatorId(validator: string): Uint8Array {
  return concatBytes(new Uint8Array([VALIDATION_TYPE_VALIDATOR]), toBytes(validator));
}

/** initialize(...) calldata installing the ECDSA validator as root for `ownerAddress`. */
export function encodeKernelInitData(ownerAddress: string, ecdsaValidator: string): Uint8Array {
  return encodeFunctionCall('initialize(bytes21,address,bytes,bytes,bytes[])', [
    { kind: 'fixedBytes', value: kernelValidatorId(ecdsaValidator) },
    { kind: 'address', value: '0x0000000000000000000000000000000000000000' },
    { kind: 'bytes', value: toBytes(ownerAddress) },
    { kind: 'bytes', value: new Uint8Array(0) },
    { kind: 'array', items: [] },
  ]);
}

/** keccak256 of solady's ERC-1967 minimal proxy init code for `implementation`. */
export function kernelProxyInitCodeHash(implementation: string): Uint8Array {
  return keccak(
    concatBytes(
      toBytes(ERC1967_PROXY_PREFIX),
      toBytes(implementation),
      toBytes(ERC1967_PROXY_MIDDLE),
      toBytes(ERC1967_PROXY_WORD_1),
      toBytes(ERC1967_PROXY_WORD_2),
    ),
  );
}

/**
 * Local CREATE2 prediction of the account address, mirroring
 * KernelFactory.getAddress: deployer = factory,
 * salt = keccak256(initData || bytes32(index)), init code = ERC-1967 proxy.
 */
export function predictKernelAddress(
  ownerAddress: string,
  options: { index?: bigint; factory?: string; implementation?: string; ecdsaValidator?: string } = {},
): string {
  const initData = encodeKernelInitData(
    ownerAddress,
    options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator,
  );
  const salt = keccak(concatBytes(initData, toWord(options.index ?? 0n)));
  return computeCreate2Address(
    options.factory ?? KERNEL_V3_3.factory,
    salt,
    kernelProxyInitCodeHash(options.implementation ?? KERNEL_V3_3.implementation),
  );
}

/** ERC-7579 executionCalldata + execute(bytes32,bytes) for one or more calls. */
export function encodeKernelExecute(calls: Call[], execType = ERC7579_EXECTYPE_DEFAULT): Uint8Array {
  if (calls.length === 0) throw new Error('At least one call is required');
  let callType: number;
  let executionCalldata: Uint8Array;
  if (calls.length === 1) {
    const call = calls[0]!;
    callType = ERC7579_CALLTYPE_SINGLE;
    executionCalldata = concatBytes(toBytes(call.to), toWord(call.value), call.data);
  } else {
    callType = ERC7579_CALLTYPE_BATCH;
    const executions: AbiValue = {
      kind: 'array',
      items: calls.map((c) => ({
        kind: 'tuple' as const,
        items: [
          { kind: 'address' as const, value: c.to },
          { kind: 'uint256' as const, value: c.value },
          { kind: 'bytes' as const, value: c.data },
        ],
      })),
    };
    executionCalldata = encodeSequence([executions]);
  }
  return encodeFunctionCall('execute(bytes32,bytes)', [
    { kind: 'fixedBytes', value: encodeErc7579Mode(callType, execType) },
    { kind: 'bytes', value: executionCalldata },
  ]);
}

export function createKernelAccountSpec(config: KernelAccountConfig): SmartAccountSpec {
  const index = config.index ?? 0n;
  const factory = config.factory ?? KERNEL_V3_3.factory;
  const implementation = config.implementation ?? KERNEL_V3_3.implementation;
  const metaFactory = config.metaFactory === undefined ? KERNEL_V3_3.metaFactory : config.metaFactory;
  const ecdsaValidator = config.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const addressCache = new Map<string, string>();

  return {
    /**
     * Reads the factory's getAddress view (authoritative for the configured
     * deployment) and refuses to return it unless it equals the local
     * CREATE2 prediction. A wrong answer here would mean receiving funds at
     * an address the seed cannot control, so a compromised or misconfigured
     * RPC (or a factory/implementation mismatch in config) fails loudly.
     */
    async getAddress(owner: DerivedAccount): Promise<string> {
      const cached = addressCache.get(owner.address);
      if (cached) return cached;
      const data = encodeFunctionCall('getAddress(bytes,bytes32)', [
        { kind: 'bytes', value: encodeKernelInitData(owner.address, ecdsaValidator) },
        { kind: 'fixedBytes', value: toWord(index) },
      ]);
      const result = (await config.node('eth_call', [
        { to: factory, data: toHex(data) },
        'latest',
      ])) as string;
      const word = toBytes(result);
      if (word.length !== 32) {
        throw new Error(`Kernel factory getAddress returned ${word.length} bytes, expected 32`);
      }
      const address = toChecksumAddress(word.slice(12));
      const predicted = predictKernelAddress(owner.address, {
        index,
        factory,
        implementation,
        ecdsaValidator,
      });
      if (address !== predicted) {
        throw new Error(
          `Kernel factory getAddress returned ${address} but the local CREATE2 prediction is ` +
            `${predicted}; check the configured factory/implementation and the node RPC`,
        );
      }
      addressCache.set(owner.address, address);
      return address;
    },

    async getFactoryArgs(owner: DerivedAccount) {
      const initData = encodeKernelInitData(owner.address, ecdsaValidator);
      const salt = toWord(index);
      if (metaFactory === null) {
        return {
          factory,
          factoryData: encodeFunctionCall('createAccount(bytes,bytes32)', [
            { kind: 'bytes', value: initData },
            { kind: 'fixedBytes', value: salt },
          ]),
        };
      }
      return {
        factory: metaFactory,
        factoryData: encodeFunctionCall('deployWithFactory(address,bytes,bytes32)', [
          { kind: 'address', value: factory },
          { kind: 'bytes', value: initData },
          { kind: 'fixedBytes', value: salt },
        ]),
      };
    },

    encodeCalls(calls: Call[]): Uint8Array {
      return encodeKernelExecute(calls);
    },

    signUserOpHash(owner: DerivedAccount, userOpHash: Uint8Array): Uint8Array {
      return withEthereumV(owner.sign(toEthSignedMessageHash(userOpHash)));
    },

    stubSignature(): Uint8Array {
      return toBytes(KERNEL_STUB_SIGNATURE);
    },
  };
}

export interface KernelDeploymentCheck {
  implementation: string;
  entryPoint: string;
  accountId: string;
  metaFactoryApproved: boolean | null;
}

/**
 * On-chain verification of a Kernel v3 deployment, the Kernel counterpart
 * of the docs/AA_STACK.md factory procedure. Read-only (eth_getCode and
 * eth_call). Throws with a specific message on the first failed check:
 *  1. factory, implementation, validator (and meta factory, if used) have code;
 *  2. factory.implementation() equals the configured implementation;
 *  3. implementation.entrypoint() equals the pinned EntryPoint;
 *  4. implementation.accountId() equals the expected id (default
 *     "kernel.advanced.v0.3.3", returned by Kernel.sol v3.3 accountId());
 *  5. metaFactory.approved(factory) is true, if a meta factory is used;
 *  6. validator.isModuleType(1) (MODULE_TYPE_VALIDATOR) is true.
 */
export async function verifyKernelDeployment(
  node: JsonRpcTransport,
  options: {
    factory?: string;
    implementation?: string;
    metaFactory?: string | null;
    ecdsaValidator?: string;
    entryPoint?: string;
    expectedAccountId?: string;
  } = {},
): Promise<KernelDeploymentCheck> {
  const factory = options.factory ?? KERNEL_V3_3.factory;
  const implementation = options.implementation ?? KERNEL_V3_3.implementation;
  const metaFactory = options.metaFactory === undefined ? KERNEL_V3_3.metaFactory : options.metaFactory;
  const ecdsaValidator = options.ecdsaValidator ?? KERNEL_V3_3.ecdsaValidator;
  const entryPoint = options.entryPoint ?? ENTRYPOINT_V07;
  const expectedAccountId = options.expectedAccountId ?? KERNEL_V3_3.accountId;

  const contracts: Array<[string, string]> = [
    ['KernelFactory', factory],
    ['Kernel implementation', implementation],
    ['ECDSA validator', ecdsaValidator],
  ];
  if (metaFactory !== null) contracts.push(['Meta factory', metaFactory]);
  for (const [label, address] of contracts) {
    const code = (await node('eth_getCode', [address, 'latest'])) as string;
    if (!code || code === '0x' || code === '0x0') {
      throw new Error(`${label} ${address} has no code on this chain`);
    }
  }

  const call = async (to: string, data: Uint8Array): Promise<Uint8Array> =>
    toBytes((await node('eth_call', [{ to, data: toHex(data) }, 'latest'])) as string);
  const wordAddress = (word: Uint8Array, what: string): string => {
    if (word.length !== 32) throw new Error(`${what} returned ${word.length} bytes, expected 32`);
    return toChecksumAddress(word.slice(12));
  };
  const wordBool = (word: Uint8Array, what: string): boolean => {
    if (word.length !== 32) throw new Error(`${what} returned ${word.length} bytes, expected 32`);
    const value = BigInt(toHex(word));
    if (value > 1n) throw new Error(`${what} returned a non-boolean word`);
    return value === 1n;
  };

  const reportedImpl = wordAddress(
    await call(factory, encodeFunctionCall('implementation()', [])),
    'factory.implementation()',
  );
  if (reportedImpl.toLowerCase() !== implementation.toLowerCase()) {
    throw new Error(
      `factory.implementation() is ${reportedImpl}, expected ${implementation}`,
    );
  }

  const reportedEntryPoint = wordAddress(
    await call(implementation, encodeFunctionCall('entrypoint()', [])),
    'kernel.entrypoint()',
  );
  if (reportedEntryPoint.toLowerCase() !== entryPoint.toLowerCase()) {
    throw new Error(
      `kernel.entrypoint() is ${reportedEntryPoint}, expected ${entryPoint}`,
    );
  }

  const accountId = decodeAbiAsciiString(
    await call(implementation, encodeFunctionCall('accountId()', [])),
    'kernel.accountId()',
  );
  if (accountId !== expectedAccountId) {
    throw new Error(`kernel.accountId() is "${accountId}", expected "${expectedAccountId}"`);
  }

  let metaFactoryApproved: boolean | null = null;
  if (metaFactory !== null) {
    metaFactoryApproved = wordBool(
      await call(
        metaFactory,
        encodeFunctionCall('approved(address)', [{ kind: 'address', value: factory }]),
      ),
      'metaFactory.approved(factory)',
    );
    if (!metaFactoryApproved) {
      throw new Error(`Meta factory ${metaFactory} has not approved factory ${factory}`);
    }
  }

  const isValidator = wordBool(
    await call(
      ecdsaValidator,
      encodeFunctionCall('isModuleType(uint256)', [{ kind: 'uint256', value: 1n }]),
    ),
    'validator.isModuleType(1)',
  );
  if (!isValidator) {
    throw new Error(`${ecdsaValidator} does not report itself as a validator module`);
  }

  return {
    implementation: reportedImpl,
    entryPoint: reportedEntryPoint,
    accountId,
    metaFactoryApproved,
  };
}

/** Decodes an ABI-encoded `string` return value, accepting printable ASCII only. */
function decodeAbiAsciiString(data: Uint8Array, what: string): string {
  if (data.length < 64) throw new Error(`${what} returned ${data.length} bytes, too short for a string`);
  const offset = Number(BigInt(toHex(data.slice(0, 32))));
  if (offset + 32 > data.length) throw new Error(`${what} returned an out-of-range string offset`);
  const length = Number(BigInt(toHex(data.slice(offset, offset + 32))));
  const start = offset + 32;
  if (start + length > data.length) throw new Error(`${what} returned an out-of-range string length`);
  let out = '';
  for (const byte of data.slice(start, start + length)) {
    if (byte < 0x20 || byte > 0x7e) throw new Error(`${what} returned a non-ASCII string`);
    out += String.fromCharCode(byte);
  }
  return out;
}
