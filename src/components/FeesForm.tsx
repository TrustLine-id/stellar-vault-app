// Fee settings of the vault fee library, entered in percent: management (a year), performance,
// optional early-exit tiers. Later changes wait for the curator's SetFees timelock.
import type { Fees } from "../lib/fees";
import { FEE_LIMITS, pct } from "../lib/fees";

export default function FeesForm({ fees, onChange, shareDecimals }: { fees: Fees; onChange: (f: Fees) => void; shareDecimals: number }) {
  const set = (p: Partial<Fees>) => onChange({ ...fees, ...p });
  const bps = (v: string) => Math.round(Number(v || "0") * 100);
  const unit = 10n ** BigInt(shareDecimals);
  const tier = (i: number, p: { shares?: string; rate?: string }) => {
    const next = fees.penalties.map((t, j) => {
      if (j !== i) return t;
      const shares = p.shares !== undefined ? BigInt(Math.max(0, Math.round(Number(p.shares || "0")))) * unit : t[0];
      return [shares, p.rate !== undefined ? bps(p.rate) : t[1]] as [bigint, number];
    });
    set({ penalties: next });
  };
  return (
    <div className="stack">
      <label className="field">Fee receiver
        <input className="mono" value={fees.receiver} onChange={(e) => set({ receiver: e.target.value.trim() })} placeholder="G… or C…" />
      </label>
      <div className="grid2">
        <label className="field">Management fee, % a year (max {pct(FEE_LIMITS.managementBps)})
          <input type="number" min={0} max={5} step={0.1} value={fees.managementBps / 100} onChange={(e) => set({ managementBps: bps(e.target.value) })} />
        </label>
        <label className="field">Performance fee, % of each holder's gain (max {pct(FEE_LIMITS.performanceBps)})
          <input type="number" min={0} max={50} step={1} value={fees.performanceBps / 100} onChange={(e) => set({ performanceBps: bps(e.target.value) })} />
        </label>
      </div>
      <div className="small muted">
        Management fee: paid in new shares, not compounded. Performance fee: on each holder's own gain, paid when it sells.
        Early exit: a sale above a size pays a rate that stays in the vault for the other holders.
      </div>
      {fees.penalties.map(([s, r], i) => (
        <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
          <span className="small muted" style={{ minWidth: 120 }}>Sale above</span>
          <input type="number" min={0} value={Number(s / unit)} onChange={(e) => tier(i, { shares: e.target.value })} />
          <span className="small muted">shares pays</span>
          <input type="number" min={0} max={20} step={0.1} value={r / 100} onChange={(e) => tier(i, { rate: e.target.value })} />
          <span className="small muted">%</span>
          <button className="iconbtn" title="Remove" onClick={() => set({ penalties: fees.penalties.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      {fees.penalties.length < FEE_LIMITS.tiers && (
        <button className="btn link" style={{ justifySelf: "start" }}
          onClick={() => { const last = fees.penalties[fees.penalties.length - 1]; set({ penalties: [...fees.penalties, [(last?.[0] ?? 0n) + 1_000n * unit, last?.[1] ?? 100]] }); }}>
          + Early-exit tier
        </button>
      )}
    </div>
  );
}
