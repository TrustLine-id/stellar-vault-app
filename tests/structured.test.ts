// The description of a call for Trustline (explicit types, positional values) and the intent
// bytes, on the argument shapes the vault uses. `describeCall` re-encodes every description the
// way the backend does and returns null unless the bytes are the same.
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describeCall, intentData } from "../src/lib/structured";
import { investArgs, opScVal, type PendingOp } from "../src/lib/vault";
import { feesToScVal } from "../src/lib/fees";

const G = "GADELLMHQRWZIYL5YJ264LDTAV3C3I2AQI6TV46WTLUYM3BFG36PDS2Q";
const C = "CC3YA6ZKXAIDFA32TQFCHOZPRU7KSQ2HNPCG6W42BLWC7NB63P3CFI6W";
const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

test("investor calls: the four arguments, typed", () => {
  const d = describeCall("deposit", investArgs(10_000_000n, G));
  assert.deepEqual(d, { functionPrototype: "deposit(i128,address,address,address)", args: ["10000000", G, G, G] });
});

test("timelocked operations: a #[contracttype] enum is a vec of its variant and fields", () => {
  const ops: [PendingOp, string][] = [
    [{ kind: "AddAdapter", adapter: C }, "submit(vec<symbol,address>)"],
    [{ kind: "SetIsAllocator", who: G, enabled: true }, "submit(vec<symbol,address,bool>)"],
    [{ kind: "IncreaseTimelock", target: "RemoveAdapter", seconds: 3600 }, "submit(vec<symbol,vec<symbol>,u64>)"],
    [{ kind: "Abdicate", target: "SetFees" }, "submit(vec<symbol,vec<symbol>>)"],
    [{ kind: "IncreaseAbsoluteCap", adapter: C, cap: 2n ** 126n }, "submit(vec<symbol,address,i128>)"],
    [{ kind: "SetFees", fees: { receiver: G, managementBps: 100, performanceBps: 0, penalties: [] } }, "submit(vec<symbol,address,u32,u32,vec<>>)"],
    [{ kind: "SetFees", fees: { receiver: G, managementBps: 100, performanceBps: 1000, penalties: [[1_000n, 100], [5_000n, 200]] } }, "submit(vec<symbol,address,u32,u32,vec<vec<i128,u32>>>)"],
  ];
  for (const [op, proto] of ops) {
    const d = describeCall("submit", [opScVal(op)]);
    assert.ok(d, `describable: ${op.kind}`);
    assert.equal(d.functionPrototype, proto);
  }
});

test("options and bytes: none is void, some is the value, data is hex", () => {
  const none = describeCall("set_liquidity_adapter", [addr(G), xdr.ScVal.scvVoid(), xdr.ScVal.scvBytes(Buffer.alloc(0))]);
  assert.deepEqual(none, { functionPrototype: "set_liquidity_adapter(address,void,bytes)", args: [G, null, "0x"] });
  const some = describeCall("set_liquidity_adapter", [addr(G), addr(C), xdr.ScVal.scvBytes(Buffer.from([1, 2]))]);
  assert.deepEqual(some, { functionPrototype: "set_liquidity_adapter(address,address,bytes)", args: [G, C, "0x0102"] });
});

test("a struct with symbol keys is described field by field, in the contract's order", () => {
  const d = describeCall("x", [feesToScVal({ receiver: G, managementBps: 100, performanceBps: 0, penalties: [] })]);
  assert.ok(d);
  assert.equal(d.functionPrototype, "x(struct{management_bps:u32,penalties:vec<>,performance_bps:u32,receiver:address})");
});

test("every scalar type, a homogeneous map and a nested struct are described and rebuilt", () => {
  const scalars: [xdr.ScVal, string, unknown][] = [
    [xdr.ScVal.scvBool(true), "bool", true], [xdr.ScVal.scvVoid(), "void", null],
    [nativeToScVal(7, { type: "u32" }), "u32", 7], [nativeToScVal(-7, { type: "i32" }), "i32", -7],
    [nativeToScVal(7n, { type: "u64" }), "u64", "7"], [nativeToScVal(-7n, { type: "i64" }), "i64", "-7"],
    [nativeToScVal(2n ** 100n, { type: "u128" }), "u128", String(2n ** 100n)], [nativeToScVal(-(2n ** 100n), { type: "i128" }), "i128", String(-(2n ** 100n))],
    [nativeToScVal(2n ** 200n, { type: "u256" }), "u256", String(2n ** 200n)], [nativeToScVal(-(2n ** 200n), { type: "i256" }), "i256", String(-(2n ** 200n))],
    [xdr.ScVal.scvSymbol("sym"), "symbol", "sym"], [xdr.ScVal.scvString("text"), "string", "text"],
    [xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1700000000")), "timepoint", "1700000000"],
    [xdr.ScVal.scvDuration(xdr.Uint64.fromString("60")), "duration", "60"],
    [xdr.ScVal.scvBytes(Buffer.from("ff00", "hex")), "bytes", "0xff00"],
  ];
  const d = describeCall("f", scalars.map(([v]) => v));
  assert.ok(d);
  assert.equal(d.functionPrototype, `f(${scalars.map(([, t]) => t).join(",")})`);
  assert.deepEqual(d.args, scalars.map(([, , v]) => v));
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: nativeToScVal(1, { type: "u32" }), val: addr(G) }),
    new xdr.ScMapEntry({ key: nativeToScVal(2, { type: "u32" }), val: addr(C) }),
  ]);
  assert.deepEqual(describeCall("m", [map]), { functionPrototype: "m(map<u32,address>)", args: [[[1, G], [2, C]]] });
  const inner = xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: i128(5n) })]);
  const outer = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("inner"), val: inner }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("who"), val: addr(G) }),
  ]);
  assert.deepEqual(describeCall("n", [outer]), { functionPrototype: "n(struct{inner:struct{amount:i128},who:address})", args: [{ inner: { amount: "5" }, who: G }] });
  assert.deepEqual(describeCall("e", [xdr.ScVal.scvVec([])]), { functionPrototype: "e(vec<>)", args: [[]] });
});

test("a map with mixed value types cannot be described", () => {
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: nativeToScVal(1, { type: "u32" }), val: addr(G) }),
    new xdr.ScMapEntry({ key: nativeToScVal(2, { type: "u32" }), val: i128(1n) }),
  ]);
  assert.equal(describeCall("x", [map]), null);
});

test("intent bytes: the name, then the XDR of the only argument or of the vector of all", () => {
  assert.deepEqual(intentData("accrue", []), Buffer.from("accrue"));
  const one = i128(5n);
  assert.deepEqual(intentData("f", [one]), Buffer.concat([Buffer.from("f"), one.toXDR()]));
  const args = investArgs(5n, G);
  assert.deepEqual(intentData("deposit", args), Buffer.concat([Buffer.from("deposit"), xdr.ScVal.scvVec(args).toXDR()]));
});
