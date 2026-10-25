import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, dnsEncode, ensNormalize, getAddress, getCreate2Address, id, keccak256, namehash as ethersNamehash, concat } from 'ethers';
import {
  ENS_EAC_ALL_ROLES,
  ENS_REGISTER_ERROR_SELECTORS,
  ENS_REGISTER_ERROR_SIGNATURES,
  ENS_V2_SEPOLIA,
  ENS_V2_SEPOLIA_REGISTRAR_LIMITS,
  ENS_V2_SEPOLIA_USDC,
  EnsRegisterError,
  checkEnsHandleLabel,
  checkEnsRegisterReady,
  checkEnsSubLabel,
  classifyEnsRegisterRevert,
  encodeEnsCommit,
  encodeEnsCommitmentAt,
  encodeEnsExactApprove,
  encodeEnsGetRegisterPrice,
  encodeEnsIsAvailable,
  encodeEnsMakeCommitment,
  encodeEnsRegister,
  encodeEnsRegistryRegister,
  encodeEnsResolverInitialize,
  encodeEnsSetEthAddress,
  encodeEnsSetSubregistry,
  encodeEnsUserRegistryInitialize,
  encodeEnsV1ReverseSetName,
  encodeVerifiableDeployProxy,
  ensAvailablePeriod,
  ensLibHalving,
  ensOwnedResolverSalt,
  ensRegisterPrice,
  ensRegisterTiming,
  ensRegisterWindow,
  ensRegistrationCommitment,
  ensUserRegistrySalt,
  newEnsCommitSecret,
  planEnsRegistration,
  planEnsSubname,
  predictVerifiableProxyAddress,
  quoteEnsRegistration,
  readEnsCommitmentAt,
  readEnsNameState,
  readEnsOwnedResolver,
  readEnsPricing,
  readEnsPrimaryName,
  decodeEnsReverseResult,
  encodeEnsReverse,
  type EnsCommitmentParams,
  type EnsOwnedResolverState,
  type EnsRegistrationQuote,
} from '../src/ens-register.js';
import { toBytes, toHex } from '../src/encoding.js';
import type { JsonRpcTransport } from '../src/rpc.js';

const coder = AbiCoder.defaultAbiCoder();
const DEV = '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C';
const KERNEL = '0xD31c2C54F21684eE2026a6C41e391130BdEeD8FA';
const DEV_RESOLVER = '0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059';
const Z = '0x0000000000000000000000000000000000000000';
const Z32 = '0x' + '00'.repeat(32);
const iface = new Interface([
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setName(string name) returns (bytes32)',
]);
const userRegistryInit = new Interface(['function initialize((address account, uint256 roleBitmap)[] grants)']);
const registryRegister = new Interface(['function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)']);

// ---------------------------------------------------------------------------
// Fixtures captured read-only from Ethereum Sepolia (publicnode, Geth 1.17.9)
// ---------------------------------------------------------------------------

/**
 * A recorded session: every JSON-RPC request the engine's quote, resolver,
 * state and commitment reads made against ethereum-sepolia-rpc.publicnode.com
 * on 2026-10-25T14:23Z, with "latest" pinned to block 11991433 (0xb6f989),
 * and the node's exact answers. Keys are method + JSON params.
 */
const RECORDING: Record<string, { result?: unknown; error?: { code: number; message: string; data?: string } }> = JSON.parse(
  '{"eth_chainId []":{"result":"0xaa36a7"},"eth_getBlockByNumber [\\"latest\\",false]":{"result":{"number":"0xb6f989","timestamp":"0x6ade10c4"}},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x7b39ba16\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000008196665d4ca7488b6474a9ec8e7d2719fb42263a"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x47500708\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000d4ebcbbdf463c9c45784603db0ddd499bc44a8b4"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x2e4f692a\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000000000003c"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x8ccb9ea6\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000015180"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0xa40938bd\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000000024ea00"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0xc1a287e2\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000000024ea00"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x965306aa00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000013736869626177616c6c65742d6669787475726500000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000001"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x61907b120000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000024ea000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000013736869626177616c6c65742d6669787475726500000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000095d450000000000000000000000000000000000000000000000000000000000000000"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0xc50f093b\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000135aa7b00000000000000000000000000000000000000000000000000000000004d6a9f000000000000000000000000000000000000000000000000000000000003deef"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0x39ac7a2a\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000003c267000000000000000000000000000000000041d3e3134f35ebeac858ddf8000000000000000000000000000000000000000000000000000000000000000005a39a800000000000000000000000000000000033b8c4b3be3ca713e68ef78c00000000000000000000000000000000000000000000000000000000000000000b473500000000000000000000000000000000002a515b1eb2ebce84a55db34400000000"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0x415175bb\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000004b3b4ca85a86c47a098a224000000000"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0xac0d63d0\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000056bc75e2d63100000"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0xb553630e\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000015180"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0x6bab30b7\\"},\\"0xb6f989\\"]":{"result":"0x00000000000000000000000000000000000000000000000000000000001baf80"},"eth_call [{\\"to\\":\\"0x8196665D4ca7488B6474a9EC8E7d2719FB42263A\\",\\"data\\":\\"0x30897dba0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000f4240"},"eth_call [{\\"to\\":\\"0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4\\",\\"data\\":\\"0x44c9af2828a211c869ef03f4f71d40f9ef1357614be7e5cee74e27c0d08872574c0d9210\\"},\\"0xb6f989\\"]":{"result":"0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028a211c869ef03f4f71d40f9ef1357614be7e5cee74e27c0d08872570000000028a211c869ef03f4f71d40f9ef1357614be7e5cee74e27c0d088725700000001"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x61907b120000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000b4735000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000013736869626177616c6c65742d6669787475726500000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x00000000000000000000000000000000000000000000000000000000019bfd070000000000000000000000000000000000000000000000000000000000000000"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x965306aa000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000037362770000000000000000000000000000000000000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000001"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x61907b1200000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000001e133800000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c723800000000000000000000000000000000000000000000000000000000000000037362770000000000000000000000000000000000000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x000000000000000000000000000000000000000000000000000000002625a0050000000000000000000000000000000000000000000000000000000000000000"},"eth_call [{\\"to\\":\\"0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4\\",\\"data\\":\\"0x44c9af2838e68fc205903791f4297a494443eae9ca64976827b12ee2547cc397a59053ea\\"},\\"0xb6f989\\"]":{"result":"0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038e68fc205903791f4297a494443eae9ca64976827b12ee2547cc3970000000038e68fc205903791f4297a494443eae9ca64976827b12ee2547cc39700000001"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x965306aa0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001b72656665727265722d746573742d6f63742d32352d706f7274616c0000000000\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000000"},"eth_getCode [\\"0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059\\",\\"0xb6f989\\"]":{"result":"0x"},"eth_call [{\\"to\\":\\"0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4\\",\\"data\\":\\"0x44c9af282fa8407c2dba39bfc33027b36cb5177da73daef18d9d576b727eee3b8409ed4f\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000006b059284000000000000000000000000d20186bb031b61509955bb257869889690568a992fa8407c2dba39bfc33027b36cb5177da73daef18d9d576b727eee3b000000002fa8407c2dba39bfc33027b36cb5177da73daef18d9d576b727eee3b00000000"},"eth_call [{\\"to\\":\\"0xf633e7FC17e2bbE0D0965D18ec1821dcB754a3d3\\",\\"data\\":\\"0x16a925350000000000000000000000000000000000000000000000000000000000000000\\"},\\"0xb6f989\\"]":{"result":"0x0000000000000000000000000000000000000000000000000000000000000000"}}',
);

function replay(overrides: Record<string, unknown> = {}): JsonRpcTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport = (async (method: string, params: unknown[]) => {
    const key = `${method} ${JSON.stringify(params)}`;
    calls.push(key);
    if (key in overrides) {
      const o = overrides[key];
      if (o instanceof Error) throw o;
      return o;
    }
    const hit = RECORDING[key];
    if (!hit) throw new Error(`no recorded answer for ${key}`);
    if (hit.error) {
      const e = new Error(hit.error.message) as Error & { code: number; data?: string };
      e.code = hit.error.code;
      if (hit.error.data !== undefined) e.data = hit.error.data;
      throw e;
    }
    return hit.result;
  }) as JsonRpcTransport & { calls: string[] };
  transport.calls = calls;
  return transport;
}
const BLOCK = '0xb6f989';
const callKey = (to: string, data: string) => `eth_call ${JSON.stringify([{ to, data }, BLOCK])}`;
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

/**
 * StandardRentPriceOracle.getRegisterPrice(label, available, duration, token)
 * answers captured at Sepolia block 11991397 (2026-10-25): [label,
 * available, duration, token, base, premium]. USDC = Circle's Sepolia USDC
 * (ratio 1 : 1e6), DAI = ENS's MockDAI 0xF6fa…572b (ratio 1e6 : 1).
 */
const ORACLE_PRICES: [string, bigint, bigint, string, bigint, bigint][] = [
  ['abc', 1791000000n, 2419200n, 'USDC', 49095891n, 0n],
  ['abc', 1791000000n, 2419200n, 'DAI', 49095890726400000000n, 0n],
  ['abc', 1791000000n, 31535999n, 'USDC', 639999984n, 0n],
  ['abc', 1791000000n, 31535999n, 'DAI', 639999983817733000000n, 0n],
  ['abc', 1791000000n, 31536000n, 'USDC', 640000005n, 0n],
  ['abc', 1791000000n, 31536000n, 'DAI', 640000004112000000000n, 0n],
  ['abc', 1791000000n, 63072000n, 'USDC', 1120000008n, 0n],
  ['abc', 1791000000n, 63072000n, 'DAI', 1120000007196000000000n, 0n],
  ['abc', 1791000000n, 94608000n, 'USDC', 1320000009n, 0n],
  ['abc', 1791000000n, 94608000n, 'DAI', 1320000008481000000000n, 0n],
  ['abc', 1791000000n, 189216000n, 'USDC', 2160000014n, 0n],
  ['abc', 1791000000n, 189216000n, 'DAI', 2160000013878000000000n, 0n],
  ['abc', 1791000000n, 220764345n, 'USDC', 2520140941n, 0n],
  ['abc', 1791000000n, 220764345n, 'DAI', 2520140940849439000000n, 0n],
  ['abcd', 1791000000n, 2419200n, 'USDC', 12273974n, 0n],
  ['abcd', 1791000000n, 2419200n, 'DAI', 12273973286400000000n, 0n],
  ['abcd', 1791000000n, 31535999n, 'USDC', 160000004n, 0n],
  ['abcd', 1791000000n, 31535999n, 'DAI', 160000003838433000000n, 0n],
  ['abcd', 1791000000n, 31536000n, 'USDC', 160000009n, 0n],
  ['abcd', 1791000000n, 31536000n, 'DAI', 160000008912000000000n, 0n],
  ['abcd', 1791000000n, 63072000n, 'USDC', 280000016n, 0n],
  ['abcd', 1791000000n, 63072000n, 'DAI', 280000015596000000000n, 0n],
  ['abcd', 1791000000n, 94608000n, 'USDC', 330000019n, 0n],
  ['abcd', 1791000000n, 94608000n, 'DAI', 330000018381000000000n, 0n],
  ['abcd', 1791000000n, 189216000n, 'USDC', 540000031n, 0n],
  ['abcd', 1791000000n, 189216000n, 'DAI', 540000030078000000000n, 0n],
  ['abcd', 1791000000n, 220764345n, 'USDC', 630035267n, 0n],
  ['abcd', 1791000000n, 220764345n, 'DAI', 630035266257345000000n, 0n],
  ['abcde', 1791000000n, 2419200n, 'USDC', 613701n, 0n],
  ['abcde', 1791000000n, 2419200n, 'DAI', 613700236800000000n, 0n],
  ['abcde', 1791000000n, 31535999n, 'USDC', 8000021n, 0n],
  ['abcde', 1791000000n, 31535999n, 'DAI', 8000020690321000000n, 0n],
  ['abcde', 1791000000n, 31536000n, 'USDC', 8000021n, 0n],
  ['abcde', 1791000000n, 31536000n, 'DAI', 8000020944000000000n, 0n],
  ['abcde', 1791000000n, 63072000n, 'USDC', 14000037n, 0n],
  ['abcde', 1791000000n, 63072000n, 'DAI', 14000036652000000000n, 0n],
  ['abcde', 1791000000n, 94608000n, 'USDC', 16500044n, 0n],
  ['abcde', 1791000000n, 94608000n, 'DAI', 16500043197000000000n, 0n],
  ['abcde', 1791000000n, 189216000n, 'USDC', 27000071n, 0n],
  ['abcde', 1791000000n, 189216000n, 'DAI', 27000070686000000000n, 0n],
  ['abcde', 1791000000n, 220764345n, 'USDC', 31501845n, 0n],
  ['abcde', 1791000000n, 220764345n, 'DAI', 31501844029830000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 2419200n, 'USDC', 613701n, 0n],
  ['shiba-wallet-handle', 1791000000n, 2419200n, 'DAI', 613700236800000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 31535999n, 'USDC', 8000021n, 0n],
  ['shiba-wallet-handle', 1791000000n, 31535999n, 'DAI', 8000020690321000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 31536000n, 'USDC', 8000021n, 0n],
  ['shiba-wallet-handle', 1791000000n, 31536000n, 'DAI', 8000020944000000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 63072000n, 'USDC', 14000037n, 0n],
  ['shiba-wallet-handle', 1791000000n, 63072000n, 'DAI', 14000036652000000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 94608000n, 'USDC', 16500044n, 0n],
  ['shiba-wallet-handle', 1791000000n, 94608000n, 'DAI', 16500043197000000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 189216000n, 'USDC', 27000071n, 0n],
  ['shiba-wallet-handle', 1791000000n, 189216000n, 'DAI', 27000070686000000000n, 0n],
  ['shiba-wallet-handle', 1791000000n, 220764345n, 'USDC', 31501845n, 0n],
  ['shiba-wallet-handle', 1791000000n, 220764345n, 'DAI', 31501844029830000000n, 0n],
  ['abcde', 0n, 2419200n, 'USDC', 613700n, 99999952316285n],
  ['abcde', 0n, 2419200n, 'DAI', 613700236800000000n, 99999952316284179688000000n],
  ['abcde', 1n, 2419200n, 'USDC', 613700n, 99999952316285n],
  ['abcde', 1n, 2419200n, 'DAI', 613700236800000000n, 99999952316284179688000000n],
  ['abcde', 3600n, 2419200n, 'USDC', 613700n, 97153831466842n],
  ['abcde', 3600n, 2419200n, 'DAI', 613700236800000000n, 97153831466841690380000000n],
  ['abcde', 86400n, 2419200n, 'USDC', 613700n, 49999952316285n],
  ['abcde', 86400n, 2419200n, 'DAI', 613700236800000000n, 49999952316284179688000000n],
  ['abcde', 87177n, 2419200n, 'USDC', 613700n, 49689440029746n],
  ['abcde', 87177n, 2419200n, 'DAI', 613700236800000000n, 49689440029745609257000000n],
  ['abcde', 864000n, 2419200n, 'USDC', 613700n, 97608566285n],
  ['abcde', 864000n, 2419200n, 'DAI', 613700236800000000n, 97608566284179688000000n],
  ['abcde', 1814399n, 2419200n, 'USDC', 613700n, 505n],
  ['abcde', 1814399n, 2419200n, 'DAI', 613700236800000000n, 504333613000000n],
  ['abcde', 1814399n, 2419200n, 'USDC', 613700n, 505n],
  ['abcde', 1814399n, 2419200n, 'DAI', 613700236800000000n, 504333613000000n],
  ['abcde', 1814400n, 2419200n, 'USDC', 613701n, 0n],
  ['abcde', 1814400n, 2419200n, 'DAI', 613700236800000000n, 0n],
  ['abcde', 1791000000n, 2419200n, 'USDC', 613701n, 0n],
  ['abcde', 1791000000n, 2419200n, 'DAI', 613700236800000000n, 0n],
];

/** ETHRegistrar.makeCommitment answers captured at the same block (commitNonce = the commitment's secret argument; fixed test values). */
const COMMITMENTS = [
  { label: 'shibawallet', owner: '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C', commitNonce: '0x1111111111111111111111111111111111111111111111111111111111111111', subregistry: '0x0000000000000000000000000000000000000000', resolver: '0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059', duration: 2419200n, referrer: '0x0000000000000000000000000000000000000000000000000000000000000000', onchain: '0x240291618001cdee2241c38102235266304ba7d6c1e6968fb2104d0d0348e2ce' },
  { label: 'abc', owner: '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C', commitNonce: '0xabababababababababababababababababababababababababababababababab', subregistry: '0x00000000000000000000000000000000000000ff', resolver: '0x0000000000000000000000000000000000000000', duration: 31536000n, referrer: '0x2222222222222222222222222222222222222222222222222222222222222222', onchain: '0x6883474fbfc6cb10787c6f6b82e0e5f7a0182d503bc0abdfc3d33e62b642914b' },
  { label: 'a-very-long-label-for-the-commitment-fixture-that-spans-two-words', owner: '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C', commitNonce: '0x1111111111111111111111111111111111111111111111111111111111111111', subregistry: '0x0000000000000000000000000000000000000000', resolver: '0x599AE46486BC988C5bA9b98CdB1f7cF167dD6059', duration: 189216000n, referrer: '0x0000000000000000000000000000000000000000000000000000000000000000', onchain: '0x0449ec598c03dbb52b1c44fdb32b3ac055df0566c7f04e34174b5b19f7740b00' },
];

const TOKENS: Record<string, { numer: bigint; denom: bigint }> = {
  USDC: { numer: 1n, denom: 1_000_000n },
  DAI: { numer: 1_000_000n, denom: 1n },
};

// ---------------------------------------------------------------------------

describe('selectors and calldata (pinned against ethers)', () => {
  it('encodes every call exactly as ethers does', () => {
    const secret = toBytes('0x' + '11'.repeat(32));
    const p: EnsCommitmentParams = { label: 'shibawallet', owner: DEV, secret, subregistry: Z, resolver: DEV_RESOLVER, duration: 2419200n, referrer: new Uint8Array(32) };
    expect(toHex(encodeEnsCommit(toBytes('0x' + 'ab'.repeat(32))))).toBe(iface.encodeFunctionData('commit', ['0x' + 'ab'.repeat(32)]));
    expect(toHex(encodeEnsRegister(p, ENS_V2_SEPOLIA_USDC.address))).toBe(
      iface.encodeFunctionData('register', ['shibawallet', DEV, toHex(secret), Z, DEV_RESOLVER, 2419200n, ENS_V2_SEPOLIA_USDC.address, Z32]),
    );
    expect(toHex(encodeEnsMakeCommitment(p))).toBe(iface.encodeFunctionData('makeCommitment', ['shibawallet', DEV, toHex(secret), Z, DEV_RESOLVER, 2419200n, Z32]));
    expect(toHex(encodeEnsIsAvailable('shibawallet'))).toBe(iface.encodeFunctionData('isAvailable', ['shibawallet']));
    expect(toHex(encodeEnsGetRegisterPrice('shibawallet', 2419200n, ENS_V2_SEPOLIA_USDC.address))).toBe(
      iface.encodeFunctionData('getRegisterPrice', ['shibawallet', 2419200n, ENS_V2_SEPOLIA_USDC.address]),
    );
    expect(toHex(encodeEnsCommitmentAt(new Uint8Array(32)))).toBe(iface.encodeFunctionData('commitmentAt', [Z32]));
    expect(toHex(encodeEnsExactApprove(ENS_V2_SEPOLIA.ethRegistrar, 613701n))).toBe(iface.encodeFunctionData('approve', [ENS_V2_SEPOLIA.ethRegistrar, 613701n]));
    const setAddr = iface.encodeFunctionData('setAddress', [dnsEncode('shibawallet.eth', 255), 60n, DEV]);
    expect(toHex(encodeEnsSetEthAddress('shibawallet.eth', DEV))).toBe(setAddr);
    expect(toHex(encodeEnsResolverInitialize(DEV, [toBytes(setAddr)]))).toBe(iface.encodeFunctionData('initialize', [[[DEV, ENS_EAC_ALL_ROLES]], [setAddr]]));
    expect(toHex(encodeEnsUserRegistryInitialize(DEV))).toBe(userRegistryInit.encodeFunctionData('initialize', [[[DEV, ENS_EAC_ALL_ROLES]]]));
    expect(toHex(encodeVerifiableDeployProxy(ENS_V2_SEPOLIA.permissionedResolverImpl, 7n, toBytes('0x1234')))).toBe(
      iface.encodeFunctionData('deployProxy', [ENS_V2_SEPOLIA.permissionedResolverImpl, 7n, '0x1234']),
    );
    expect(toHex(encodeEnsSetSubregistry('shibawallet', KERNEL))).toBe(iface.encodeFunctionData('setSubregistry', [BigInt(id('shibawallet')), KERNEL]));
    expect(toHex(encodeEnsRegistryRegister('smart', DEV, DEV_RESOLVER, 0n, 1795527300n))).toBe(
      registryRegister.encodeFunctionData('register', ['smart', DEV, Z, DEV_RESOLVER, 0n, 1795527300n]),
    );
    expect(toHex(encodeEnsV1ReverseSetName('shibawallet.eth'))).toBe(iface.encodeFunctionData('setName', ['shibawallet.eth']));
  });

  it('pins the function selectors the deployed contracts expose', () => {
    // Selectors read from the calldata above; the values match the deployment ABIs in
    // contracts-v2 at 07e55a05 (contracts/deployments/sepolia/*.json).
    expect(toHex(encodeEnsCommit(new Uint8Array(32))).slice(0, 10)).toBe('0xf14fcbc8');
    expect(iface.getFunction('register')!.selector).toBe('0x'+ toHex(encodeEnsRegister({ label: 'abc', owner: DEV, secret: toBytes('0x' + '01'.repeat(32)), subregistry: Z, resolver: Z, duration: 1n, referrer: new Uint8Array(32) }, Z)).slice(2, 10));
    expect(toHex(encodeEnsIsAvailable('x')).slice(0, 10)).toBe('0x965306aa');
    expect(toHex(encodeEnsGetRegisterPrice('x', 1n, Z)).slice(0, 10)).toBe('0x61907b12');
    expect(toHex(encodeEnsCommitmentAt(new Uint8Array(32))).slice(0, 10)).toBe('0x16a92535');
    expect(toHex(encodeEnsV1ReverseSetName('x')).slice(0, 10)).toBe('0xc47f0027');
  });

  it('pins the error selectors against ethers and the "Error selector" comments in the sources', () => {
    const fromSource: Record<string, string> = {
      commitmentTooNew: '0x6be614e3',
      commitmentTooOld: '0x0cb9df3f',
      unexpiredCommitmentExists: '0x0a059d71',
      nameNotAvailable: '0x477707e8',
      durationTooShort: '0xa096b844',
      notValid: '0xdbfa2886',
      paymentTokenNotSupported: '0x02e2ae9e',
      invalidOwner: '0x49e27cff',
      labelAlreadyRegistered: '0xdef545a4',
      labelExpired: '0xc44e2374',
      eacUnauthorizedAccountRoles: '0x4b27a133',
    };
    for (const [k, sig] of Object.entries(ENS_REGISTER_ERROR_SIGNATURES)) {
      expect(ENS_REGISTER_ERROR_SELECTORS[k as keyof typeof ENS_REGISTER_ERROR_SIGNATURES]).toBe(id(sig).slice(0, 10));
      expect(ENS_REGISTER_ERROR_SELECTORS[k as keyof typeof ENS_REGISTER_ERROR_SIGNATURES]).toBe(fromSource[k]);
    }
  });

  it('classifies revert data captured from the deployed contracts', () => {
    // From eth_simulateV1 of register() 59 s after commit (2026-10-25) and the captured eth_calls.
    expect(classifyEnsRegisterRevert('0x6be614e32eabc40c96f8b203c977b5255fa9f439ae6ef942642f6894ec7957986386b796000000000000000000000000000000000000000000000000000000006ade0ef0000000000000000000000000000000000000000000000000000000006ade0eef')).toBe('commitmentTooNew');
    expect(classifyEnsRegisterRevert('0xa096b844000000000000000000000000000000000000000000000000000000000024e9ff000000000000000000000000000000000000000000000000000000000024ea00')).toBe('durationTooShort');
    expect(classifyEnsRegisterRevert('0x02e2ae9e00000000000000000000000016f95d91dba7da3aca778ec053df0ff6c6a8aa8e')).toBe('paymentTokenNotSupported');
    expect(classifyEnsRegisterRevert('0xdbfa2886')).toBe('notValid');
    expect(classifyEnsRegisterRevert('0x12345678')).toBe('unknown');
  });
});

describe('the commitment (ETHRegistrar.makeCommitment)', () => {
  it('equals the contract answer for every captured fixture, and ethers abi.encode', () => {
    for (const c of COMMITMENTS) {
      const p: EnsCommitmentParams = { label: c.label, owner: c.owner, secret: toBytes(c.commitNonce), subregistry: c.subregistry, resolver: c.resolver, duration: c.duration, referrer: toBytes(c.referrer) };
      const local = toHex(ensRegistrationCommitment(p));
      expect(local).toBe(c.onchain);
      expect(local).toBe(keccak256(coder.encode(['string', 'address', 'bytes32', 'address', 'address', 'uint64', 'bytes32'], [c.label, c.owner, c.commitNonce, c.subregistry, c.resolver, c.duration, c.referrer])));
    }
  });

  it('refuses a zero or short secret, a zero owner, a bad label and a duration above uint64', () => {
    const base: EnsCommitmentParams = { label: 'shibawallet', owner: DEV, secret: toBytes('0x' + '11'.repeat(32)), subregistry: Z, resolver: DEV_RESOLVER, duration: 2419200n, referrer: new Uint8Array(32) };
    expect(() => ensRegistrationCommitment({ ...base, secret: new Uint8Array(32) })).toThrow(/all zeros/);
    expect(() => ensRegistrationCommitment({ ...base, secret: new Uint8Array(31).fill(1) })).toThrow(/32 bytes/);
    expect(() => ensRegistrationCommitment({ ...base, owner: Z })).toThrow(/zero address/);
    expect(() => ensRegistrationCommitment({ ...base, label: 'Shibawallet' })).toThrow(EnsRegisterError);
    expect(() => ensRegistrationCommitment({ ...base, duration: 1n << 64n })).toThrow(/uint64/);
  });

  it('draws the secret from the injected generator and refuses an all-zero one', () => {
    expect(toHex(newEnsCommitSecret((n) => new Uint8Array(n).fill(7)))).toBe('0x' + '07'.repeat(32));
    expect(() => newEnsCommitSecret((n) => new Uint8Array(n))).toThrow(/all zeros/);
    expect(newEnsCommitSecret().length).toBe(32);
  });
});

describe('labels', () => {
  it('accepts second-level .eth labels in the ASCII subset, equal to ethers ensNormalize', () => {
    for (const [input, label] of [['Alice', 'alice'], ['alice.eth', 'alice'], ['  ShibaWallet.ETH ', 'shibawallet'], ['abc', 'abc'], ['a-b-c', 'a-b-c'], ['123', '123']] as const) {
      const c = checkEnsHandleLabel(input);
      expect(c).toEqual({ ok: true, label, name: `${label}.eth` });
      if (c.ok) expect(ensNormalize(c.name)).toBe(c.name);
    }
  });

  it('refuses what ens.ts refuses, short labels, sub-names and other TLDs', () => {
    expect(checkEnsHandleLabel('')).toEqual({ ok: false, problem: 'empty' });
    expect(checkEnsHandleLabel('ab')).toEqual({ ok: false, problem: 'too-short' });
    expect(checkEnsHandleLabel('a.b.eth')).toEqual({ ok: false, problem: 'not-second-level' });
    expect(checkEnsHandleLabel('alice.com')).toEqual({ ok: false, problem: 'not-eth' });
    expect(checkEnsHandleLabel('ab--cd')).toEqual({ ok: false, problem: 'label-extension' });
    expect(checkEnsHandleLabel('alice_')).toEqual({ ok: false, problem: 'not-ascii-subset' });
    expect(checkEnsHandleLabel('ålice')).toEqual({ ok: false, problem: 'not-ascii-subset' });
    expect(checkEnsHandleLabel('🐕dog')).toEqual({ ok: false, problem: 'not-ascii-subset' });
    expect(checkEnsHandleLabel('a'.repeat(260))).toEqual({ ok: false, problem: 'too-long' });
    expect(checkEnsSubLabel('Smart')).toEqual({ ok: true, label: 'smart' });
    expect(checkEnsSubLabel('a.b').ok).toBe(false);
  });
});

describe('deterministic addresses (VerifiableFactory)', () => {
  it('computes the docs salts like ethers', () => {
    expect(ensOwnedResolverSalt(DEV)).toBe(BigInt(keccak256(coder.encode(['bytes32', 'address', 'uint256'], [id('OwnedResolver'), DEV, 0n]))));
    expect(ensUserRegistrySalt('shibawallet.eth')).toBe(BigInt(keccak256(coder.encode(['bytes32', 'bytes32', 'uint256'], [id('UserRegistry'), ethersNamehash('shibawallet.eth'), 0n]))));
  });

  it("equals the deployed factory's own predictProxyAddress (captured at block 11991408) and ethers CREATE2", () => {
    // VerifiableFactory.proxyLogic() = 0xC415…6BDd; predictProxyAddress(DEV, salt) answers below.
    expect(predictVerifiableProxyAddress(DEV, ensOwnedResolverSalt(DEV))).toBe(DEV_RESOLVER);
    expect(predictVerifiableProxyAddress(DEV, ensUserRegistrySalt('shibawallet.eth'))).toBe(getAddress('0x3daf7675fd793d88ff118c40445baa963b100269'));
    const salt = 12345n;
    const outer = keccak256(coder.encode(['address', 'uint256'], [KERNEL, salt]));
    const init = concat(['0x3d604d80600a3d3981f3363d3d373d3d3d363d73', ENS_V2_SEPOLIA.verifiableProxyLogic, '0x5af43d82803e903d91602b57fd5bf3', outer]);
    expect(predictVerifiableProxyAddress(KERNEL, salt)).toBe(getCreate2Address(ENS_V2_SEPOLIA.verifiableFactory, outer, keccak256(init)));
  });
});

describe('prices: the StandardRentPriceOracle mirror against captured answers', () => {
  it('reads the oracle parameters and reproduces every captured getRegisterPrice exactly', async () => {
    const pricing = await readEnsPricing(replay());
    expect(pricing.baseRatePerCp.slice(0, 2)).toEqual([0n, 0n]);
    expect(pricing.discountPoints.length).toBe(3);
    expect(ORACLE_PRICES.length).toBeGreaterThan(70);
    for (const [label, available, duration, token, base, premium] of ORACLE_PRICES) {
      expect(ensRegisterPrice(pricing, label, available, duration, TOKENS[token]!), `${label} ${available} ${duration} ${token}`).toEqual({ base, premium });
    }
  });

  it('matches LibHalving at its edges and the oracle premium offset', async () => {
    const pricing = await readEnsPricing(replay());
    expect(ensLibHalving(pricing.premiumPriceInitial, pricing.premiumHalvingPeriod, 0n)).toBe(pricing.premiumPriceInitial);
    expect(ensLibHalving(pricing.premiumPriceInitial, pricing.premiumHalvingPeriod, 86_400n)).toBe(pricing.premiumPriceInitial / 2n);
    // PREMIUM_PRICE_OFFSET() read at block 11991397: 0x2b5e3af16b18.
    expect(ensLibHalving(pricing.premiumPriceInitial, pricing.premiumHalvingPeriod, pricing.premiumPeriod)).toBe(0x2b5e3af16b18n);
    expect(ensLibHalving(0n, 1n, 5n)).toBe(0n);
  });

  it('follows the registrar availability rule (never registered = now; grace period = 0)', () => {
    expect(ensAvailablePeriod(0n, 1_000n, 10n)).toBe(1_000n);
    expect(ensAvailablePeriod(900n, 1_000n, 100n)).toBe(0n);
    expect(ensAvailablePeriod(800n, 1_000n, 100n)).toBe(100n);
  });

  it('refuses a label the oracle does not price and an unaccepted token', async () => {
    const pricing = await readEnsPricing(replay());
    expect(() => ensRegisterPrice(pricing, 'ab', 1n, 2419200n, TOKENS.USDC!)).toThrow(/does not price/);
    expect(() => ensRegisterPrice(pricing, 'abc', 1n, 2419200n, { numer: 0n, denom: 0n })).toThrow(/not accepted/);
  });
});

describe('quoteEnsRegistration (replayed Sepolia session)', () => {
  it('quotes a free 28-day registration in USDC, the mirror equal to the registrar', async () => {
    const q = await quoteEnsRegistration(replay(), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n });
    expect(q.total).toBe(613_701n); // 0.613701 USDC, the same figure NameRegistered events show on Sepolia
    expect(q.premium).toBe(0n);
    expect(q.name).toBe('shibawallet-fixture.eth');
    expect(q.node).toBe(ethersNamehash('shibawallet-fixture.eth'));
    expect(q.blockNumber).toBe(11991433n);
    expect(q.expiryIfRegisteredNow).toBe(q.quoteTimestamp + 2419200n);
    expect(q.config.minCommitmentAge).toBe(60n);
  });

  it('applies the six-year discount and the three-character rate', async () => {
    expect((await quoteEnsRegistration(replay(), { label: 'shibawallet-fixture', owner: DEV, duration: 6n * 31_536_000n })).total).toBe(27_000_071n);
    expect((await quoteEnsRegistration(replay(), { label: 'sbw', owner: DEV, duration: 31_536_000n })).total).toBe(640_000_005n);
  });

  it('refuses a taken name, a short duration, another token and another chain', async () => {
    await expect(quoteEnsRegistration(replay(), { label: 'referrer-test-oct-25-portal', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(quoteEnsRegistration(replay(), { label: 'shibawallet-fixture', owner: DEV, duration: 2419199n })).rejects.toMatchObject({ reason: 'duration' });
    await expect(quoteEnsRegistration(replay(), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n, paymentToken: { address: '0x240b0316Df57887DBBE58b586508b19e633a14aa', symbol: 'USDC', decimals: 6 } })).rejects.toMatchObject({ reason: 'payment-token' });
    await expect(quoteEnsRegistration(replay({ 'eth_chainId []': '0x1' }), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'wrong-chain' });
    await expect(quoteEnsRegistration(replay(), { label: 'ab', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'invalid-label' });
    await expect(quoteEnsRegistration(replay(), { label: 'shibawallet-fixture', owner: Z, duration: 2419200n })).rejects.toMatchObject({ reason: 'invalid-address' });
  });

  it('refuses a premium, a price the mirror does not reproduce and a changed registrar', async () => {
    const priceKey = callKey(ENS_V2_SEPOLIA.ethRegistrar, iface.encodeFunctionData('getRegisterPrice', ['shibawallet-fixture', 2419200n, ENS_V2_SEPOLIA_USDC.address]));
    expect(RECORDING[priceKey]).toBeDefined();
    await expect(quoteEnsRegistration(replay({ [priceKey]: word(613_701n) + word(5n).slice(2) }), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'premium' });
    await expect(quoteEnsRegistration(replay({ [priceKey]: word(613_700n) + word(0n).slice(2) }), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'price-mismatch' });
    const minAgeKey = callKey(ENS_V2_SEPOLIA.ethRegistrar, '0x2e4f692a');
    expect(RECORDING[minAgeKey]).toBeDefined();
    await expect(quoteEnsRegistration(replay({ [minAgeKey]: word(0n) }), { label: 'shibawallet-fixture', owner: DEV, duration: 2419200n })).rejects.toMatchObject({ reason: 'deployment-mismatch' });
  });

  it('reads the name state and a commitment time', async () => {
    const s = await readEnsNameState(replay(), 'referrer-test-oct-25-portal');
    expect(s.status).toBe(2);
    expect(s.expiry).toBe(1795527300n);
    expect(await readEnsCommitmentAt(replay(), new Uint8Array(32))).toBe(0n);
  });
});

describe("the owner's resolver", () => {
  it('finds the undeployed conventional resolver of the dev EOA (replayed)', async () => {
    const r = await readEnsOwnedResolver(replay(), DEV);
    expect(r).toEqual({ address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: false });
  });

  it('accepts a deployed resolver only when it verifies and the owner holds ROLE_SET_ADDRESS', async () => {
    const code = `eth_getCode ${JSON.stringify([DEV_RESOLVER, BLOCK])}`;
    const verify = callKey(ENS_V2_SEPOLIA.verifiableFactory, new Interface(['function verifyContract(address)']).encodeFunctionData('verifyContract', [DEV_RESOLVER]));
    const role = callKey(DEV_RESOLVER, new Interface(['function hasRootRoles(uint256,address)']).encodeFunctionData('hasRootRoles', [1n, DEV]));
    const impl = word(BigInt(ENS_V2_SEPOLIA.permissionedResolverImpl));
    expect(await readEnsOwnedResolver(replay({ [code]: '0x3d3d', [verify]: impl, [role]: word(1n) }), DEV)).toMatchObject({ deployed: true, address: DEV_RESOLVER });
    await expect(readEnsOwnedResolver(replay({ [code]: '0x3d3d', [verify]: word(1n), [role]: word(1n) }), DEV)).rejects.toMatchObject({ reason: 'resolver' });
    await expect(readEnsOwnedResolver(replay({ [code]: '0x3d3d', [verify]: impl, [role]: word(0n) }), DEV)).rejects.toMatchObject({ reason: 'resolver' });
  });
});

function fixtureQuote(): EnsRegistrationQuote {
  return {
    label: 'shibawallet', name: 'shibawallet.eth', node: ethersNamehash('shibawallet.eth'), owner: DEV, duration: 2419200n,
    paymentToken: ENS_V2_SEPOLIA_USDC, base: 613_701n, premium: 0n, total: 613_701n, expiryIfRegisteredNow: 1n,
    blockNumber: 1n, quoteTimestamp: 1n,
    config: { rentPriceOracle: ENS_V2_SEPOLIA.rentPriceOracle, ethRegistry: ENS_V2_SEPOLIA.ethRegistry, ...ENS_V2_SEPOLIA_REGISTRAR_LIMITS },
  };
}
const SECRET = toBytes('0x' + '11'.repeat(32));

describe('planEnsRegistration', () => {
  it('builds prepare (resolver with the record, exact approval, commit) and register (+ reverse)', () => {
    const resolver: EnsOwnedResolverState = { address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: false };
    const plan = planEnsRegistration({ quote: fixtureQuote(), resolver, secret: SECRET, setReverse: true });
    // The commitment equals the captured on-chain makeCommitment for these values.
    expect(plan.commitment).toBe(COMMITMENTS[0]!.onchain);
    expect(plan.deploysResolver).toBe(true);
    const [deploy, approve, commit] = plan.prepare.calls;
    expect(deploy!.to).toBe(ENS_V2_SEPOLIA.verifiableFactory);
    const setAddr = iface.encodeFunctionData('setAddress', [dnsEncode('shibawallet.eth', 255), 60n, DEV]);
    const init = iface.encodeFunctionData('initialize', [[[DEV, ENS_EAC_ALL_ROLES]], [setAddr]]);
    expect(toHex(deploy!.data)).toBe(iface.encodeFunctionData('deployProxy', [ENS_V2_SEPOLIA.permissionedResolverImpl, ensOwnedResolverSalt(DEV), init]));
    expect(approve!.to).toBe(ENS_V2_SEPOLIA_USDC.address);
    expect(toHex(approve!.data)).toBe(iface.encodeFunctionData('approve', [ENS_V2_SEPOLIA.ethRegistrar, 613_701n]));
    expect(toHex(commit!.data)).toBe(iface.encodeFunctionData('commit', [COMMITMENTS[0]!.onchain]));
    expect(plan.prepare.calls.every((c) => c.value === 0n)).toBe(true);
    const [register, reverse] = plan.register.calls;
    expect(toHex(register!.data)).toBe(iface.encodeFunctionData('register', ['shibawallet', DEV, toHex(SECRET), Z, DEV_RESOLVER, 2419200n, ENS_V2_SEPOLIA_USDC.address, Z32]));
    expect(reverse!.to).toBe(ENS_V2_SEPOLIA.v1ReverseRegistrar);
    expect(plan.register.describe.length).toBe(2);
  });

  it('uses setAddress on an existing resolver, omits the reverse record when not asked, and refuses a foreign resolver', () => {
    const existing: EnsOwnedResolverState = { address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: true };
    const plan = planEnsRegistration({ quote: fixtureQuote(), resolver: existing, secret: SECRET, setReverse: false });
    expect(plan.prepare.calls[0]!.to).toBe(DEV_RESOLVER);
    expect(toHex(plan.prepare.calls[0]!.data)).toBe(iface.encodeFunctionData('setAddress', [dnsEncode('shibawallet.eth', 255), 60n, DEV]));
    expect(plan.register.calls.length).toBe(1);
    expect(() => planEnsRegistration({ quote: fixtureQuote(), resolver: { ...existing, address: KERNEL }, secret: SECRET, setReverse: false })).toThrow(/conventional resolver/);
    expect(() => planEnsRegistration({ quote: fixtureQuote(), resolver: existing, secret: new Uint8Array(32), setReverse: false })).toThrow(/all zeros/);
  });

  it('never approves zero or an unlimited amount', () => {
    expect(() => encodeEnsExactApprove(ENS_V2_SEPOLIA.ethRegistrar, 0n)).toThrow();
    expect(() => encodeEnsExactApprove(ENS_V2_SEPOLIA.ethRegistrar, (1n << 256n) - 1n)).toThrow(/unlimited/);
  });
});

describe('the commit-reveal window', () => {
  it('matches _consumeCommitment: from commit + 60 s, strictly before commit + one day', () => {
    const w = ensRegisterWindow(1_000n);
    expect(w).toEqual({ notBefore: 1_060n, expiresAt: 87_400n });
    expect(ensRegisterTiming(w, 1_059n)).toBe('too-new');
    expect(ensRegisterTiming(w, 1_060n)).toBe('ready');
    expect(ensRegisterTiming(w, 87_399n)).toBe('ready');
    expect(ensRegisterTiming(w, 87_400n)).toBe('expired');
    expect(() => ensRegisterWindow(0n)).toThrow(/not been recorded/);
  });

  it('checkEnsRegisterReady refuses an unrecorded commitment', async () => {
    const plan = planEnsRegistration({ quote: fixtureQuote(), resolver: { address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: false }, secret: SECRET, setReverse: false });
    const key = callKey(ENS_V2_SEPOLIA.ethRegistrar, iface.encodeFunctionData('commitmentAt', [plan.commitment]));
    await expect(checkEnsRegisterReady(replay({ [key]: word(0n) }), plan)).rejects.toMatchObject({ reason: 'commitment' });
    await expect(checkEnsRegisterReady(replay({ [key]: word(0x6ade10c4n - 30n) }), plan)).rejects.toMatchObject({ reason: 'commitment' });
    const avail = callKey(ENS_V2_SEPOLIA.ethRegistrar, iface.encodeFunctionData('isAvailable', ['shibawallet']));
    const ready = await checkEnsRegisterReady(replay({ [key]: word(0x6ade10c4n - 61n), [avail]: word(1n) }), plan);
    expect(ready.now).toBe(0x6ade10c4n);
  });
});

describe('planEnsSubname', () => {
  const resolver: EnsOwnedResolverState = { address: DEV_RESOLVER, salt: ensOwnedResolverSalt(DEV), deployed: true };
  it('registered: deploys the owner registry, links it, registers the sub-label and sets the record', () => {
    const p = planEnsSubname({ parentLabel: 'shibawallet', subLabel: 'smart', owner: DEV, target: KERNEL, resolver, mode: 'registered', parentExpiry: 1795527300n, parentSubregistry: Z, userRegistryDeployed: false, targetReverse: true });
    expect(p.name).toBe('smart.shibawallet.eth');
    expect(p.userRegistry).toBe(getAddress('0x3daf7675fd793d88ff118c40445baa963b100269'));
    expect(p.step.calls.map((c) => c.to)).toEqual([ENS_V2_SEPOLIA.verifiableFactory, ENS_V2_SEPOLIA.ethRegistry, p.userRegistry, DEV_RESOLVER]);
    expect(toHex(p.step.calls[1]!.data)).toBe(iface.encodeFunctionData('setSubregistry', [BigInt(id('shibawallet')), p.userRegistry]));
    expect(toHex(p.step.calls[2]!.data)).toBe(registryRegister.encodeFunctionData('register', ['smart', DEV, Z, DEV_RESOLVER, 0n, 1795527300n]));
    expect(toHex(p.step.calls[3]!.data)).toBe(iface.encodeFunctionData('setAddress', [dnsEncode('smart.shibawallet.eth', 255), 60n, KERNEL]));
    expect(toHex(p.targetReverseCall!.data)).toBe(iface.encodeFunctionData('setName', ['smart.shibawallet.eth']));
  });

  it('record-only: just the address record; refuses a foreign subregistry and a missing resolver', () => {
    const p = planEnsSubname({ parentLabel: 'shibawallet', subLabel: 'smart', owner: DEV, target: KERNEL, resolver, mode: 'record-only', targetReverse: false });
    expect(p.step.calls.length).toBe(1);
    expect(p.targetReverseCall).toBeNull();
    expect(() => planEnsSubname({ parentLabel: 'shibawallet', subLabel: 'smart', owner: DEV, target: KERNEL, resolver, mode: 'registered', parentExpiry: 1n, parentSubregistry: KERNEL, userRegistryDeployed: false, targetReverse: false })).toThrow(/another subregistry/);
    expect(() => planEnsSubname({ parentLabel: 'shibawallet', subLabel: 'smart', owner: DEV, target: KERNEL, resolver: { ...resolver, deployed: false }, mode: 'record-only', targetReverse: false })).toThrow(/no ENS resolver/);
    expect(() => planEnsSubname({ parentLabel: 'shibawallet', subLabel: 'a.b', owner: DEV, target: KERNEL, resolver, mode: 'record-only', targetReverse: false })).toThrow(EnsRegisterError);
  });
});

/** Universal Resolver reverse(address, 60) answers captured at Sepolia block 11991465 (2026-10-25). */
const REVERSE_NONE = { address: '0x16DA2CAeaDa26516F919C6872F6C38AB378CaC5C', data: '0x5d78a2170000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000003c000000000000000000000000000000000000000000000000000000000000001416da2caeada26516f919c6872f6c38ab378cac5c000000000000000000000000', result: '0x00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000322b7581ca210a69c6d0e0d7c88a7688d2789cb00000000000000000000000000000000000000000000000000000000000000000' };
const REVERSE_NAMED = { address: '0xd20186Bb031B61509955BB257869889690568A99', data: '0x5d78a2170000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000003c0000000000000000000000000000000000000000000000000000000000000014d20186bb031b61509955bb257869889690568a99000000000000000000000000', result: '0x0000000000000000000000000000000000000000000000000000000000000060000000000000000000000000fa7a6c22c71ba99a420d0cbccfb545fc459416af000000000000000000000000322b7581ca210a69c6d0e0d7c88a7688d2789cb0000000000000000000000000000000000000000000000000000000000000001168656c676573736f6e2d6465762e657468000000000000000000000000000000' };

describe('readEnsPrimaryName (Universal Resolver reverse)', () => {
  const rev = new Interface(['function reverse(bytes lookupAddress, uint256 coinType) view returns (string, address, address)']);
  const fake = (answer: string | Error, chain = '0xaa36a7'): JsonRpcTransport => (async (method: string) => {
    if (method === 'eth_chainId') return chain;
    if (answer instanceof Error) throw answer;
    return answer;
  }) as JsonRpcTransport;

  it('encodes reverse() like ethers and decodes the captured answers', () => {
    expect(toHex(encodeEnsReverse(REVERSE_NAMED.address))).toBe(REVERSE_NAMED.data);
    expect(toHex(encodeEnsReverse(REVERSE_NAMED.address))).toBe(rev.encodeFunctionData('reverse', [REVERSE_NAMED.address, 60n]));
    const d = decodeEnsReverseResult(toBytes(REVERSE_NAMED.result));
    const e = rev.decodeFunctionResult('reverse', REVERSE_NAMED.result);
    expect(d).toEqual({ name: e[0], resolver: e[1], reverseResolver: e[2] });
    expect(d.name).toBe('helgesson-dev.eth');
  });

  it('reports none, ok, unsupported and offchain, and refuses another chain', async () => {
    expect(await readEnsPrimaryName(fake(REVERSE_NONE.result), REVERSE_NONE.address, 11155111n)).toEqual({ status: 'none' });
    expect(await readEnsPrimaryName(fake(REVERSE_NAMED.result), REVERSE_NAMED.address, 11155111n)).toMatchObject({ status: 'ok', name: 'helgesson-dev.eth' });
    const odd = rev.encodeFunctionResult('reverse', ['Ünicode.eth', DEV_RESOLVER, DEV_RESOLVER]);
    expect(await readEnsPrimaryName(fake(odd), DEV, 11155111n)).toEqual({ status: 'unsupported', name: 'Ünicode.eth' });
    const offchain = Object.assign(new Error('reverted'), { data: '0x556f1830' + '00'.repeat(64) });
    expect(await readEnsPrimaryName(fake(offchain), DEV, 11155111n)).toEqual({ status: 'offchain' });
    await expect(readEnsPrimaryName(fake(REVERSE_NONE.result, '0x1'), DEV, 11155111n)).rejects.toMatchObject({ reason: 'wrong-chain' });
    await expect(readEnsPrimaryName(fake(REVERSE_NONE.result), DEV, 84532n)).rejects.toMatchObject({ reason: 'wrong-chain' });
    await expect(readEnsPrimaryName(fake(REVERSE_NAMED.result + '00'), DEV, 11155111n)).rejects.toMatchObject({ reason: 'malformed' });
  });
});
