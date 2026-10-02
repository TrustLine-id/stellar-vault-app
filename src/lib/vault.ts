// Client for Trustline's reference SEP-56 vault (TrustLine-id/stellar-vault): Morpho
// Vault V2-style roles (owner, curator, allocators, sentinels, queue manager), a curator timelock
// (submit, then anyone executes once due), yield adapters (idle + Σ real_assets), and the vault
// fee library.
//
// Trustline checks what the contract checks, with the sender and value the contract passes to
// `require_trustline`: investors on deposit/mint/withdraw/redeem (value: assets or shares), the
// owner on set_owner/set_curator/set_is_sentinel, the curator on submit and set_queue_manager,
// allocators on allocate/deallocate (value: assets) and set_liquidity_adapter. Executing a due
// timelocked operation (including set_fees and cap raises), revoke, cap cuts, cancel_withdrawal,
// process_withdrawals and accrue need no Trustline approval. Built for stellar-vault 80700c5:
// fee changes and cap raises go through the curator timelock, and a withdrawal the liquidity
// cannot pay waits in a FIFO queue. Every call is signed with the connected account as the
// transaction source.
import { Address, BASE_FEE, Contract, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { validate } from "./trustlineSdk";
import { checkIntentId, deployContract, ensureCodeLive, view, type Config, type Signer } from "./chain";
import { describeCall, intentData, NOT_DESCRIBABLE } from "./structured";
import { feeProblems, feesToScVal, proposeFeesArgs, readFees, saleValue, type FeeState, type Fees, type SaleValue } from "./fees";
import { codeHash, oracleEnabled } from "./trustline";
import { loadSpec } from "./contractSpec";

// ---- Types of the contract ----

export const OP_KINDS = [
  "AddAdapter", "RemoveAdapter", "SetIsAllocator", "IncreaseTimelock", "DecreaseTimelock", "Abdicate",
  "IncreaseAbsoluteCap", "IncreaseRelativeCap", "SetFees",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

export type PendingOp =
  | { kind: "AddAdapter"; adapter: string }
  | { kind: "RemoveAdapter"; adapter: string }
  | { kind: "SetIsAllocator"; who: string; enabled: boolean }
  | { kind: "IncreaseTimelock"; target: OpKind; seconds: number }
  | { kind: "DecreaseTimelock"; target: OpKind; seconds: number }
  | { kind: "Abdicate"; target: OpKind }
  | { kind: "IncreaseAbsoluteCap"; adapter: string; cap: bigint }
  | { kind: "IncreaseRelativeCap"; adapter: string; cap: bigint }
  | { kind: "SetFees"; fees: Fees };

/** Caps are keyed by adapter; the relative cap is a share of total assets in WAD (10^18 = 100%). */
export const WAD = 10n ** 18n;
/** The vault refuses a withdrawal or redemption below this many share units, unless it is the holder's whole balance (queue.rs). */
export const MIN_EXIT_SHARES = 1_000n;
/** An absolute cap at or above this reads "unlimited" (the quick setup sets 2^126). */
export const UNLIMITED_CAP = 2n ** 120n;

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => new Address(a).toScVal();
const kindScVal = (k: OpKind) => xdr.ScVal.scvVec([sym(k)]);
const u64 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: "u64" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

/** A #[contracttype] enum: vec[Symbol(variant), …fields]. */
export function opScVal(op: PendingOp): xdr.ScVal {
  switch (op.kind) {
    case "AddAdapter": case "RemoveAdapter": return xdr.ScVal.scvVec([sym(op.kind), addr(op.adapter)]);
    case "SetIsAllocator": return xdr.ScVal.scvVec([sym(op.kind), addr(op.who), xdr.ScVal.scvBool(op.enabled)]);
    case "IncreaseTimelock": case "DecreaseTimelock": return xdr.ScVal.scvVec([sym(op.kind), kindScVal(op.target), u64(op.seconds)]);
    case "Abdicate": return xdr.ScVal.scvVec([sym(op.kind), kindScVal(op.target)]);
    case "IncreaseAbsoluteCap": case "IncreaseRelativeCap": return xdr.ScVal.scvVec([sym(op.kind), addr(op.adapter), i128(op.cap)]);
    case "SetFees": return xdr.ScVal.scvVec([sym(op.kind), ...proposeFeesArgs(op.fees)]);
  }
}

export function opFromNative(v: unknown): PendingOp | null {
  if (!Array.isArray(v) || typeof v[0] !== "string") return null;
  const [k, a, b] = v as [string, unknown, unknown];
  const target = (x: unknown) => (Array.isArray(x) ? x[0] : x) as OpKind;
  switch (k) {
    case "AddAdapter": case "RemoveAdapter": return { kind: k, adapter: String(a) };
    case "SetIsAllocator": return { kind: k, who: String(a), enabled: b === true };
    case "IncreaseTimelock": case "DecreaseTimelock": return { kind: k, target: target(a), seconds: Number(b) };
    case "Abdicate": return { kind: k, target: target(a) };
    case "IncreaseAbsoluteCap": case "IncreaseRelativeCap": return { kind: k, adapter: String(a), cap: BigInt(b as bigint) };
    case "SetFees": {
      const [, receiver, management, performance, penalties] = v as [string, string, number, number, [bigint, number][]];
      return { kind: k, fees: { receiver, managementBps: Number(management), performanceBps: Number(performance), penalties: (penalties ?? []).map(([sh, bps]) => [BigInt(sh), Number(bps)]) } };
    }
    default: return null;
  }
}

/** The function that executes a due operation, and its arguments. */
export function opExecution(op: PendingOp): { fn: string; args: xdr.ScVal[] } {
  switch (op.kind) {
    case "AddAdapter": return { fn: "add_adapter", args: [addr(op.adapter)] };
    case "RemoveAdapter": return { fn: "remove_adapter", args: [addr(op.adapter)] };
    case "SetIsAllocator": return { fn: "set_is_allocator", args: [addr(op.who), xdr.ScVal.scvBool(op.enabled)] };
    case "IncreaseTimelock": return { fn: "increase_timelock", args: [kindScVal(op.target), u64(op.seconds)] };
    case "DecreaseTimelock": return { fn: "decrease_timelock", args: [kindScVal(op.target), u64(op.seconds)] };
    case "Abdicate": return { fn: "abdicate", args: [kindScVal(op.target)] };
    case "IncreaseAbsoluteCap": return { fn: "increase_absolute_cap", args: [addr(op.adapter), i128(op.cap)] };
    case "IncreaseRelativeCap": return { fn: "increase_relative_cap", args: [addr(op.adapter), i128(op.cap)] };
    case "SetFees": return { fn: "set_fees", args: proposeFeesArgs(op.fees) };
  }
}

const opKey = (op: PendingOp) => opScVal(op).toXDR("base64");

/** A readable label; `asset` formats absolute caps in the asset's units when known. */
export function opLabel(op: PendingOp, asset?: { decimals: number; symbol: string }, short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`): string {
  const cap = (c: bigint) => (c >= UNLIMITED_CAP ? "unlimited" : asset ? `${fmtUnits(c, asset.decimals)} ${asset.symbol}` : `${c} units`);
  switch (op.kind) {
    case "AddAdapter": return `Add adapter ${short(op.adapter)}`;
    case "RemoveAdapter": return `Remove adapter ${short(op.adapter)}`;
    case "SetIsAllocator": return `${op.enabled ? "Make" : "Remove"} ${short(op.who)} ${op.enabled ? "an allocator" : "as allocator"}`;
    case "IncreaseTimelock": return `Raise the ${op.target} delay to ${op.seconds} s`;
    case "DecreaseTimelock": return `Lower the ${op.target} delay to ${op.seconds} s`;
    case "Abdicate": return `Abdicate ${op.target} (disable it for good)`;
    case "IncreaseAbsoluteCap": return `Raise the cap of adapter ${short(op.adapter)} to ${cap(op.cap)}`;
    case "IncreaseRelativeCap": return `Raise the cap of adapter ${short(op.adapter)} to ${Number((op.cap * 10_000n) / WAD) / 100}% of the assets`;
    case "SetFees": return `Set fees: management ${op.fees.managementBps / 100}%/yr, performance ${op.fees.performanceBps / 100}%, ${op.fees.penalties.length} penalty tier(s)`;
  }
}

/** Base units to a plain decimal string (no grouping), trailing zeros dropped. */
function fmtUnits(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return s.slice(0, s.length - decimals) + (frac ? "." + frac : "");
}

// ---- Reads ----

export type AdapterInfo = {
  address: string; realAssets: bigint; liquidAssets: bigint; liquidity: boolean;
  allocation: bigint; absoluteCap: bigint; relativeCap: bigint;
};
export type WithdrawRequest = { id: bigint; owner: string; receiver: string; shares: bigint; cost: bigint; targetAssets: bigint | null };
export type VaultInfo = {
  id: string; name: string; symbol: string; decimals: number; asset: string;
  owner: string; curator: string | null; allocators: string[]; sentinels: string[];
  /** May cancel any waiting withdrawal (queue layer); set by the curator. */
  queueManager: string | null;
  adapters: AdapterInfo[]; liquidityAdapter: string | null;
  idle: bigint; totalAssets: bigint; totalSupply: bigint; assetsPerShare: bigint;
  /** What can be paid out now: idle + the liquidity adapter's liquid assets. */
  availableLiquidity: bigint; queue: WithdrawRequest[];
  engine: string; trustlineOn: boolean | null;
  timelocks: Record<OpKind, { seconds: number; abdicated: boolean }>; defaultTimelock: number;
  fees: FeeState | null; codeHash: string | null;
};

export async function readVault(cfg: Config, id: string): Promise<VaultInfo> {
  const v = <T,>(fn: string, args: xdr.ScVal[] = []) => view<T>(cfg, id, fn, args);
  const [name, symbol, decimals, asset, owner, curator, allocators, sentinels, adapters, queueManager, liquidity, idle, totalAssets, totalSupply, engine, defaultTimelock] = await Promise.all([
    v<string>("name"), v<string>("symbol"), v<number>("decimals"), v<string>("query_asset"), v<string>("owner"),
    v<string | null>("curator"), v<string[]>("allocators"), v<string[]>("sentinels"), v<string[]>("adapters"),
    v<string | null>("queue_manager").catch(() => null),
    v<string | null>("liquidity_adapter"), v<bigint>("idle_assets"), v<bigint>("total_assets"), v<bigint>("total_supply"),
    v<string>("validation_engine"), v<bigint>("default_timelock"),
  ]);
  const one = 10n ** BigInt(decimals);
  const perAdapter = (a: string) => Promise.all([
    view<bigint>(cfg, a, "real_assets").catch(() => -1n), view<bigint>(cfg, a, "liquid_assets").catch(() => -1n),
    v<bigint>("allocation", [addr(a)]).catch(() => 0n), v<bigint>("absolute_cap", [addr(a)]).catch(() => 0n), v<bigint>("relative_cap", [addr(a)]).catch(() => 0n),
  ]);
  const [assetsPerShare, adapterData, tl, fees, hash, trustlineOn, availableLiquidity, queue] = await Promise.all([
    v<bigint>("convert_to_assets", [i128(one)]),
    Promise.all(adapters.map(perAdapter)),
    Promise.all(OP_KINDS.map(async (k) => [k, { seconds: Number(await v<bigint>("timelock", [kindScVal(k)])), abdicated: await v<boolean>("abdicated", [kindScVal(k)]) }] as const)),
    readFees(cfg, id).catch(() => null),
    codeHash(id),
    oracleEnabled(engine),
    v<bigint>("available_liquidity").catch(() => idle),
    v<{ id: bigint; owner: string; receiver: string; shares: bigint; cost: bigint; target_assets: bigint | null }[]>("withdrawal_queue").catch(() => []),
  ]);
  return {
    id, name, symbol, decimals: Number(decimals), asset, owner, curator: curator ?? null, allocators, sentinels, queueManager: queueManager ?? null,
    adapters: adapters.map((a, i) => {
      const [realAssets, liquidAssets, allocation, absoluteCap, relativeCap] = adapterData[i];
      return { address: a, realAssets, liquidAssets, allocation, absoluteCap, relativeCap, liquidity: a === liquidity };
    }),
    liquidityAdapter: liquidity ?? null, idle, totalAssets, totalSupply, assetsPerShare, availableLiquidity,
    queue: queue.map((q) => ({ id: q.id, owner: q.owner, receiver: q.receiver, shares: q.shares, cost: q.cost, targetAssets: q.target_assets ?? null })),
    engine, trustlineOn, timelocks: Object.fromEntries(tl) as VaultInfo["timelocks"], defaultTimelock: Number(defaultTimelock),
    fees, codeHash: hash,
  };
}

export type VaultPosition = { shares: bigint; value: bigint; maxWithdraw: bigint; cost: bigint; sale: SaleValue | null; wallet: bigint };

export async function readPosition(cfg: Config, v: VaultInfo, holder: string): Promise<VaultPosition> {
  const h = [addr(holder)];
  const [shares, maxWithdraw, cost, wallet] = await Promise.all([
    view<bigint>(cfg, v.id, "balance", h), view<bigint>(cfg, v.id, "max_withdraw", h).catch(() => 0n),
    view<bigint>(cfg, v.id, "cost_basis", h).catch(() => 0n), view<bigint>(cfg, v.asset, "balance", h).catch(() => 0n),
  ]);
  const [value, sale] = await Promise.all([
    shares > 0n ? view<bigint>(cfg, v.id, "convert_to_assets", [i128(shares)]) : 0n,
    shares > 0n ? saleValue(cfg, v.id, holder, shares).catch(() => null) : null,
  ]);
  return { shares, value, maxWithdraw, cost, sale, wallet };
}

export type PendingOps = {
  ops: { op: PendingOp; eta: Date }[];
  /** False when the vault's events could not all be read: only the operations this browser submitted are then listed. */
  complete: boolean;
};

/** Operations submitted and still pending: from the vault's `timelock submitted` events (about a week back), confirmed on-chain. */
export async function pendingOps(cfg: Config, v: VaultInfo, extra: PendingOp[] = []): Promise<PendingOps> {
  const found = new Map<string, PendingOp>(extra.map((o) => [opKey(o), o]));
  let complete = false;
  try {
    const s = new rpc.Server(cfg.rpcUrl);
    const health = await s.getHealth();
    const topic = ["timelock", "submitted"].map((t) => xdr.ScVal.scvSymbol(t).toXDR("base64"));
    let req: rpc.Server.GetEventsRequest = {
      startLedger: Math.max(health.oldestLedger, health.latestLedger - 110_000),
      filters: [{ type: "contract", contractIds: [v.id], topics: [topic] }], limit: 200,
    };
    // Each page scans a limited ledger range (about 10,000 ledgers): follow the cursor to the end.
    let last = "";
    for (let page = 0; page < 50; page++) {
      const res = await s.getEvents(req);
      for (const e of res.events) {
        const data = scValToNative(e.value) as unknown[];
        const op = opFromNative(Array.isArray(data) ? data[0] : null);
        if (op) found.set(opKey(op), op);
      }
      if (!res.cursor || res.cursor === last) { complete = true; break; }
      last = res.cursor;
      req = { filters: req.filters, cursor: res.cursor, limit: 200 };
    }
  } catch { /* events unavailable */ }
  const ops: { op: PendingOp; eta: Date }[] = [];
  for (const op of found.values()) {
    const eta = await view<bigint | null>(cfg, v.id, "executable_at", [opScVal(op)]).catch(() => null);
    if (eta != null) ops.push({ op, eta: new Date(Number(eta) * 1000) });
  }
  return { ops: ops.sort((a, b) => a.eta.getTime() - b.eta.getTime()), complete };
}

// ---- Calls ----

/** Who Trustline checks for a call, and with which value (as the contract passes them). */
export type Check = { sender: string; value: bigint } | null;

export type Invest = "deposit" | "mint" | "withdraw" | "redeem";
/** The four investor functions share one shape: (amount, receiver, from | owner, operator), here all the caller. */
export const investArgs = (amount: bigint, me: string) => [i128(amount), addr(me), addr(me), addr(me)];

/**
 * Pre-validate with Trustline (when the vault's engine has its check on), then sign and submit
 * `fn(args)` from `source`. The approved intent id is compared with the bytes the contract will
 * check before anything is signed.
 */
export async function call(cfg: Config, v: VaultInfo, source: string, fn: string, args: xdr.ScVal[], check: Check, sign: Signer, target = v.id): Promise<string> {
  if (check && v.trustlineOn !== false) {
    const data = describeCall(fn, args);
    if (!data) throw new Error(NOT_DESCRIBABLE);
    const res = await validate({ chainId: cfg.backendChainId, senderAddress: check.sender, contractAddress: target, nativeAmount: check.value.toString(), data });
    if (!res.certId) throw new Error("Trustline approved the call but returned no intent id: do not sign. Report this to Trustline.");
    const engine = target === v.id ? v.engine : await view<string>(cfg, target, "validation_engine").catch(() => v.engine);
    await checkIntentId(cfg, engine, check.sender, target, intentData(fn, args), res.certId, check.value);
  }
  return invoke(cfg, source, target, fn, args, sign);
}

/** The dead deposit, right after creation: a small deposit by the owner, so the vault never starts from zero shares. */
export async function seedVault(cfg: Config, v: VaultInfo, me: string, amount: bigint, sign: Signer): Promise<string> {
  return call(cfg, v, me, "deposit", investArgs(amount, me), { sender: me, value: amount }, sign);
}

/** Simulate a call without Trustline: the contract's own refusal, or null if it would pass. */
export async function simulate(cfg: Config, source: string, contract: string, fn: string, args: xdr.ScVal[]): Promise<string | null> {
  const s = new rpc.Server(cfg.rpcUrl);
  const tx = new TransactionBuilder(await s.getAccount(source), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(new Contract(contract).call(fn, ...args)).setTimeout(60).build();
  const sim = await s.simulateTransaction(tx);
  return rpc.Api.isSimulationError(sim) ? explain(sim.error, fn) : null;
}

/**
 * Simulate, sign, submit. One retry when a transaction that passed simulation fails on-chain for
 * lack of a storage entry in its footprint: the vault's management fee is minted only once it
 * reaches a whole share, and when that happens between the simulation and the execution, the
 * execution writes the fee receiver's entries that the simulation did not see. A failed
 * transaction changes nothing but the fee; the new simulation includes them.
 */
export async function invoke(cfg: Config, source: string, contract: string, fn: string, args: xdr.ScVal[], sign: Signer, retried = false): Promise<string> {
  const s = new rpc.Server(cfg.rpcUrl);
  const tx = new TransactionBuilder(await s.getAccount(source), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
    .addOperation(new Contract(contract).call(fn, ...args)).setTimeout(TX_LIFETIME_SECS).build();
  let prepared;
  try { prepared = await s.prepareTransaction(tx); } catch (e) { throw new Error(explain((e as Error).message, fn)); }
  const sent = await s.sendTransaction(TransactionBuilder.fromXDR(await sign(prepared.toXDR()), cfg.networkPassphrase));
  if (sent.status === "ERROR") throw new Error(`Rejected by network: ${sent.errorResult?.result().switch().name ?? "unknown"}`);
  // Polled for as long as the envelope stays valid, so a slow ledger is not reported as a failure.
  const done = await s.pollTransaction(sent.hash, { attempts: TX_LIFETIME_SECS });
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    if (!retried && done.status === rpc.Api.GetTransactionStatus.FAILED && outsideFootprint(done)) {
      return invoke(cfg, source, contract, fn, args, sign, true);
    }
    if (done.status === rpc.Api.GetTransactionStatus.NOT_FOUND) throw new Error(`Transaction ${sent.hash} was not confirmed while the app waited: check it in the explorer before trying again.`);
    throw new Error(`Transaction ${sent.hash} ${done.status}`);
  }
  return sent.hash;
}

/** How long a submitted transaction stays valid, and how long the app polls for it. */
const TX_LIFETIME_SECS = 120;

/** Did the transaction trap on a storage entry missing from its footprint? */
function outsideFootprint(done: unknown): boolean {
  const meta = (done as { resultMetaXdr?: xdr.TransactionMeta }).resultMetaXdr;
  if (!meta) return false;
  try { return Buffer.from(meta.toXDR()).toString("latin1").includes("outside of the footprint"); } catch { return false; }
}

// The vault's error numbers overlap (review point 5): the Validation Engine's 5 and 6, the
// timelock's 1 to 6 and the caps' 1 to 8 are read by the function called.
const ENGINE: Record<string, string> = {
  "5": "no valid Trustline approval for this exact call (engine error 5)",
  "6": "the engine's sanctions screening refused an address (engine error 6)",
};
const NOT_DUE = "the operation is not due yet (timelock)", NOT_SUBMITTED = "the operation was not submitted first", ABDICATED = "this kind of operation was abdicated";
const EXECUTE: Record<string, string> = { "2": NOT_DUE, "3": NOT_SUBMITTED, "4": ABDICATED };
const BY_FUNCTION: Record<string, Record<string, string>> = {
  submit: { "4": ABDICATED, ...ENGINE },
  revoke: { "1": "nothing pending for this operation" },
  add_adapter: EXECUTE, remove_adapter: EXECUTE, set_is_allocator: EXECUTE, set_fees: EXECUTE,
  increase_timelock: { ...EXECUTE, "5": "invalid delay (not a raise, or above one year)" },
  decrease_timelock: { ...EXECUTE, "5": "invalid delay (not a cut)" },
  abdicate: { ...EXECUTE, "6": "already abdicated" },
  increase_absolute_cap: { ...EXECUTE, "1": "the new absolute cap is not above the current one" },
  increase_relative_cap: { ...EXECUTE, "3": "the operation was not submitted first, or the new relative cap is not above the current one", "5": "a relative cap above 100%" },
  decrease_absolute_cap: { "2": "the new absolute cap is not below the current one" },
  decrease_relative_cap: { "4": "the new relative cap is not below the current one" },
  allocate: { ...ENGINE, "6": "the adapter's absolute cap is 0", "7": "above the adapter's absolute cap", "8": "above the adapter's relative cap" },
};

/** A readable reason for a refused call, from the contract error number and the function called. */
export function explain(error: string, fn = ""): string {
  const code = /Error\(Contract, #(\d+)\)/.exec(error)?.[1];
  // A panic message of the vault (e.g. "not allocator"), not the host's generic trace lines.
  const GENERIC = /contract call failed|escalating|caught error|VM call trapped|failing with contract error|failed host function/;
  const panic = [...error.matchAll(/"([a-z][a-z /]+)"/g)].map((m) => m[1]).find((m) => !GENERIC.test(m));
  if (code === "10" || /balance is not sufficient/i.test(error)) {
    return fn === "allocate" ? "Refused: the vault's idle balance is lower than this amount."
      : fn === "deallocate" ? "Refused: the adapter holds less than this amount."
      : "Refused: not enough of the asset where it is taken from (balance too low).";
  }
  if (code === "900") return "Refused: fees outside the library's limits.";
  if (code) {
    const text = BY_FUNCTION[fn]?.[code] ?? (CHECKED.includes(fn) ? ENGINE[code] : undefined);
    if (text) return `Refused: ${text}.`;
  }
  if (panic) return `Refused by the vault: ${panic}.`;
  if (/Error\(Auth/.test(error)) return "Refused: this account is not authorized for this call.";
  return error.split("\n")[0];
}

// ---- Deployment ----

export type VaultPlan = {
  name: string; symbol: string; asset: string; assetDecimals: number;
  /** Initial fees, in force at once; later changes go through the curator timelock (SetFees). */
  fees: Fees; defaultTimelockSecs: number;
  /** "trustline": a dedicated Validation Engine; "off": the same engine with its check switched off (testing, as the vault's own deploy script). */
  engine: { kind: "trustline" | "off"; registry: string };
};

/**
 * Extra decimals of the shares over the asset: the vault's 10^6 virtual shares. One unit of the
 * asset buys 10^6 share units; shares carry the
 * asset's decimals + 6, so that one whole share is worth one unit of the asset at the start.
 */
export const SHARE_OFFSET = 6;

export function vaultPlanProblems(p: VaultPlan): string[] {
  const out: string[] = [];
  if (!p.name.trim()) out.push("Give the vault a name");
  if (!/^[A-Za-z0-9]{1,12}$/.test(p.symbol)) out.push("Share symbol: 1 to 12 letters or digits");
  if (!p.asset) out.push("Choose the asset");
  if (p.assetDecimals + SHARE_OFFSET > 18) out.push("The asset has too many decimals for this vault (max 18)");
  if (!Number.isInteger(p.defaultTimelockSecs) || p.defaultTimelockSecs < 0 || p.defaultTimelockSecs > 365 * 86_400) out.push("Timelock: 0 to 365 days");
  out.push(...feeProblems(p.fees));
  return out;
}

/** The three contracts a deployment creates: the engine, the vault, the reference adapter. */
export type VaultCreated = { vault: string; engine: string; adapter: string };

export async function createVault(
  cfg: Config, me: string, p: VaultPlan, wasm: { vault: string; adapter: string; engine: string }, sign: Signer, progress: (step: number, text: string) => void,
): Promise<VaultCreated> {
  const problems = vaultPlanProblems(p);
  if (problems.length) throw new Error(problems.join("; "));
  await ensureCodeLive(cfg, me, wasm.engine, sign, () => progress(1, "Extending the rent of the shared engine code"));
  await ensureCodeLive(cfg, me, wasm.vault, sign, () => progress(1, "Extending the rent of the shared vault code"));
  progress(1, "Deploying the vault's Validation Engine");
  // TrustlineOracleVE: (admin, auto_validity_secs, manual_validity_secs, max_skew_secs) — registry is baked into the WASM
  const engine = await deployContract(cfg, me, wasm.engine, [addr(me), u64(3600), u64(432_000), u64(60)], sign);
  if (p.engine.kind === "off") {
    progress(1, "Switching the engine's Trustline check off (testing)");
    // (trustline_enabled, sanctions_enabled, sanctions_key: Option<String>)
    await invoke(cfg, me, engine, "set_validation_configuration", [xdr.ScVal.scvBool(false), xdr.ScVal.scvBool(false), xdr.ScVal.scvVoid()], sign);
  }
  progress(2, "Deploying the vault");
  // (validation_engine, asset, owner, decimals, name, symbol, fees, default_timelock)
  const vault = await deployContract(cfg, me, wasm.vault, [
    addr(engine), addr(p.asset), addr(me), nativeToScVal(p.assetDecimals + SHARE_OFFSET, { type: "u32" }),
    nativeToScVal(p.name.trim(), { type: "string" }), nativeToScVal(p.symbol, { type: "string" }),
    feesToScVal(p.fees), u64(p.defaultTimelockSecs),
  ], sign);
  progress(3, "Deploying the reference adapter (holds what the vault allocates to it)");
  await ensureCodeLive(cfg, me, wasm.adapter, sign, () => progress(3, "Extending the rent of the shared adapter code"));
  // (validation_engine, vault, asset, owner)
  const adapter = await deployContract(cfg, me, wasm.adapter, [addr(engine), addr(vault), addr(p.asset), addr(me)], sign);
  return { vault, engine, adapter };
}

/**
 * The roles a new vault needs before anyone can manage it, set by its owner `me`: curator, then
 * queue manager (named by the curator: who cancels a waiting withdrawal that cannot be paid).
 * Neither is timelocked. With Trustline on, each call is approved first (the admin policy).
 */
export async function setupRoles(cfg: Config, me: string, vault: string, sign: Signer, progress: (text: string) => void): Promise<void> {
  const v = await readVault(cfg, vault);
  const check = { sender: me, value: 0n };
  // Roles already held are skipped, so a retry after a failure costs no extra approval.
  if (v.curator !== me) {
    progress("Making you the curator");
    await call(cfg, v, me, "set_curator", [addr(me)], check, sign);
  }
  if (v.queueManager !== me) {
    progress("Making you the queue manager");
    await call(cfg, v, me, "set_queue_manager", [addr(me)], check, sign);
  }
}

/** The transactions `quickSetup` signs: curator, queue manager, the four operations submitted then executed, the liquidity adapter. */
export const QUICK_SETUP_TXS = 2 + 2 * 4 + 1;
/** Extra Freighter approvals when Trustline was on: switch off, then back on (like stellar-vault's deploy script). */
export const QUICK_SETUP_TRUSTLINE_TXS = 2;

/** Thrown when `quickSetup` fails after switching Trustline off for the bootstrap. */
export class QuickSetupError extends Error {
  constructor(message: string, readonly trustlineLeftOff: boolean) {
    super(message);
    this.name = "QuickSetupError";
  }
}

/**
 * Bootstrap shortcut when the timelock is 0: make `me` curator, queue manager and allocator,
 * register the adapter, raise its caps to unlimited (an adapter starts at 0) and make it the
 * liquidity adapter. If the engine's Trustline check is on, it is switched off for these calls
 * and switched back on at the end (same pattern as stellar-vault's deploy-testnet.sh).
 */
export async function quickSetup(cfg: Config, me: string, vault: string, adapter: string, sign: Signer, progress: (text: string) => void): Promise<void> {
  const v = await readVault(cfg, vault);
  if (v.defaultTimelock > 0) throw new Error("The quick setup needs a timelock of 0: with a delay, set the roles and the adapter from the Curator page.");
  const restoreTrustline = v.trustlineOn !== false;
  const setTrustline = (on: boolean) => invoke(cfg, me, v.engine, "set_validation_configuration", [
    xdr.ScVal.scvBool(on), xdr.ScVal.scvBool(false), xdr.ScVal.scvVoid(),
  ], sign);
  let trustlineLeftOff = false;
  try {
    if (restoreTrustline) {
      progress("Switching Trustline off for setup");
      await setTrustline(false);
      trustlineLeftOff = true;
    }
    const go = (fn: string, args: xdr.ScVal[]) => invoke(cfg, me, vault, fn, args, sign);
    progress("Making you the curator");
    await go("set_curator", [addr(me)]);
    progress("Making you the queue manager");
    await go("set_queue_manager", [addr(me)]);
    const ops: PendingOp[] = [
      { kind: "SetIsAllocator", who: me, enabled: true },
      { kind: "AddAdapter", adapter },
      { kind: "IncreaseAbsoluteCap", adapter, cap: 2n ** 126n },
      { kind: "IncreaseRelativeCap", adapter, cap: WAD },
    ];
    for (const op of ops) {
      const label = opLabel(op);
      progress(`${label} (1/2)`);
      await go("submit", [opScVal(op)]);
      const { fn, args } = opExecution(op);
      progress(`${label} (2/2)`);
      await go(fn, args);
    }
    progress("Making it the liquidity adapter");
    await go("set_liquidity_adapter", [addr(me), addr(adapter), xdr.ScVal.scvBytes(Buffer.alloc(0))]);
    if (restoreTrustline) {
      progress("Switching Trustline back on");
      await setTrustline(true);
      trustlineLeftOff = false;
    }
  } catch (e) {
    throw new QuickSetupError((e as Error).message, trustlineLeftOff);
  }
}

// ---- Trustline registration ----

/** Investor functions: approved automatically in this version (pass-through policy). */
const INVESTOR_FNS = ["deposit", "mint", "withdraw", "redeem"];
/** Split registered prototypes into admin (email OTP) and investor (approved automatically). */
export const splitPrototypes = (protos: string[]) => ({
  admin: protos.filter((p) => !INVESTOR_FNS.includes(p.slice(0, p.indexOf("(")))),
  investors: protos.filter((p) => INVESTOR_FNS.includes(p.slice(0, p.indexOf("(")))),
});

/** Functions of the vault that call require_trustline (see the header). */
export const CHECKED = ["deposit", "mint", "withdraw", "redeem", "set_owner", "set_curator", "set_is_sentinel", "submit", "set_queue_manager", "allocate", "deallocate", "set_liquidity_adapter"];

/** A spec type as Trustline's onboarding site writes it: vec<T>, map<K,V>, option<T>, (A,B), a UDT by name. */
function specType(t: xdr.ScSpecTypeDef): string {
  const S = xdr.ScSpecType;
  switch (t.switch()) {
    case S.scSpecTypeVec(): return `vec<${specType(t.vec().elementType())}>`;
    case S.scSpecTypeMap(): return `map<${specType(t.map().keyType())},${specType(t.map().valueType())}>`;
    case S.scSpecTypeOption(): return `option<${specType(t.option().valueType())}>`;
    case S.scSpecTypeTuple(): return `(${t.tuple().valueTypes().map(specType).join(",")})`;
    case S.scSpecTypeUdt(): return t.udt().name().toString();
    default: return t.switch().name.replace(/^scSpecType/, "").toLowerCase();
  }
}

/** The prototypes of `names` as Trustline's onboarding writes them, read from the contract's own interface (absent names skipped). */
async function prototypesOf(cfg: Config, contract: string, names: string[]): Promise<string[]> {
  const spec = await loadSpec(cfg, contract);
  const byName = new Map(spec.funcs().map((f) => [f.name().toString(), f]));
  return names.filter((n) => byName.has(n)).map((n) => `${n}(${byName.get(n)!.inputs().map((i) => specType(i.type())).join(",")})`);
}

/** The vault's prototypes to register with Trustline. */
export const checkedPrototypes = (cfg: Config, contract: string) => prototypesOf(cfg, contract, CHECKED);
