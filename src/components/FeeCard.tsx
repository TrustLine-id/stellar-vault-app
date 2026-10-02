// The vault's fees in %, and what they mean for the viewer's holding: the management fee per day
// (an annual rate on the holding's value, paid by minting shares to the receiver) and the
// performance fee on the holding's gain so far (charged when shares are sold, as `value_of` says).
import { pct, type FeeState, type SaleValue } from "../lib/fees";
import { Addr, fmtAmount, fmtDelay } from "./ui";

export default function FeeCard({ fees, holding, symbol, decimals, me, shareDecimals, shareSymbol }: {
  fees: FeeState; symbol: string; decimals: number; me?: string;
  /** The share token, to state the early-exit tiers (counted in shares). */
  shareDecimals?: number; shareSymbol?: string;
  /** The viewer's holding: its value, its cost (fee library cost basis) and what selling it now pays. */
  holding: { value: bigint; cost: bigint; sale: SaleValue | null } | null;
}) {
  const f = fees.fees;
  const amt = (n: bigint) => `${fmtAmount(n, decimals, 4)} ${symbol}`;
  const held = holding && holding.value > 0n ? holding : null;
  const perDay = held ? (held.value * BigInt(f.managementBps)) / 10_000n / 365n : 0n;
  const gain = held ? held.value - held.cost : null;
  const gainPct = gain != null && held!.cost ? Number((gain * 10_000n) / held!.cost) / 100 : null;
  const performance = held?.sale ? held.sale.performance : gain != null && gain > 0n ? (gain * BigInt(f.performanceBps)) / 10_000n : 0n;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Fees</h3>
      <dl className="kv small">
        <dt>Deposit</dt>
        <dd>No fee: you receive shares for the full amount, at the current share price.</dd>
        <dt>Management</dt>
        <dd><b>{pct(f.managementBps)}</b> a year, on the value held
          <div className="muted">{held ? <>On your holding: about <b>{amt(perDay)}</b> a day ({amt(perDay * 365n)} a year), taken as new shares for the receiver.</> : "No holding of yours to apply it to."}</div></dd>
        <dt>Performance</dt>
        <dd><b>{pct(f.performanceBps)}</b> of each holder's own gain, when shares are sold
          <div className="muted">{!held || gain == null ? "No holding of yours to apply it to."
            : gain > 0n ? <>Your gain so far: {amt(gain)}{gainPct != null ? ` (+${gainPct.toLocaleString(undefined, { maximumFractionDigits: 2 })}%)` : ""}. Fee if you sold everything now: <b>{amt(performance)}</b>.</>
            : <>No gain so far ({amt(gain)}): no performance fee if you sold now.</>}</div></dd>
        <dt>Early exit</dt>
        <dd>{f.penalties.length === 0 ? "No penalty on large exits."
          : <>Kept in the vault for the remaining holders, on a single sale of more than:
            <div className="muted">{f.penalties.map(([s, b]) => <div key={String(s)}>{shareDecimals != null ? fmtAmount(s, shareDecimals, 2) : String(s)} {shareSymbol ?? "shares"}: <b>{pct(b)}</b></div>)}</div></>}
          {held?.sale && held.sale.penalty > 0n && <div className="muted">If you sold everything now: {amt(held.sale.penalty)}.</div>}</dd>
        <dt>Receiver</dt><dd><Addr a={f.receiver} size={18} />{me === f.receiver && <div className="muted">You: the fees come back to you.</div>}</dd>
        <dt>Changes</dt><dd>{fees.delaySecs ? `announced ${fmtDelay(fees.delaySecs)} ahead (curator timelock)` : "without advance notice (no delay)"}</dd>
      </dl>
    </div>
  );
}
