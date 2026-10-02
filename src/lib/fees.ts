// The fees of Trustline's reference vault (TrustLine-id/stellar-vault, fees.rs; specification in
// that repo's docs/VAULT_FEES_SPEC.md). Changes go through the curator timelock (submit SetFees, then set_fees).
//   fees()                  { receiver, management_bps, performance_bps, penalties: [(shares, bps)] }
//   value_of(owner, shares) -> (gross, penalty, performance fee, net paid)
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { view, type Config } from "./chain";

export type Fees = { receiver: string; managementBps: number; performanceBps: number; penalties: [bigint, number][] };
/** The vault's fees and how far ahead a change is announced (its SetFees timelock). */
export type FeeState = { fees: Fees; delaySecs: number };
export type SaleValue = { gross: bigint; penalty: bigint; performance: bigint; paid: bigint };

/** Limits of the library (a submission above them is refused on-chain). */
export const FEE_LIMITS = { managementBps: 500, performanceBps: 5_000, penaltyBps: 2_000, tiers: 8 };

type RawFees = { receiver: string; management_bps: number; performance_bps: number; penalties: [bigint, number][] };
const fromRaw = (f: RawFees): Fees => ({
  receiver: f.receiver, managementBps: Number(f.management_bps), performanceBps: Number(f.performance_bps),
  penalties: (f.penalties ?? []).map(([s, b]) => [BigInt(s), Number(b)] as [bigint, number]),
});

/** The `Fees` struct as a contract argument: a map with its keys sorted. */
export function feesToScVal(f: Fees): xdr.ScVal {
  const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  return xdr.ScVal.scvMap([
    entry("management_bps", nativeToScVal(f.managementBps, { type: "u32" })),
    entry("penalties", penaltiesToScVal(f.penalties)),
    entry("performance_bps", nativeToScVal(f.performanceBps, { type: "u32" })),
    entry("receiver", new Address(f.receiver).toScVal()),
  ]);
}

const penaltiesToScVal = (p: [bigint, number][]) =>
  xdr.ScVal.scvVec(p.map(([s, b]) => xdr.ScVal.scvVec([nativeToScVal(s, { type: "i128" }), nativeToScVal(b, { type: "u32" })])));

/** The arguments of `set_fees` / `SetFees(receiver, management_bps, performance_bps, penalties)`. */
export const proposeFeesArgs = (f: Fees): xdr.ScVal[] => [
  new Address(f.receiver).toScVal(), nativeToScVal(f.managementBps, { type: "u32" }),
  nativeToScVal(f.performanceBps, { type: "u32" }), penaltiesToScVal(f.penalties),
];

/** What the library refuses (its `check`), said before the call; `vault` refuses the vault itself as receiver. */
export function feeProblems(f: Fees, vault?: string): string[] {
  const out: string[] = [];
  if (!StrKey.isValidEd25519PublicKey(f.receiver) && !StrKey.isValidContract(f.receiver)) out.push("Fee receiver: an account (G…) or a contract (C…)");
  else if (vault && f.receiver === vault) out.push("Fee receiver: not the vault itself");
  if (!Number.isInteger(f.managementBps) || f.managementBps < 0 || f.managementBps > FEE_LIMITS.managementBps) out.push("Management fee: 0 to 5% a year");
  if (!Number.isInteger(f.performanceBps) || f.performanceBps < 0 || f.performanceBps > FEE_LIMITS.performanceBps) out.push("Performance fee: 0 to 50%");
  if (f.penalties.length > FEE_LIMITS.tiers) out.push("At most 8 early-exit tiers");
  if (f.penalties.some(([s, b]) => s < 0n || !Number.isInteger(b) || b < 0 || b > FEE_LIMITS.penaltyBps)) out.push("Early-exit tiers: shares from 0, rate from 0% to 20%");
  if (f.penalties.some(([s], i) => i > 0 && s <= f.penalties[i - 1][0])) out.push("Early-exit tiers: increasing share amounts");
  if (f.penalties.some(([, b], i) => i > 0 && b < f.penalties[i - 1][1])) out.push("Early-exit tiers: rates never decrease");
  return out;
}

/** The fees; the delay is the vault's SetFees timelock, filled in by the caller. */
export async function readFees(cfg: Config, contract: string): Promise<FeeState> {
  return { fees: fromRaw(await view<RawFees>(cfg, contract, "fees")), delaySecs: 0 };
}

/** What `owner` would receive for `shares` now, after the early-exit penalty and its performance fee. */
export async function saleValue(cfg: Config, contract: string, owner: string, shares: bigint): Promise<SaleValue> {
  if (shares <= 0n) return { gross: 0n, penalty: 0n, performance: 0n, paid: 0n };
  const [gross, penalty, performance, paid] = await view<[bigint, bigint, bigint, bigint]>(cfg, contract, "value_of", [
    new Address(owner).toScVal(), nativeToScVal(shares, { type: "i128" }),
  ]);
  return { gross, penalty, performance, paid };
}

export const pct = (bps: number) => `${(bps / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
export const fmtFees = (f: Fees) =>
  `management ${pct(f.managementBps)}/year · performance ${pct(f.performanceBps)}${f.penalties.length ? ` · early exit ${f.penalties.map(([, b]) => pct(b)).join(" / ")}` : ""}`;
