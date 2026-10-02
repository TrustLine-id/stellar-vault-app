// The vault client's pure parts: timelocked operations to and from the chain's values, the
// deployment plan's checks, amounts.
//   npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { scValToNative } from "@stellar/stellar-sdk";
import { explain, opExecution, opFromNative, opScVal, OP_KINDS, SHARE_OFFSET, vaultPlanProblems, type PendingOp } from "../src/lib/vault";
import { feeProblems } from "../src/lib/fees";
import { toBaseUnits } from "../src/lib/chain";
import { fmtAmount } from "../src/components/ui";

const G = "GADELLMHQRWZIYL5YJ264LDTAV3C3I2AQI6TV46WTLUYM3BFG36PDS2Q";
const C = "CC3YA6ZKXAIDFA32TQFCHOZPRU7KSQ2HNPCG6W42BLWC7NB63P3CFI6W";
const fees = { receiver: G, managementBps: 100, performanceBps: 0, penalties: [] as [bigint, number][] };

test("every operation survives the trip to the chain's value and back", () => {
  const ops: PendingOp[] = [
    { kind: "AddAdapter", adapter: C }, { kind: "RemoveAdapter", adapter: C },
    { kind: "SetIsAllocator", who: G, enabled: false },
    { kind: "IncreaseTimelock", target: "AddAdapter", seconds: 60 }, { kind: "DecreaseTimelock", target: "SetFees", seconds: 0 },
    { kind: "Abdicate", target: "Abdicate" },
    { kind: "IncreaseAbsoluteCap", adapter: C, cap: 2n ** 126n }, { kind: "IncreaseRelativeCap", adapter: C, cap: 10n ** 18n },
    { kind: "SetFees", fees: { ...fees, penalties: [[1_000n, 100]] } },
  ];
  for (const op of ops) assert.deepEqual(opFromNative(scValToNative(opScVal(op))), op, op.kind);
  assert.equal(opFromNative(["Unknown", C]), null);
  assert.equal(opFromNative("x"), null);
});

test("each kind executes through its own function, with the operation's values", () => {
  assert.deepEqual(OP_KINDS.map((k) => opExecution({ kind: k, adapter: C, who: G, enabled: true, target: k, seconds: 1, cap: 1n, fees } as unknown as PendingOp).fn),
    ["add_adapter", "remove_adapter", "set_is_allocator", "increase_timelock", "decrease_timelock", "abdicate", "increase_absolute_cap", "increase_relative_cap", "set_fees"]);
  const ex = opExecution({ kind: "SetIsAllocator", who: G, enabled: true });
  assert.deepEqual(scValToNative(ex.args[0]), G);
  assert.equal(scValToNative(ex.args[1]), true);
});

test("the deployment plan's checks: the app's own limits and the contract's", () => {
  const plan = { name: "Vault", symbol: "tvXLM", asset: C, assetDecimals: 7, fees, defaultTimelockSecs: 0, engine: { kind: "off" as const, registry: C } };
  assert.deepEqual(vaultPlanProblems(plan), []);
  assert.ok(vaultPlanProblems({ ...plan, symbol: "too long symbol" }).some((p) => p.startsWith("Share symbol")));
  assert.ok(vaultPlanProblems({ ...plan, assetDecimals: 13 }).some((p) => p.includes("decimals")), `asset decimals + ${SHARE_OFFSET} above 18`);
  assert.ok(vaultPlanProblems({ ...plan, defaultTimelockSecs: 400 * 86_400 }).some((p) => p.startsWith("Timelock")));
  assert.ok(vaultPlanProblems({ ...plan, fees: { ...fees, receiver: "not an address" } }).some((p) => p.startsWith("Fee receiver")));
  assert.deepEqual(vaultPlanProblems({ ...plan, name: "  " }), ["Give the vault a name"]);
  assert.deepEqual(vaultPlanProblems({ ...plan, asset: "" }), ["Choose the asset"]);
  assert.deepEqual(vaultPlanProblems({ ...plan, defaultTimelockSecs: -1 }), ["Timelock: 0 to 365 days"]);
  assert.deepEqual(vaultPlanProblems({ ...plan, assetDecimals: 12 }), []);
});

test("fees: the library's limits and the order of the early-exit tiers", () => {
  assert.deepEqual(feeProblems(fees), []);
  assert.deepEqual(feeProblems({ ...fees, receiver: C }), []);
  assert.ok(feeProblems({ ...fees, managementBps: 501 }).length);
  assert.ok(feeProblems({ ...fees, performanceBps: 5_001 }).length);
  assert.ok(feeProblems({ ...fees, penalties: [[1_000n, 100], [500n, 200]] }).some((p) => p.includes("increasing")));
  assert.ok(feeProblems({ ...fees, penalties: [[1_000n, 200], [5_000n, 100]] }).some((p) => p.includes("never decrease")));
  assert.ok(feeProblems({ ...fees, penalties: [[1_000n, 2_001]] }).length);
  assert.deepEqual(feeProblems({ ...fees, penalties: [[0n, 0], [1_000n, 100]] }), [], "what the library accepts: a first tier at 0 shares, a 0% rate");
  assert.ok(feeProblems({ ...fees, penalties: [[1_000n, 100], [1_000n, 200]] }).some((p) => p.includes("increasing")));
  assert.ok(feeProblems({ ...fees, penalties: Array.from({ length: 9 }, (_, i) => [BigInt(i + 1) * 1_000n, 100] as [bigint, number]) }).some((p) => p.includes("8")));
  assert.ok(feeProblems({ ...fees, receiver: C }, C).some((p) => p.includes("not the vault itself")));
  assert.deepEqual(feeProblems({ ...fees, receiver: G }, C), []);
  assert.ok(feeProblems({ ...fees, managementBps: 1.5 }).length, "whole basis points");
});

test("amounts: text to base units and back", () => {
  assert.equal(toBaseUnits("1", 7), 10_000_000n);
  assert.equal(toBaseUnits("0.5", 7), 5_000_000n);
  assert.equal(toBaseUnits("1234.5678901", 7), 12_345_678_901n);
  assert.throws(() => toBaseUnits("1.00000001", 7));
  assert.throws(() => toBaseUnits("-1", 7));
  assert.throws(() => toBaseUnits("1.2.3", 7), "a second dot is not dropped");
  assert.throws(() => toBaseUnits("1..5", 7));
  assert.throws(() => toBaseUnits("abc", 7));
  assert.equal(toBaseUnits(".5", 7), 5_000_000n);
  assert.equal(toBaseUnits("5.", 7), 50_000_000n);
  assert.equal(toBaseUnits("", 7), 0n);
  assert.equal(toBaseUnits(" 12 ", 0), 12n);
  assert.throws(() => toBaseUnits("1.5", 0), "no decimals allowed");
  assert.equal(toBaseUnits("123456789012345678901234567890", 7), 1234567890123456789012345678900000000n);
  assert.equal(fmtAmount(12_345_678_901n, 7), "1,234.5678901");
  assert.equal(fmtAmount(12_345_678_901n, 7, 2), "1,234.56");
  assert.equal(fmtAmount(-5_000_000n, 7), "-0.5");
  assert.equal(fmtAmount(0n, 13), "0");
  assert.equal(fmtAmount(5n, 7), "0.0000005");
  assert.equal(fmtAmount(1_000_000_000_000_000n, 0), "1,000,000,000,000,000");
  assert.equal(fmtAmount(1_234_567_890_123_456_789_012n, 13), "123,456,789.0123456", "7 decimals shown by default");
  assert.equal(fmtAmount(1_234_567_890_123_456_789_012n, 13, 13), "123,456,789.0123456789012");
});

test("a refused call is explained by its number and the function called", () => {
  const code = (n: number) => `HostError: Error(Contract, #${n})`;
  assert.match(explain(code(5), "submit"), /Trustline approval/);
  assert.match(explain(code(6), "deposit"), /sanctions/);
  assert.match(explain(code(5), "deposit"), /Trustline approval/);
  assert.match(explain(code(4), "submit"), /abdicated/);
  assert.match(explain(code(2), "add_adapter"), /not due yet/);
  assert.match(explain(code(3), "set_fees"), /not submitted/);
  assert.match(explain(code(5), "increase_timelock"), /invalid delay/);
  assert.match(explain(code(1), "increase_absolute_cap"), /not above the current/);
  assert.match(explain(code(3), "increase_relative_cap"), /not submitted first, or the new relative cap/);
  assert.match(explain(code(5), "increase_relative_cap"), /above 100%/);
  assert.match(explain(code(7), "allocate"), /absolute cap/);
  assert.match(explain(code(8), "allocate"), /relative cap/);
  assert.match(explain(code(1), "revoke"), /nothing pending/);
  assert.match(explain(code(900), "set_fees"), /library's limits/);
  assert.match(explain(code(10), "allocate"), /idle balance/);
  assert.match(explain(code(10), "deallocate"), /adapter holds less/);
  assert.match(explain('HostError: Error(Contract, #1)\n["contract call failed", "not allocator"]', "allocate"), /not allocator/);
  assert.match(explain("HostError: Error(Auth, InvalidAction)", "deposit"), /not authorized/);
  assert.equal(explain(code(42), "process_withdrawals"), code(42));
});
