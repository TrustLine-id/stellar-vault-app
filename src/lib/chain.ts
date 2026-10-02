// Stellar helpers shared by the app and the scripts: read a contract, send a transaction, deploy,
// keep uploaded code alive, check an approved intent. No wallet import here, so the same code runs
// in the browser and under Node.
import {
  Account, Address, BASE_FEE, Contract, Keypair, Operation, SorobanDataBuilder, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

export type Config = {
  rpcUrl: string;
  networkPassphrase: string;
  /** Trustline's chain id for this network (2 = testnet). */
  backendChainId: string;
};

/** Signs a transaction envelope XDR and returns the signed XDR. */
export type Signer = (txXdr: string) => Promise<string>;

/** Read-only contract call through simulation. */
export async function view<T = unknown>(cfg: Config, contractId: string, method: string, args: xdr.ScVal[] = []): Promise<T> {
  // Simulation does not need a real source account.
  const source = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await new rpc.Server(cfg.rpcUrl).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result!.retval) as T;
}

/** Submit a signed transaction and wait for its result. */
async function send(cfg: Config, signedXdr: string): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const s = new rpc.Server(cfg.rpcUrl);
  const sent = await s.sendTransaction(TransactionBuilder.fromXDR(signedXdr, cfg.networkPassphrase));
  if (sent.status === "ERROR") throw new Error(`Rejected by network: ${sent.errorResult?.result().switch().name ?? "unknown"}`);
  // Polled for as long as the envelope stays valid (DEPLOY_TIMEOUT_SECS).
  const done = await s.pollTransaction(sent.hash, { attempts: DEPLOY_TIMEOUT_SECS });
  if (done.status === rpc.Api.GetTransactionStatus.NOT_FOUND) throw new Error(`Transaction ${sent.hash} was not confirmed while the app waited: check it in the explorer before trying again.`);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`Transaction ${sent.hash} ${done.status}`);
  return done as rpc.Api.GetSuccessfulTransactionResponse;
}

/** How long a deployment or extension envelope stays valid, and how long the app polls for it. */
const DEPLOY_TIMEOUT_SECS = 300;

/** Deploy a contract from uploaded code; `salt` fixes its address in advance, random otherwise. */
export async function deployContract(cfg: Config, deployer: string, wasmHash: string, args: xdr.ScVal[], sign: Signer, salt?: Buffer): Promise<string> {
  const s = new rpc.Server(cfg.rpcUrl);
  const tx = new TransactionBuilder(await s.getAccount(deployer), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(Operation.createCustomContract({
      address: new Address(deployer),
      wasmHash: Buffer.from(wasmHash, "hex"),
      constructorArgs: args,
      salt: salt ?? Buffer.from(Keypair.random().rawPublicKey()),
    }))
    .setTimeout(DEPLOY_TIMEOUT_SECS)
    .build();
  const done = await send(cfg, await sign((await s.prepareTransaction(tx)).toXDR()));
  if (!done.returnValue) throw new Error("Deployment returned no address");
  return Address.fromScVal(done.returnValue).toString();
}

/** Below this many ledgers left (about 29 days at 5 s per ledger), a deployment extends the shared code first. */
const CODE_MIN_TTL = 500_000;
// Rent is paid up front for the whole extension and the fee is a 32-bit number of stroops: 3,000,000
// ledgers of a 40 KB code (the reference vault) do not fit, 1,500,000 (about 87 days) do.
const CODE_EXTEND_TO = 1_500_000;

/**
 * Keep an uploaded contract code alive. The entry is shared by every contract running it, so it is
 * extended here, once, by whoever deploys while it runs low. Returns the ledgers left afterwards.
 */
export async function ensureCodeLive(cfg: Config, payer: string, wasmHash: string, sign: Signer, onExtend?: () => void): Promise<number> {
  const s = new rpc.Server(cfg.rpcUrl);
  const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, "hex") }));
  const [entry, latest] = await Promise.all([s.getLedgerEntries(key), s.getLatestLedger()]);
  const e = entry.entries[0];
  if (!e) throw new Error(`Contract code ${wasmHash.slice(0, 8)}… is not on this network (or has expired)`);
  const left = (e.liveUntilLedgerSeq ?? 0) - latest.sequence;
  if (left >= CODE_MIN_TTL) return left;
  const tx = new TransactionBuilder(await s.getAccount(payer), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo: CODE_EXTEND_TO }))
    .setSorobanData(new SorobanDataBuilder().setReadOnly([key]).build())
    .setTimeout(DEPLOY_TIMEOUT_SECS)
    .build();
  onExtend?.();
  await send(cfg, await sign((await s.prepareTransaction(tx)).toXDR()));
  return CODE_EXTEND_TO;
}

/**
 * Trustline encodes the intent itself (utf8(function) || XDR of the arguments). Before anyone
 * signs, check that the approval it published (`certId`, the intent id) is for the bytes the
 * contract will check: a mismatch would otherwise show only as a failed transaction after signing.
 */
export async function checkIntentId(cfg: Config, engine: string, sender: string, protocol: string, data: Uint8Array, certId: string, value = 0n): Promise<void> {
  const id = await view<Uint8Array>(cfg, engine, "compute_intent_id", [
    nativeToScVal(0, { type: "u32" }), // ValidationMode::Dapp
    new Address(sender).toScVal(),
    new Address(protocol).toScVal(),
    nativeToScVal(value, { type: "i128" }), // the `value` the contract passes to require_trustline
    xdr.ScVal.scvBytes(Buffer.from(data)),
  ]);
  if (Buffer.from(id).toString("hex") !== certId.replace(/^0x/, "").toLowerCase()) {
    throw new Error("Trustline approved other bytes than this contract checks (intent id mismatch): do not sign. Report this to Trustline.");
  }
}

export function toBaseUnits(amount: string, decimals: number): bigint {
  const parts = amount.trim().split(".");
  if (parts.length > 2) throw new Error("Invalid amount");
  const [int, frac = ""] = parts;
  if (!/^\d+$/.test(int || "0") || !/^\d*$/.test(frac) || frac.length > decimals) {
    throw new Error(`Invalid amount (max ${decimals} decimals)`);
  }
  return BigInt((int || "0") + frac.padEnd(decimals, "0"));
}

/**
 * A token's symbol, name and decimals (XLM for the native token). Display reads fall back to
 * placeholders; `strict` rejects when the symbol or the decimals cannot be read, for a deployment
 * that would otherwise bake wrong decimals into a vault.
 */
export async function tokenInfo(cfg: Config, token: string, nativeToken: string, strict = false): Promise<{ symbol: string; name: string; decimals: number }> {
  if (token === nativeToken) return { symbol: "XLM", name: "Stellar Lumens", decimals: 7 };
  const read = <T,>(fn: string, fallback: T) => (strict ? view<T>(cfg, token, fn) : view<T>(cfg, token, fn).catch(() => fallback));
  const [symbol, name, decimals] = await Promise.all([
    read<string>("symbol", "?"),
    view<string>(cfg, token, "name").catch(() => token.slice(0, 6)),
    read<number>("decimals", 7),
  ]);
  return { symbol, name, decimals: Number(decimals) };
}
