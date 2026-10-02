// Headless rehearsal of the vault pages on testnet (Trustline check off),
//   with the app's library and a fresh friendbot-funded key (in memory only):
//   deploy (engine off, vault, reference adapter) → quick setup (curator, queue manager, allocator, adapter, caps, liquidity)
//   → deposit (lands in the liquidity adapter) → deallocate / allocate → a timelocked operation
//   (submit, pending list, not due yet, execute) → fee change through the timelock → redeem →
//   a withdrawal that waits in the queue while the adapter's assets are locked, then is paid.
//   npx tsx scripts/vault-e2e.ts
import { Address, Keypair, nativeToScVal, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { cfg, REFERENCE_VAULT, NATIVE_TOKEN, TRUSTLINE, WASM } from "../src/lib/config";
import { call, createVault, investArgs, opExecution, opScVal, pendingOps, quickSetup, readPosition, readVault, simulate, type PendingOp } from "../src/lib/vault";

const signer = (k: Keypair) => async (x: string) => { const t = TransactionBuilder.fromXDR(x, cfg.networkPassphrase); t.sign(k); return t.toXDR(); };
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(`FAILED: ${what}`); console.log(`  ok: ${what}`); };
const a = Keypair.random(), me = a.publicKey(), sign = signer(a);
if (!(await fetch(`https://friendbot.stellar.org/?addr=${me}`)).ok) throw new Error("friendbot");
const addr = (x: string) => new Address(x).toScVal(), i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

console.log("1. deploy");
const fees = { receiver: me, managementBps: 100, performanceBps: 1000, penalties: [] as [bigint, number][] };
const c = await createVault(cfg, me, { name: "vault e2e", symbol: "tvXLM", asset: NATIVE_TOKEN, assetDecimals: 7, fees, defaultTimelockSecs: 0, engine: { kind: "off", registry: TRUSTLINE.registry } },
  { vault: REFERENCE_VAULT.vault, adapter: REFERENCE_VAULT.adapter, engine: WASM.engine }, sign, (s, t) => console.log(`  ${s} ${t}`));
console.log("  vault", c.vault, "adapter", c.adapter);
await quickSetup(cfg, me, c.vault, c.adapter, sign, (t) => console.log(`  - ${t}`));
let v = await readVault(cfg, c.vault);
check(v.curator === me && v.allocators.includes(me) && v.adapters[0]?.address === c.adapter && v.liquidityAdapter === c.adapter, "curator, allocator, adapter, liquidity adapter");
check(v.decimals === 13 && v.trustlineOn === false, "shares with the asset's 7 decimals + 6; engine check off");
check(v.adapters[0].absoluteCap > 0n && v.adapters[0].relativeCap === 10n ** 18n, "the adapter's caps were raised (absolute unlimited, relative 100%)");

console.log("2. deposit 10 XLM");
await call(cfg, v, me, "deposit", investArgs(100_000_000n, me), { sender: me, value: 100_000_000n }, sign);
v = await readVault(cfg, c.vault);
check(v.adapters[0].realAssets === 100_000_000n && v.idle === 0n, "the deposit went to the liquidity adapter");
await call(cfg, v, me, "deallocate", [addr(me), addr(c.adapter), xdr.ScVal.scvBytes(Buffer.alloc(0)), i128(40_000_000n)], { sender: me, value: 40_000_000n }, sign);
v = await readVault(cfg, c.vault);
check(v.idle === 40_000_000n && v.totalAssets === 100_000_000n, "deallocate 4 XLM back to idle");

console.log("3. timelock");
const raise: PendingOp = { kind: "IncreaseTimelock", target: "RemoveAdapter", seconds: 3600 };
await call(cfg, v, me, "submit", [opScVal(raise)], { sender: me, value: 0n }, sign);
check((await pendingOps(cfg, v)).ops.some((p) => p.op.kind === "IncreaseTimelock"), "submitted operation listed as pending (from events)");
const ex = opExecution(raise);
await call(cfg, v, me, ex.fn, ex.args, null, sign);
v = await readVault(cfg, c.vault);
check(v.timelocks.RemoveAdapter.seconds === 3600, "RemoveAdapter delay raised to 1 hour");
const rm: PendingOp = { kind: "RemoveAdapter", adapter: c.adapter };
await call(cfg, v, me, "submit", [opScVal(rm)], { sender: me, value: 0n }, sign);
const refused = await simulate(cfg, me, c.vault, "remove_adapter", [addr(c.adapter)]);
check(/not due yet/.test(refused ?? ""), `remove_adapter before the hour: ${refused}`);
await call(cfg, v, me, "revoke", [addr(me), opScVal(rm)], null, sign);
check(!(await pendingOps(cfg, v)).ops.some((p) => p.op.kind === "RemoveAdapter"), "revoked");

console.log("4. fees and redeem");
const setFees: PendingOp = { kind: "SetFees", fees: { ...fees, managementBps: 200 } };
await call(cfg, v, me, "submit", [opScVal(setFees)], { sender: me, value: 0n }, sign);
check((await pendingOps(cfg, v)).ops.some((p) => p.op.kind === "SetFees"), "fee change submitted and pending");
const fx = opExecution(setFees);
await call(cfg, v, me, fx.fn, fx.args, null, sign);
v = await readVault(cfg, c.vault);
check(v.fees?.fees.managementBps === 200, "fee change applied with set_fees");
const pos = await readPosition(cfg, v, me);
await call(cfg, v, me, "redeem", investArgs(pos.shares / 2n, me), { sender: me, value: pos.shares / 2n }, sign);
const after = await readPosition(cfg, await readVault(cfg, c.vault), me);
check(after.shares >= pos.shares - pos.shares / 2n && after.shares < pos.shares, `redeemed half (${pos.shares / 2n} shares; the test account also receives the management fee in shares)`);

console.log("5. withdrawal queue");
v = await readVault(cfg, c.vault);
if (v.idle > 0n) await call(cfg, v, me, "allocate", [addr(me), addr(c.adapter), xdr.ScVal.scvBytes(Buffer.alloc(0)), i128(v.idle)], { sender: me, value: v.idle }, sign);
v = await readVault(cfg, c.vault);
await call(cfg, v, me, "lock", [i128(v.adapters[0].realAssets)], null, sign, c.adapter); // the reference adapter's assets are "working": not liquid
v = await readVault(cfg, c.vault);
check(v.availableLiquidity === 0n && v.adapters[0].liquidAssets === 0n, "nothing liquid: all assets locked in the adapter");
await call(cfg, v, me, "withdraw", investArgs(10_000_000n, me), { sender: me, value: 10_000_000n }, sign);
v = await readVault(cfg, c.vault);
check(v.queue.length === 1 && v.queue[0].owner === me && v.queue[0].targetAssets === 10_000_000n, "withdraw of 1 XLM waits in the queue");
const held = v.totalSupply;
await call(cfg, v, me, "cancel_withdrawal", [addr(me), nativeToScVal(v.queue[0].id, { type: "u64" })], null, sign);
v = await readVault(cfg, c.vault);
check(v.queue.length === 0 && v.totalSupply === held, "the request is cancelled: the shares are back, nothing was paid");
await call(cfg, v, me, "withdraw", investArgs(10_000_000n, me), { sender: me, value: 10_000_000n }, sign);
v = await readVault(cfg, c.vault);
check(v.queue.length === 1, "asked again: waits again");
await call(cfg, v, me, "lock", [i128(0n)], null, sign, c.adapter);
const before = (await readPosition(cfg, v, me)).wallet;
await call(cfg, v, me, "process_withdrawals", [nativeToScVal(10, { type: "u32" })], null, sign);
v = await readVault(cfg, c.vault);
const paid = (await readPosition(cfg, v, me)).wallet - before;
check(v.queue.length === 0 && paid > 9_000_000n, `queue processed once liquid: received ${paid} stroops (net of fees and the transaction fee)`);
console.log("done");
