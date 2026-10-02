// One vault (Trustline's reference SEP-56 vault): a sidebar and sections.
//   Overview      figures, allocation, roles, parameters, the invest link
//   Investor      your position; invest (deposit / mint) and sell (withdraw / redeem, the queue)
//   Management:
//     Allocation  adapters, allocate / deallocate (allocators; sentinels deallocate), liquidity adapter
//     Curator     timelocked operations (submit, execute when due, revoke), delays, caps, fees
//     Admin       the owner's, sentinels' and queue manager's actions, Trustline and its switch
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { useApp } from "../state";
import { cfg, EARLIER_CODE, explorer, REFERENCE_VAULT, TRUSTLINE } from "../lib/config";
import { toBaseUnits, view } from "../lib/chain";
import { readEngine, switchTrustline, transferEngineAdmin, type EngineInfo } from "../lib/engine";
import { feeProblems, fmtFees, type Fees } from "../lib/fees";
import {
  call, checkedPrototypes, CHECKED, MIN_EXIT_SHARES, OP_KINDS, splitPrototypes, opExecution, opLabel, opScVal, SHARE_OFFSET, simulate,
  investArgs, seedVault, UNLIMITED_CAP, WAD, type Invest, type OpKind, type PendingOp,
} from "../lib/vault";
import { forgetVault, listVaults, rememberVaultOp, saveVault } from "../lib/store";
import { vaultStatus, useVault, type VaultState } from "../useVault";
import { Addr, copyText, CopyText, fmtAmount, fmtDelay, Identicon, short } from "../components/ui";
import FeesForm from "../components/FeesForm";
import Seed from "../components/Seed";
import FeeCard from "../components/FeeCard";

type P = { v: VaultState; refresh: () => Promise<void> };
/** Top-level pages, then the Management group's pages. */
const NAV: [string, string, string][] = [["overview", "⌂", "Overview"], ["invest", "◈", "Investor"]];
/** The Management group. */
const ADMIN: [string, string, string][] = [["allocation", "⇄", "Allocation"], ["curator", "⏱", "Curator"], ["admin", "⚙", "Admin"]];
const PAGES = [...NAV, ...ADMIN];
const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const noData = () => xdr.ScVal.scvBytes(Buffer.alloc(0));

export default function VaultView({ id, page: route = "overview" }: { id: string; page?: string }) {
  const { me } = useApp();
  const { state: v, error, refresh } = useVault(id, me?.address);
  const page = PAGES.some(([k]) => k === route) ? route : "overview";
  const inAdmin = ADMIN.some(([k]) => k === page);
  const [adminOpen, setAdminOpen] = useState(inAdmin);
  useEffect(() => { if (inAdmin) setAdminOpen(true); }, [inAdmin]);
  const st = vaultStatus(v);
  let body: ReactElement;
  if (error && !v) body = <div className="banner bad">Could not read this vault: {error}</div>;
  else if (!v) body = <div className="muted">Loading the vault from the network…</div>;
  else {
    const p = { v, refresh };
    body = (
      <div className="stack" style={{ gap: 16 }}>
        <div className="pagehead" style={{ marginBottom: 0 }}><h1>{PAGES.find(([k]) => k === page)![2]}</h1></div>
        {error && <div className="banner warn">The last refresh failed: {error}. The figures may be stale; the page retries every 30 seconds.</div>}
        {v.info.trustlineOn === false && <div className="banner warn">Trustline's check is <b>off</b> on this vault's engine (testing): every call goes through without an approval. The Trustline owner can switch it on (Management, Admin).</div>}
        {v.info.totalSupply === 0n && (page === "overview" || page === "invest") && <Unseeded {...p} />}
        {page === "invest" ? <div className="stack" style={{ gap: 16 }}>
            <PositionCard {...p} />
            <div className="grid2" style={{ alignItems: "start" }}>
              <div className="stack" style={{ gap: 16 }}><InvestCard {...p} /><AllocationRecap v={v} /><VaultFees v={v} me={me?.address} /></div>
              <ExitCard {...p} />
            </div>
          </div>
          : page === "allocation" ? <Allocation {...p} />
          : page === "curator" ? <Curator {...p} />
          : page === "admin" ? <Admin {...p} />
          : <Overview {...p} />}
      </div>
    );
  }
  return (
    <div className="body">
      <aside className="sidebar">
        <div className="vaultcard">
          <div className="head">
            <Identicon address={id} size={40} />
            <div style={{ minWidth: 0 }}>
              <div className="name">{v?.info.name ?? "Vault"}</div>
              <CopyText text={id} className="mono muted small">{short(id)}</CopyText>
            </div>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <div className="small muted">Your shares</div>
            <div className="bal">{v?.position ? `${fmtAmount(v.position.shares, v.info.decimals, 2)} ${v.info.symbol}` : "…"}</div>
            <div className="small muted">worth <b className="mono" style={{ color: "var(--ink)" }}>{v?.position ? `${fmtAmount(v.position.value, v.asset.decimals, 2)} ${v.asset.symbol}` : "…"}</b></div>
          </div>
          <span className={`pill ${st.cls}`} style={{ justifySelf: "start" }}><span className="dot" />{st.text}</span>
          <a className="btn primary" href={`#/vault/${id}/invest`} style={{ justifySelf: "start", minWidth: 120 }}>Invest</a>
        </div>
        <nav className="nav">
          {NAV.map(([k, icon, label]) => (
            <a key={k} className={page === k ? "on" : ""} href={`#/vault/${id}/${k}`}><span>{icon}</span>{label}</a>
          ))}
          <button className={`navgroup${inAdmin ? " in" : ""}`} aria-expanded={adminOpen} onClick={() => setAdminOpen((o) => !o)}>
            <span>⚑</span>Management{!adminOpen && v && v.pending.length > 0 && <span className="count">{v.pending.length}</span>}<span className="caret" aria-hidden>{adminOpen ? "▾" : "▸"}</span>
          </button>
          {adminOpen && ADMIN.map(([k, icon, label]) => (
            <a key={k} className={`sub${page === k ? " on" : ""}`} href={`#/vault/${id}/${k}`}>
              <span>{icon}</span>{label}{k === "curator" && v && v.pending.length > 0 && <span className="count">{v.pending.length}</span>}
            </a>
          ))}
        </nav>
        <a className="muted small" href="#/vaults">← All vaults</a>
      </aside>
      <main className="main">{body}</main>
    </div>
  );
}

// ---- shared ----

function Row({ k, children }: { k: ReactNode; children: ReactNode }) { return <><dt>{k}</dt><dd>{children}</dd></>; }
const Note = ({ children, cls = "muted" }: { children: ReactNode; cls?: string }) => <div className={`small ${cls}`}>{children}</div>;

/** The connected account's roles. A watched account keeps its roles but cannot sign (`canSign`). */
function useRoles(v: VaultState) {
  const { me } = useApp();
  const a = me?.address ?? "";
  return {
    me: a,
    canSign: !!me && !me.readOnly,
    owner: !!a && v.info.owner === a,
    curator: !!a && v.info.curator === a,
    allocator: !!a && v.info.allocators.includes(a),
    sentinel: !!a && v.info.sentinels.includes(a),
    queueManager: !!a && v.info.queueManager === a,
  };
}
/** Why a role's actions are disabled: the role is not held, or it is held by a watched account. */
const cannot = (r: { canSign: boolean }, holds: boolean, role: string) =>
  holds ? (r.canSign ? "" : `Watch-only: connect Freighter to act as ${role}. `) : `Your account is not ${role}. `;

/** Run an on-chain action with a status line and a result banner. */
function useRunner(refresh: () => Promise<void>) {
  const { toast } = useApp();
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; hash?: string } | null>(null);
  const run = (label: string, fn: () => Promise<string | void>) => async () => {
    setBusy(label); setResult(null);
    try {
      const hash = await fn();
      setResult({ ok: true, text: `${label}: done`, hash: hash || undefined });
      toast(`${label}: done`, "ok");
      await refresh();
    } catch (e) { setResult({ ok: false, text: `${label}: ${(e as Error).message}` }); await refresh().catch(() => undefined); }
    setBusy("");
  };
  const banner = result && (
    <div className={`banner ${result.ok ? "ok" : "bad"}`}>{result.text}
      {result.hash && <> · <a href={explorer.tx(result.hash)} target="_blank" rel="noreferrer">transaction ↗</a></>}</div>
  );
  return { busy, run, banner };
}

function amountInput(value: string, set: (s: string) => void, unit: string, max?: { value: bigint; decimals: number }) {
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={`0.0 ${unit}`} inputMode="decimal" />
      {max && max.value > 0n && <button className="btn sm" onClick={() => set(fmtAmount(max.value, max.decimals, max.decimals).replace(/,/g, ""))}>Max</button>}
    </div>
  );
}
const parse = (s: string, d: number): bigint | null => { try { return s ? toBaseUnits(s, d) : null; } catch { return null; } };

// ---- Overview ----

/** No shares yet: offer the dead deposit, and say what a direct transfer already left here. */
function Unseeded({ v, refresh }: P) {
  const { me, sign } = useApp();
  const blocked = !me || me.readOnly ? "Connect Freighter to seed it."
    : undefined;
  return (
    <div className="banner warn stack">
      <div><b>This vault has no shares yet.</b> Make the dead deposit before anyone invests. Never send the asset to the vault's address
        directly: a transfer is not a deposit and gives no shares.</div>
      {v.info.totalAssets > 0n && <div className="small">{fmtAmount(v.info.totalAssets, v.asset.decimals)} {v.asset.symbol} already sit here without shares (a direct transfer):
        they belong to no holder and stay in the vault.</div>}
      <Seed symbol={v.asset.symbol} decimals={v.asset.decimals} blocked={blocked}
        seed={(units) => seedVault(cfg, v.info, me!.address, units, sign)} onDone={() => { void refresh(); }} />
    </div>
  );
}

function Overview({ v }: P) {
  const d = v.asset.decimals, i = v.info;
  const allocated = i.totalAssets - i.idle;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid3">
        <div className="card"><div className="small muted">Total assets</div><div className="big">{fmtAmount(i.totalAssets, d, 2)}</div><div className="muted">{v.asset.symbol} · idle {fmtAmount(i.idle, d, 2)}, in adapters {fmtAmount(allocated, d, 2)}</div></div>
        <div className="card"><div className="small muted">Share price</div><div className="big">{fmtAmount(i.assetsPerShare, d, 6)}</div><div className="muted">{v.asset.symbol} per {i.symbol}</div></div>
        <div className="card"><div className="small muted">Total shares</div><div className="big">{fmtAmount(i.totalSupply, i.decimals, 2)}</div><div className="muted">{i.symbol} in issue</div></div>
      </div>
      <VaultInApp v={v} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Allocation</h3>
        <AllocationBars v={v} />
        <a className="small" href={`#/vault/${i.id}/allocation`}>Allocation →</a>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Roles</h3>
        <RolesList v={v} />
        <h3 style={{ margin: "8px 0 0" }}>Governance</h3>
        <dl className="kv small">
          <Row k="Timelock">{Object.values(i.timelocks).every((t) => t.seconds === 0) ? "none" : `up to ${fmtDelay(Math.max(...Object.values(i.timelocks).map((t) => t.seconds)))}`} · {v.pending.length} pending</Row>
          {i.fees && <Row k="Fees">{fmtFees(i.fees.fees)}</Row>}
        </dl>
        <a className="small" href={`#/vault/${i.id}/admin`}>Admin →</a>
      </div>
      <ParametersCard v={v} />
    </div>
  );
}

/** Share the vault's invest link; keep it in this browser's list or not. */
function VaultInApp({ v }: { v: VaultState }) {
  const { toast } = useApp();
  const [known, setKnown] = useState(() => listVaults().some((x) => x.vault === v.info.id));
  const link = `${location.origin}${location.pathname}#/vault/${v.info.id}/invest`;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Link & Bookmark</h3>
      <div className="small muted">Share a link that opens the vault's Investor page, and keep the vault in this browser's list or not.</div>
      <div className="row">
        <button className="btn sm" onClick={() => copyText(link).then(() => toast("Invest link copied", "ok"))}>Copy invest link</button>
        {known ? <button className="btn sm" onClick={() => { forgetVault(v.info.id); setKnown(false); toast("Removed from this browser's list", "ok"); }}>Remove from my list</button>
          : <button className="btn sm" onClick={() => { saveVault({ vault: v.info.id, name: v.info.name, createdAt: new Date().toISOString() }); setKnown(true); toast("Added", "ok"); }}>Add to my list</button>}
      </div>
    </div>
  );
}

/** Every role of the vault, who holds it, and what it may do; and the Trustline owner, who holds the Trustline switch. */
function RolesList({ v }: { v: VaultState }) {
  const { me } = useApp();
  const i = v.info;
  const [engineAdmin, setEngineAdmin] = useState<string | null>(null);
  useEffect(() => { readEngine(i.engine).then((e) => setEngineAdmin(e.admin)).catch(() => setEngineAdmin(null)); }, [i.engine]);
  const you = (a: string | null) => (a && me && a === me.address ? " (you)" : "");
  const youAmong = (list: string[]) => (me && list.includes(me.address) ? " (you)" : "");
  return (
    <dl className="kv small">
      <Row k={`Owner${you(i.owner)}`}><Addr a={i.owner} size={20} /><Note>Names the curator, adds and removes sentinels, hands over ownership. Each checked by Trustline.</Note></Row>
      <Row k={`Curator${you(i.curator)}`}>{i.curator ? <Addr a={i.curator} size={20} /> : <span className="warn">not set</span>}<Note>Submits the timelocked operations (adapters, allocators, caps up, fees, delays, abdication) and names the queue manager, each checked by Trustline; revokes pending operations and lowers caps, not checked.</Note></Row>
      <Row k={`Allocators${youAmong(i.allocators)}`}>{i.allocators.length ? i.allocators.map((a) => <div key={a}><Addr a={a} size={20} /></div>) : "none"}<Note>Allocate to and deallocate from adapters, choose the liquidity adapter. Each checked by Trustline. Named by the curator, through the timelock.</Note></Row>
      <Row k={`Sentinels${youAmong(i.sentinels)}`}>{i.sentinels.length ? i.sentinels.map((a) => <div key={a}><Addr a={a} size={20} /></div>) : "none"}<Note>Reduce risk: revoke pending operations and lower caps (not checked by Trustline), deallocate (checked by Trustline).</Note></Row>
      <Row k={`Queue manager${you(i.queueManager)}`}>{i.queueManager ? <Addr a={i.queueManager} size={20} /> : "none"}<Note>Cancels any waiting withdrawal, giving the shares back to their owner. Not checked by Trustline; naming it is.</Note></Row>
      <Row k="Anyone">Executes a timelocked operation once its delay has passed, processes the withdrawal queue, accrues the management fee.</Row>
      <Row k="Investors">Anyone the vault's Trustline policy lets through.</Row>
      <Row k={`Trustline owner${you(engineAdmin)}`}>{engineAdmin ? <Addr a={engineAdmin} size={20} /> : "…"}<Note>The administrator of the vault's Validation Engine, given to the engine at deployment (the account that deployed the vault) and handed over from Admin. Switches Trustline's check off, which lets every call through, and on again. Neither is checked by Trustline.</Note></Row>
    </dl>
  );
}

/** The vault's fixed parameters: address, asset, share token, code. */
function ParametersCard({ v }: { v: VaultState }) {
  const earlier = EARLIER_CODE.vault.find((e) => e.hash === v.info.codeHash);
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Parameters</h3>
      <dl className="kv small">
        <Row k="Vault"><Addr a={v.info.id} label={v.info.name} /></Row>
        <Row k="Asset"><Addr a={v.info.asset} label={`${v.asset.symbol} (${v.asset.name}), ${v.asset.decimals} decimals`} /></Row>
        <Row k="Shares">{v.info.symbol}, {v.info.decimals} decimals{v.info.decimals !== v.asset.decimals + SHARE_OFFSET && <Note cls="warn">Not the asset's decimals + {SHARE_OFFSET} (this app's convention, so that one share is worth one asset unit at the start): share amounts display {v.info.decimals < v.asset.decimals + SHARE_OFFSET ? "larger" : "smaller"} than their value.</Note>}</Row>
        <Row k="Code"><span className="mono">{v.info.codeHash ?? "unknown"}</span><Note cls={v.knownCode || earlier ? "ok" : "warn"}>{v.knownCode ? `The build of ${REFERENCE_VAULT.repo}@${REFERENCE_VAULT.commit} this app deploys.` : earlier ? `An earlier build of ${REFERENCE_VAULT.repo} (${earlier.commit}): ${earlier.note}` : "Another build (e.g. a deploy from the vault repository at another commit)."}</Note></Row>
        <Row k="Upgrade">No upgrade function: the code is fixed.</Row>
      </dl>
    </div>
  );
}

/** The curator names the queue manager, who may cancel any waiting withdrawal. */
function QueueManagerCard({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const [manager, setManager] = useState("");
  const valid = (a: string) => StrKey.isValidEd25519PublicKey(a.trim()) || StrKey.isValidContract(a.trim());
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Queue manager</h3>
      <div className="small">Now: {v.info.queueManager ? <Addr a={v.info.queueManager} size={18} /> : "none"}</div>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input className="mono" aria-label="Queue manager" value={manager} onChange={(e) => setManager(e.target.value)} placeholder={v.info.queueManager ? "G… or C…, empty to clear" : "G… or C…"} />
        <button className="btn" disabled={!r.curator || !r.canSign || !!busy || (manager.trim() ? !valid(manager) : !v.info.queueManager)} onClick={run(manager.trim() ? "Name the queue manager" : "Clear the queue manager", () =>
          call(cfg, v.info, r.me, "set_queue_manager", [manager.trim() ? addr(manager.trim()) : xdr.ScVal.scvVoid()], { sender: r.me, value: 0n }, sign))}>{manager.trim() || !v.info.queueManager ? "Set" : "Clear"}</button>
      </div>
      <Note>Cancels any waiting withdrawal; the shares and their cost go back to the request's owner. Named by the curator, checked by Trustline.</Note>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

function AllocationBars({ v }: { v: VaultState }) {
  const d = v.asset.decimals, t = v.info.totalAssets;
  const rows = [{ label: "Idle in the vault", amount: v.info.idle, liq: false, a: "" }, ...v.info.adapters.map((x) => ({ label: short(x.address), amount: x.realAssets, liq: x.liquidity, a: x.address }))];
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r) => (
        <div key={r.label} className="stack" style={{ gap: 3 }}>
          <div className="between small"><span>{r.a ? <Addr a={r.a} size={16} /> : r.label}{r.liq && <span className="pill blue" style={{ marginLeft: 6 }}>liquidity</span>}</span>
            <span className="mono">{r.amount < 0n ? "unreadable" : `${fmtAmount(r.amount, d, 2)} ${v.asset.symbol}`}</span></div>
          <div className="progress"><div style={{ width: `${t > 0n && r.amount > 0n ? Number((r.amount * 1000n) / t) / 10 : 0}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

// ---- Investor ----

const ACTIONS: { k: Invest; label: string; unit: "asset" | "share"; help: string }[] = [
  { k: "deposit", label: "Deposit", unit: "asset", help: "Put in an amount of the asset, receive shares." },
  { k: "withdraw", label: "Withdraw", unit: "asset", help: "Take out an exact amount of the asset; fees on your gain and any early-exit penalty are taken from your shares." },
  { k: "redeem", label: "Redeem", unit: "share", help: "Return shares, receive their value net of fees." },
  { k: "mint", label: "Mint", unit: "share", help: "Receive an exact number of shares, paying what they cost." },
];
type Attempt = { at: Date; label: string; kind: "allowed" | "refused" | "probe"; ok: boolean; detail: string; hash?: string };

/** Every fee of the vault, and what each means for the viewer's holding. */
function VaultFees({ v, me }: { v: VaultState; me?: string }) {
  const i = v.info;
  if (!i.fees) return null;
  return <FeeCard fees={{ ...i.fees, delaySecs: i.timelocks.SetFees.seconds }} symbol={v.asset.symbol} decimals={v.asset.decimals} me={me}
    shareDecimals={i.decimals} shareSymbol={i.symbol}
    holding={v.position ? { value: v.position.value, cost: v.position.cost, sale: v.position.sale } : null} />;
}

/** Where the deposits go: each adapter with what it holds and its caps. */
function AllocationRecap({ v }: { v: VaultState }) {
  const i = v.info, d = v.asset.decimals, sym = v.asset.symbol;
  const pct = (w: bigint) => `${Number((w * 10_000n) / WAD) / 100}%`;
  const share = (x: bigint) => (i.totalAssets > 0n ? `${(Number((x * 10_000n) / i.totalAssets) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : "0%");
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Adapters and caps</h3>
      <dl className="kv small">
        {i.adapters.length === 0 && <Row k="Adapters">none: every deposit stays idle in the vault</Row>}
        {i.adapters.map((x, n) => <Row key={x.address} k={i.adapters.length > 1 ? `Adapter ${n + 1}` : "Adapter"}>
          <Addr a={x.address} size={16} />{x.liquidity && <span className="pill blue" style={{ marginLeft: 6 }}>liquidity</span>}
          <div>{x.realAssets < 0n ? "unreadable" : `${fmtAmount(x.realAssets, d, 2)} ${sym} · ${share(x.realAssets)}`}</div>
          <Note>caps: {x.absoluteCap >= UNLIMITED_CAP ? "unlimited" : `${fmtAmount(x.absoluteCap, d, 2)} ${sym}`} · {pct(x.relativeCap)} of total assets</Note>
        </Row>)}
      </dl>
    </div>
  );
}

/** Deposit / mint: the page's main action, in a highlighted card. */
function InvestCard(p: P) {
  return <div className="card stack accent"><h3 style={{ margin: 0 }}>Invest</h3><ActionForm {...p} kinds={["deposit", "mint"]} cta /></div>;
}

/** The deposit, mint, withdraw or redeem form, for the actions given; `cta` styles the main button as the page's call to action. */
function ActionForm({ v, refresh, kinds, cta }: P & { kinds: Invest[]; cta?: boolean }) {
  const { me, sign } = useApp();
  const [action, setAction] = useState<Invest>(kinds[0]);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ key: string; out: bigint } | null>(null);
  const [step, setStep] = useState("");
  const [log, setLog] = useState<Attempt[]>([]);
  const a = ACTIONS.find((x) => x.k === action)!;
  const inDec = a.unit === "asset" ? v.asset.decimals : v.info.decimals;
  const outDec = a.unit === "asset" ? v.info.decimals : v.asset.decimals;
  const inSym = a.unit === "asset" ? v.asset.symbol : v.info.symbol, outSym = a.unit === "asset" ? v.info.symbol : v.asset.symbol;
  const units = parse(amount, inDec) ?? 0n;
  const max = action === "deposit" ? v.position?.wallet : action === "withdraw" ? v.position?.maxWithdraw : action === "redeem" ? v.position?.shares : undefined;
  const pos = v.position;
  // What the Max button and the limit refer to: the wallet for a deposit, what can be withdrawn
  // for a withdrawal, the shares held for a mint or a redemption.
  const balance = !pos ? null
    : action === "deposit" || action === "mint" ? { k: "In your wallet", text: `${fmtAmount(pos.wallet, v.asset.decimals)} ${v.asset.symbol}` }
    : action === "withdraw" ? { k: "Withdrawable", text: `${fmtAmount(pos.maxWithdraw, v.asset.decimals)} ${v.asset.symbol}` }
    : { k: "Your shares", text: `${fmtAmount(pos.shares, v.info.decimals, 4)} ${v.info.symbol}` };
  // A mint is bounded by the wallet through its cost, known once the preview is in.
  const tooCostly = action === "mint" && pos != null && quote?.key === `${action}:${units}` && quote.out > pos.wallet;
  const over = action === "deposit" ? "More than in your wallet" : action === "withdraw" ? "More than you can withdraw" : "More than your shares";
  const err = amount && parse(amount, inDec) === null ? "Invalid amount" : max != null && units > max ? over : "";
  // The vault refuses an exit below 1,000 share units, unless it is the holder's whole balance.
  const sharesOut = action === "redeem" ? units : action === "withdraw" && quote?.key === `${action}:${units}` ? quote.out : null;
  const tooSmall = !err && sharesOut != null && sharesOut > 0n && sharesOut < MIN_EXIT_SHARES && pos != null && sharesOut !== pos.shares;
  const key = `${action}:${units}`;
  useEffect(() => {
    if (units <= 0n || err) return;
    let live = true;
    view<bigint>(cfg, v.info.id, `preview_${action}`, [i128(units)]).then((out) => { if (live) setQuote({ key, out }); }).catch(() => undefined);
    return () => { live = false; };
  }, [key, err, v.info.totalAssets]); // eslint-disable-line react-hooks/exhaustive-deps
  const record = (x: Omit<Attempt, "at" | "label">) => setLog((l) => [{ at: new Date(), label: `${a.label} ${amount} ${inSym}`, ...x }, ...l].slice(0, 12));
  const run = async () => {
    try {
      setStep(v.info.trustlineOn === false ? "Sign in Freighter…" : "Trustline check, then sign in Freighter…");
      const hash = await call(cfg, v.info, me!.address, action, investArgs(units, me!.address), { sender: me!.address, value: units }, sign);
      record({ kind: "allowed", ok: true, detail: v.info.trustlineOn === false ? "Executed (Trustline check off)." : "Approved by Trustline and executed; the approval was used up.", hash });
      setAmount(""); await refresh();
    } catch (e) { record({ kind: "refused", ok: false, detail: (e as Error).message }); await refresh().catch(() => undefined); }
    setStep("");
  };
  const probe = async () => {
    setStep("Simulating without Trustline…");
    const r = await simulate(cfg, me!.address, v.info.id, action, investArgs(units, me!.address)).catch((e: Error) => e.message);
    record({ kind: "probe", ok: !r, detail: r ? `Without Trustline: ${r}` : "Without Trustline the call would go through (check off, or an unused approval exists)." });
    setStep("");
  };
  const readOnly = !me || me.readOnly;
  return (
    <div className="stack">
      <div className="tabs">{ACTIONS.filter((x) => kinds.includes(x.k)).map((x) => <button key={x.k} className={action === x.k ? "on" : ""} onClick={() => { setAction(x.k); setAmount(""); }}>{x.label}</button>)}</div>
      <div className="small muted">{a.help}</div>
      <label className="field">Amount ({inSym}){amountInput(amount, setAmount, inSym, max != null ? { value: max, decimals: inDec } : undefined)}</label>
      {balance && <div className="small muted">{balance.k}: <b className="mono">{balance.text}</b>{action === "withdraw" && " · paid at once while the vault has liquidity, otherwise queued"}</div>}
      {err ? <div className="bad small">{err}</div> : units > 0n && quote?.key === key && <div className="small">Preview: <b>{fmtAmount(quote.out, outDec, 6)} {outSym}</b></div>}
      {tooSmall && <div className="warn small">Below the vault's minimum exit of {fmtAmount(MIN_EXIT_SHARES, v.info.decimals, v.info.decimals)} {v.info.symbol} (1,000 share units): refused unless you sell all your shares.</div>}
      {tooCostly && <div className="warn small">Costs more than your wallet holds.</div>}
      <div className="row">
        <button className={`btn primary${cta ? " cta" : ""}${cta && !readOnly && units <= 0n ? " empty" : ""}`} disabled={readOnly || !!step || units <= 0n || !!err || tooSmall || tooCostly} onClick={run}>{a.label}</button>
        <button className="btn link" disabled={readOnly || !!step || units <= 0n || !!err} onClick={probe}>Try without Trustline</button>
      </div>
      {step && <div className="banner info">{step}</div>}
      {me?.readOnly && <div className="small warn">Watch-only: connect Freighter to sign.</div>}
      <div className="small muted">Checked by Trustline with you as sender and, as the contract passes it, the {a.unit === "asset" ? "assets" : "shares"} as value.</div>
      {log.map((x, i) => (
        <div key={i} className={`banner ${x.kind === "allowed" ? "ok" : x.kind === "refused" ? "bad" : "info"}`}><b>{x.kind === "allowed" ? "Allowed" : x.kind === "refused" ? "Refused" : x.ok ? "Would pass" : "Would be refused"}</b> · {x.label} · <span className="small">{x.at.toLocaleTimeString()}</span>
          <div className="small">{x.detail}</div>{x.hash && <a className="small" href={explorer.tx(x.hash)} target="_blank" rel="noreferrer">Transaction ↗</a>}</div>
      ))}
    </div>
  );
}

function PositionCard({ v }: P) {
  const d = v.asset.decimals, p = v.position, sym = v.asset.symbol;
  const stat = (k: string, value: string, note?: ReactNode) => (
    <div><div className="small muted">{k}</div><div className="mid mono">{value}</div>{note && <div className="small muted">{note}</div>}</div>
  );
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Your position</h3>
      {!p ? <div className="small muted">Connect an account to see it.</div> : (
        <div className="grid4">
          {stat("Shares", `${fmtAmount(p.shares, v.info.decimals, 4)} ${v.info.symbol}`)}
          {stat("What you paid", `${fmtAmount(p.cost, d)} ${sym}`)}
          {stat("Value", `${fmtAmount(p.value, d)} ${sym}`)}
          {p.shares > 0n && !p.sale ? stat("Value after fee", "—", "the fee could not be read on this vault")
            : stat("Value after fee", `${fmtAmount(p.sale ? p.sale.paid : p.value, d)} ${sym}`,
              p.sale && (p.sale.performance > 0n || p.sale.penalty > 0n) ? `performance fee ${fmtAmount(p.sale.performance, d)} · early exit ${fmtAmount(p.sale.penalty, d)}` : "no fee if you sold now")}
        </div>
      )}
    </div>
  );
}

/** Sell: withdraw / redeem, with what can be paid now and the requests waiting. */
function ExitCard({ v, refresh }: P) {
  const { me, sign } = useApp();
  const { busy, run, banner } = useRunner(refresh);
  const d = v.asset.decimals, q = v.info.queue;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Sell</h3>
      <ActionForm v={v} refresh={refresh} kinds={["withdraw", "redeem"]} />
      <dl className="kv small">
        <Row k="Payable now">{fmtAmount(v.info.availableLiquidity, d)} {v.asset.symbol}<Note>idle + the liquidity adapter's liquid assets</Note></Row>
        <Row k="Waiting">{q.length ? `${q.length} request${q.length > 1 ? "s" : ""}` : "none"}</Row>
      </dl>
      <QueueTable v={v} refresh={refresh} who="holder" />
      <div className="row"><button className="btn" disabled={!me || me.readOnly || !!busy || q.length === 0} onClick={run("Process the queue", () => call(cfg, v.info, me!.address, "process_withdrawals", [nativeToScVal(10, { type: "u32" })], null, sign))}>Process the queue (10 at most)</button></div>
      <Note>A withdrawal is paid at once only when nobody waits and the liquidity covers it; otherwise it joins the queue. First in, first out: anyone processes the queue, a few requests at a time, and it stops at the first one the liquidity cannot pay. Waiting shares stay in escrow on the vault, keep their cost, and are paid at the price of the day they are processed; their owner, or the queue manager, can cancel meanwhile. A request takes at least 1,000 share units, except a holder's last ones. While the queue is not empty, deposits stay idle.</Note>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

// ---- Allocation ----

/** The caps of each adapter; `who` lowers them (curator or sentinel), raising goes through the curator's timelock. */
function CapsCard({ v, refresh, who }: P & { who: "curator" | "sentinel" }) {
  const { sign } = useApp();
  const r = useRoles(v);
  const may = (who === "curator" ? r.curator : r.sentinel) && r.canSign;
  const { busy, run, banner } = useRunner(refresh);
  const d = v.asset.decimals;
  const pct = (w: bigint) => `${Number((w * 10_000n) / WAD) / 100}%`;
  if (v.info.adapters.length === 0) return null;
  return (
    <div className={`card stack${who === "sentinel" ? " sm" : ""}`}>
      <h3 style={{ margin: 0 }}>{who === "curator" ? "Caps" : "Close an adapter's caps"}</h3>
      <table className="list small">
        <thead><tr><th>Adapter</th><th align="right">Allocated</th><th align="right">Liquid</th><th align="right">Absolute cap</th><th align="right">Relative cap</th><th /></tr></thead>
        <tbody>{v.info.adapters.map((x) => <tr key={x.address}>
          <td className="mono">{short(x.address)}{x.liquidity ? " · liquidity" : ""}</td>
          <td align="right">{fmtAmount(x.allocation, d, 2)}</td>
          <td align="right">{x.liquidAssets < 0n ? "?" : fmtAmount(x.liquidAssets, d, 2)}</td>
          <td align="right" className={x.absoluteCap === 0n ? "warn" : ""}>{x.absoluteCap >= UNLIMITED_CAP ? "unlimited" : fmtAmount(x.absoluteCap, d, 2)}</td>
          <td align="right" className={x.relativeCap === 0n ? "warn" : ""}>{pct(x.relativeCap)}</td>
          <td align="right"><button className="btn link" disabled={!may || !!busy || (x.absoluteCap === 0n && x.relativeCap === 0n)} onClick={run("Close this adapter's caps", async () => {
            const h = await call(cfg, v.info, r.me, "decrease_absolute_cap", [addr(r.me), addr(x.address), i128(0n)], null, sign);
            await call(cfg, v.info, r.me, "decrease_relative_cap", [addr(r.me), addr(x.address), i128(0n)], null, sign);
            return h;
          })}>Set to 0</button></td>
        </tr>)}</tbody>
      </table>
      <Note>An allocation must fit both caps: the absolute cap in {v.asset.symbol}, and the relative cap as a share of the vault's total assets. A new adapter starts at 0: the curator raises them through the timelock (Submit an operation). Lowering is immediate, for the curator or a sentinel, and not checked by Trustline.</Note>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

function Allocation({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  // The selections follow the vault when it changes under them (an adapter removed, the liquidity adapter set by someone else).
  const [picked, setPicked] = useState("");
  const adapter = v.info.adapters.some((x) => x.address === picked) ? picked : (v.info.adapters[0]?.address ?? "");
  const [amount, setAmount] = useState("");
  const [liqPicked, setLiq] = useState<string | null>(null);
  const liq = liqPicked ?? (v.info.liquidityAdapter ?? "");
  const units = parse(amount, v.asset.decimals) ?? 0n;
  const inAdapter = v.info.adapters.find((x) => x.address === adapter)?.realAssets ?? 0n;
  const fmt = (x: bigint) => `${fmtAmount(x, v.asset.decimals)} ${v.asset.symbol}`;
  const tooMuchIn = units > v.info.idle, tooMuchOut = units > inAdapter;
  const sel = v.info.adapters.find((x) => x.address === adapter);
  const capRoom = sel ? (() => {
    const byAbs = sel.absoluteCap - sel.allocation;
    const byRel = (sel.relativeCap * v.info.totalAssets) / WAD - sel.allocation;
    return byAbs < byRel ? byAbs : byRel;
  })() : 0n;
  const move = (fn: "allocate" | "deallocate") => run(fn === "allocate" ? "Allocate" : "Deallocate", () =>
    call(cfg, v.info, r.me, fn, [addr(r.me), addr(adapter), noData(), i128(units)], { sender: r.me, value: units }, sign));
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Where the assets are</h3>
        <AllocationBars v={v} />
        <Note>Total assets = idle + what each adapter reports (<code>real_assets</code>). Deposits go to the liquidity adapter when one is set; withdrawals take idle assets first, then the liquidity adapter's liquid assets (<code>liquid_assets</code>).</Note>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Move assets</h3>
        {!(r.allocator && r.canSign) && <div className="small muted">Allocators allocate and deallocate. {cannot(r, r.allocator, "an allocator")}(A sentinel deallocates from Admin.)</div>}
        {v.info.adapters.length === 0 ? <div className="small muted">No adapter registered: the curator adds one (Curator).</div> : <>
          <label className="field">Adapter
            <select value={adapter} onChange={(e) => setPicked(e.target.value)}>{v.info.adapters.map((x) => <option key={x.address} value={x.address}>{short(x.address, 8)} · {fmtAmount(x.realAssets, v.asset.decimals, 2)} {v.asset.symbol}{x.liquidity ? " · liquidity" : ""}</option>)}</select>
          </label>
          <label className="field">Amount ({v.asset.symbol}){amountInput(amount, setAmount, v.asset.symbol)}</label>
          <div className="row small">
            <span className="muted">Idle in the vault: {fmt(v.info.idle)}</span>
            <button className="btn link" onClick={() => setAmount(fmtAmount(v.info.idle, v.asset.decimals, v.asset.decimals).replace(/,/g, ""))}>max to allocate</button>
            <span className="muted">· In this adapter: {fmt(inAdapter)}</span>
            <button className="btn link" onClick={() => setAmount(fmtAmount(inAdapter, v.asset.decimals, v.asset.decimals).replace(/,/g, ""))}>max to deallocate</button>
          </div>
          {units > 0n && tooMuchIn && tooMuchOut && <div className="small warn">More than the vault's idle balance and more than this adapter holds.</div>}
          {units > 0n && tooMuchIn && !tooMuchOut && <div className="small muted">Above the idle balance: can only be deallocated.</div>}
          {units > 0n && !tooMuchIn && tooMuchOut && <div className="small muted">Above what the adapter holds: can only be allocated.</div>}
          {units > 0n && !tooMuchIn && units > capRoom && <div className="small warn">Above this adapter's caps (room {fmt(capRoom > 0n ? capRoom : 0n)}): the allocation will be refused until the curator raises them.</div>}
          <div className="row">
            <button className="btn primary" disabled={!r.allocator || !r.canSign || !!busy || units <= 0n || tooMuchIn} title={tooMuchIn ? "More than the vault's idle balance" : undefined} onClick={move("allocate")}>Allocate from idle</button>
            <button className="btn" disabled={!r.allocator || !r.canSign || !!busy || units <= 0n || tooMuchOut} title={tooMuchOut ? "More than this adapter holds" : undefined} onClick={move("deallocate")}>Deallocate to idle</button>
          </div>
        </>}
        <Note>Checked by Trustline with you as sender and the amount as value.</Note>
      </div>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Liquidity adapter</h3>
        <select aria-label="Liquidity adapter" value={liq} onChange={(e) => setLiq(e.target.value)}>
          <option value="">none: deposits stay idle</option>
          {v.info.adapters.map((x) => <option key={x.address} value={x.address}>{short(x.address, 8)}</option>)}
        </select>
        <div className="row"><button className="btn" disabled={!r.allocator || !r.canSign || !!busy || liq === (v.info.liquidityAdapter ?? "")} onClick={run("Set the liquidity adapter", () =>
          call(cfg, v.info, r.me, "set_liquidity_adapter", [addr(r.me), liq ? addr(liq) : xdr.ScVal.scvVoid(), noData()], { sender: r.me, value: 0n }, sign))}>Set</button></div>
      </div>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

// ---- Curator ----

/** The pending timelocked operations: anyone executes a due one; `who` (curator or sentinel) revokes. */
function PendingOps({ v, refresh, who }: P & { who: "curator" | "sentinel" }) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const now = Date.now();
  const may = (who === "curator" ? r.curator : r.sentinel) && r.canSign;
  const partial = "The vault's events could not all be read from the RPC: only the operations submitted from this browser are listed.";
  return (
    <div className={`card stack${who === "sentinel" ? " sm" : ""}`}>
      <h3 style={{ margin: 0 }}>{who === "curator" ? "Pending operations" : "Revoke a pending operation"}</h3>
      {v.pending.length === 0 && <div className="small muted">{v.pendingComplete ? "Nothing pending." : partial}</div>}
      {v.pending.length > 0 && !v.pendingComplete && <div className="small warn">{partial}</div>}
      {v.pending.map(({ op, eta }) => {
        const due = eta.getTime() <= now;
        const ex = opExecution(op);
        return (
          <div key={opScVal(op).toXDR("base64")} className="between" style={{ gap: 8, alignItems: "flex-start" }}>
            <div><div>{opLabel(op, v.asset)}</div><Note cls={due ? "ok" : "warn"}>{due ? "due: anyone can execute it" : `executable from ${eta.toLocaleString()}`}</Note></div>
            <div className="row">
              {who === "curator" && <button className="btn sm primary" disabled={!due || !r.canSign || !!busy} onClick={run(`Execute: ${opLabel(op, v.asset)}`, () => call(cfg, v.info, r.me, ex.fn, ex.args, null, sign))}>Execute</button>}
              <button className="btn sm" disabled={!may || !!busy} onClick={run(`Revoke: ${opLabel(op, v.asset)}`, () => call(cfg, v.info, r.me, "revoke", [addr(r.me), opScVal(op)], null, sign))}>Revoke</button>
            </div>
          </div>
        );
      })}
      <Note>Read from the vault's events (about a week back) and confirmed on-chain. Revoking is open to the curator and the sentinels, without a Trustline check.</Note>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

function Curator({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const submit = (op: PendingOp) => run(`Submit: ${opLabel(op, v.asset)}`, async () => {
    const h = await call(cfg, v.info, r.me, "submit", [opScVal(op)], { sender: r.me, value: 0n }, sign);
    rememberVaultOp(v.info.id, opScVal(op).toXDR("base64"));
    return h;
  });
  return (
    <div className="stack" style={{ gap: 16 }}>
      <CapsCard v={v} refresh={refresh} who="curator" />
      <FeesCard v={v} refresh={refresh} />
      <PendingOps v={v} refresh={refresh} who="curator" />
      <SubmitForm v={v} disabled={!r.curator || !r.canSign || !!busy} onSubmit={submit} />
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Delays</h3>
        <table className="list small">
          <thead><tr><th>Operation</th><th>Delay</th><th>Status</th></tr></thead>
          <tbody>{OP_KINDS.map((k) => <tr key={k}><td>{k}</td><td>{v.info.timelocks[k].seconds ? fmtDelay(v.info.timelocks[k].seconds) : "none"}</td><td className={v.info.timelocks[k].abdicated ? "bad" : "muted"}>{v.info.timelocks[k].abdicated ? "abdicated: disabled for good" : "active"}</td></tr>)}</tbody>
        </table>
        <Note>A cut waits for the delay of the operation it shortens. The curator's submissions are checked by Trustline; executing and revoking are not.</Note>
      </div>
      <QueueManagerCard v={v} refresh={refresh} />
      {busy && <div className="banner info">{busy}…</div>}{banner}
      {!(r.curator && r.canSign) && <div className="small muted">{cannot(r, r.curator, "the curator")}Only the curator submits operations, changes fees and names the queue manager. Anyone can execute a due operation; the curator or a sentinel can revoke one.</div>}
    </div>
  );
}

function SubmitForm({ v, disabled, onSubmit }: { v: VaultState; disabled: boolean; onSubmit: (op: PendingOp) => () => Promise<void> }) {
  const [kind, setKind] = useState<OpKind>("AddAdapter");
  const [address, setAddress] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [target, setTarget] = useState<OpKind>("AddAdapter");
  const [seconds, setSeconds] = useState(3600);
  const [cap, setCap] = useState("");
  const adapterOk = StrKey.isValidContract(address.trim());
  // The contract checks a delay at execution only, after the Trustline approval and the wait: said here.
  const current = v.info.timelocks[target].seconds;
  const secondsOk = Number.isInteger(seconds) && seconds >= 0 && seconds <= 31_536_000
    && (kind === "IncreaseTimelock" ? seconds > current : kind === "DecreaseTimelock" ? seconds < current : true);
  const capValue = (() => {
    try {
      if (kind === "IncreaseAbsoluteCap") return cap.trim() === "" ? null : toBaseUnits(cap, v.asset.decimals);
      if (kind === "IncreaseRelativeCap") { const pct = Number(cap); return Number.isFinite(pct) && pct > 0 && pct <= 100 ? (WAD * BigInt(Math.round(pct * 100))) / 10_000n : null; }
    } catch { /* not a number */ }
    return null;
  })();
  const op: PendingOp | null =
    kind === "AddAdapter" || kind === "RemoveAdapter" ? (adapterOk ? { kind, adapter: address.trim() } : null)
    : kind === "SetIsAllocator" ? (StrKey.isValidEd25519PublicKey(address.trim()) || StrKey.isValidContract(address.trim()) ? { kind, who: address.trim(), enabled } : null)
    : kind === "Abdicate" ? { kind, target }
    : kind === "IncreaseAbsoluteCap" || kind === "IncreaseRelativeCap" ? (adapterOk && capValue != null ? { kind, adapter: address.trim(), cap: capValue } : null)
    : kind === "SetFees" ? null
    : secondsOk ? { kind, target, seconds } : null;
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Submit an operation</h3>
      <select aria-label="Operation" value={kind} onChange={(e) => { setKind(e.target.value as OpKind); setAddress(""); setCap(""); }}>
        {OP_KINDS.filter((k) => k !== "SetFees").map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {(kind === "IncreaseAbsoluteCap" || kind === "IncreaseRelativeCap") && <>
        <select aria-label="Adapter" value={address} onChange={(e) => setAddress(e.target.value)}><option value="">choose the adapter</option>{v.info.adapters.map((x) => <option key={x.address} value={x.address}>{short(x.address, 8)} · cap {kind === "IncreaseAbsoluteCap" ? `${fmtAmount(x.absoluteCap, v.asset.decimals, 2)} ${v.asset.symbol}` : `${Number((x.relativeCap * 10_000n) / WAD) / 100}%`}</option>)}</select>
        <label className="field">{kind === "IncreaseAbsoluteCap" ? `New cap (${v.asset.symbol})` : "New cap (% of the vault's assets, up to 100)"}<input value={cap} onChange={(e) => setCap(e.target.value)} placeholder={kind === "IncreaseAbsoluteCap" ? "1000" : "100"} /></label>
        <Note>A new adapter starts with both caps at 0: raise both before allocating to it. Lowering a cap needs no delay: the curator from the Caps card above, a sentinel from Admin.</Note>
      </>}
      {(kind === "AddAdapter" || kind === "RemoveAdapter") && (kind === "RemoveAdapter"
        ? <select aria-label="Adapter" value={address} onChange={(e) => setAddress(e.target.value)}><option value="">choose</option>{v.info.adapters.map((x) => <option key={x.address} value={x.address}>{short(x.address, 8)} · {fmtAmount(x.realAssets, v.asset.decimals, 2)} {v.asset.symbol}</option>)}</select>
        : <input className="mono" aria-label="Adapter address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adapter C…" />)}
      {kind === "RemoveAdapter" && v.info.adapters.find((x) => x.address === address && x.realAssets > 0n) &&
        <div className="banner bad">This adapter still holds assets. Removing it drops them from the vault's total assets, and so from every share's value, until it is added back. Deallocate first.</div>}
      {kind === "SetIsAllocator" && <>
        <input className="mono" aria-label="Allocator address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Account G… or contract C…" />
        <label className="row" style={{ color: "var(--ink)" }}><input type="checkbox" style={{ width: "auto" }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />allocator (untick to remove)</label>
      </>}
      {(kind === "IncreaseTimelock" || kind === "DecreaseTimelock" || kind === "Abdicate") && (
        <label className="field">Of the operation<select value={target} onChange={(e) => setTarget(e.target.value as OpKind)}>{OP_KINDS.map((k) => <option key={k} value={k}>{k} (now {v.info.timelocks[k].seconds ? fmtDelay(v.info.timelocks[k].seconds) : "none"})</option>)}</select></label>
      )}
      {(kind === "IncreaseTimelock" || kind === "DecreaseTimelock") && (
        <label className="field">New delay (seconds, max one year)<input type="number" min={0} max={31_536_000} step={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
          {!secondsOk && <span className="warn">A whole number of seconds, at most 31,536,000; {kind === "IncreaseTimelock" ? "above" : "below"} the current delay ({fmtDelay(current)}).</span>}</label>
      )}
      {kind === "Abdicate" && <div className="banner warn">Abdicating disables this kind of operation for good: it can never be submitted or executed again.</div>}
      <div className="row"><button className="btn primary" disabled={disabled || !op} onClick={op ? onSubmit(op) : undefined}>Submit{op ? `: ${opLabel(op, v.asset)}` : ""}</button></div>
      <Note>Executable after {fmtDelay(op ? v.info.timelocks[op.kind === "DecreaseTimelock" ? op.target : op.kind].seconds : 0)} (the delay of {op?.kind === "DecreaseTimelock" ? "the operation being shortened" : "this operation"}).</Note>
    </div>
  );
}

function FeesCard({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const f = v.info.fees;
  const [draft, setDraft] = useState<Fees | null>(null);
  const problems = draft ? feeProblems(draft, v.info.id) : [];
  if (!f) return <div className="card small muted">This vault's code has no fee functions.</div>;
  const delay = v.info.timelocks.SetFees.seconds;
  // A fee change is a timelocked operation: the curator submits SetFees (checked by Trustline);
  // once due, anyone executes set_fees with the same values. With no delay, both at once.
  const propose = (fees: Fees) => async () => {
    const op: PendingOp = { kind: "SetFees", fees };
    const h = await call(cfg, v.info, r.me, "submit", [opScVal(op)], { sender: r.me, value: 0n }, sign);
    if (delay === 0) {
      const ex = opExecution(op);
      await call(cfg, v.info, r.me, ex.fn, ex.args, null, sign);
    }
    setDraft(null);
    return h;
  };
  return (
    <div className="card stack">
      <h3 style={{ margin: 0 }}>Fees</h3>
      <dl className="kv small">
        <Row k="Current">{fmtFees(f.fees)}<Note>to <span className="mono">{short(f.fees.receiver)}</span></Note></Row>
        <Row k="Change delay">{delay ? fmtDelay(delay) : "none"}<Note>the curator timelock of SetFees{v.info.timelocks.SetFees.abdicated ? ": abdicated, fees can no longer change" : ""}</Note></Row>
      </dl>
      <div className="row">
        {!draft && <button className="btn" disabled={!r.curator || !r.canSign || v.info.timelocks.SetFees.abdicated} onClick={() => setDraft(f.fees)}>Propose new fees</button>}
        <button className="btn link" disabled={!r.canSign || !!busy} onClick={run("Accrue the management fee", () => call(cfg, v.info, r.me, "accrue", [], null, sign))}>Accrue now</button>
      </div>
      {draft && <>
        <FeesForm fees={draft} onChange={setDraft} shareDecimals={v.info.decimals} />
        {problems.length > 0 && <div className="bad small">{problems.join(" · ")}</div>}
        <div className="row">
          <button className="btn primary" disabled={!!busy || problems.length > 0} onClick={run(delay ? "Submit the fee change" : "Change the fees", propose(draft))}>{delay ? "Submit (checked by Trustline)" : "Change now (submit checked by Trustline, then apply)"}</button>
          <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
        </div>
        {delay > 0 && <Note>The change then waits {fmtDelay(delay)} in the pending operations, where anyone can apply it once due, and the curator or a sentinel can revoke it meanwhile.</Note>}
      </>}
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

// ---- Roles ----

/** The owner's actions: curator, sentinels, ownership. */
function OwnerActions({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const [curator, setCurator] = useState("");
  const [sentinel, setSentinel] = useState("");
  const [owner, setOwner] = useState("");
  const valid = (a: string) => StrKey.isValidEd25519PublicKey(a.trim()) || StrKey.isValidContract(a.trim());
  // Arguments are built when clicked: an empty or partial address must not break the page.
  const ownerCall = (label: string, fn: string, args: () => xdr.ScVal[]) => run(label, () => call(cfg, v.info, r.me, fn, args(), { sender: r.me, value: 0n }, sign));
  return (
    <RoleSection title="Owner" who={r.owner} holder={v.info.owner} what="Names the curator, adds and removes sentinels, and can hand the vault over. Each call is checked by Trustline. Allocators are named by the curator, through the timelock.">
      {!(r.owner && r.canSign) && <div className="small muted">{cannot(r, r.owner, "the owner")}</div>}
      <div className="card stack sm">
        <h3>Name the curator</h3>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input className="mono" value={curator} onChange={(e) => setCurator(e.target.value)} placeholder={r.me || "G… or C…"} />
          <button className="btn" disabled={!r.owner || !r.canSign || !!busy || !valid(curator || r.me)} onClick={ownerCall("Set the curator", "set_curator", () => [addr((curator || r.me).trim())])}>Set</button>
        </div>
        <Note>Now: {v.info.curator ? <Addr a={v.info.curator} size={16} /> : "not set"}</Note>
      </div>
      <div className="card stack sm">
        <h3>Add or remove a sentinel</h3>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input className="mono" value={sentinel} onChange={(e) => setSentinel(e.target.value)} placeholder="G… or C…" />
          <button className="btn" disabled={!r.owner || !r.canSign || !!busy || !valid(sentinel)} onClick={ownerCall("Add a sentinel", "set_is_sentinel", () => [addr(sentinel.trim()), xdr.ScVal.scvBool(true)])}>Add</button>
          <button className="btn" disabled={!r.owner || !r.canSign || !!busy || !valid(sentinel)} onClick={ownerCall("Remove a sentinel", "set_is_sentinel", () => [addr(sentinel.trim()), xdr.ScVal.scvBool(false)])}>Remove</button>
        </div>
        <Note>Now: {v.info.sentinels.length ? v.info.sentinels.map((a) => <span key={a} style={{ marginRight: 8 }}><Addr a={a} size={16} /></span>) : "none"}</Note>
      </div>
      <div className="card stack sm">
        <h3>Hand over ownership</h3>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input className="mono" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="New owner G… or C…" />
          <button className="btn danger" disabled={!r.owner || !r.canSign || !!busy || !valid(owner)} onClick={() => { if (confirm(`Hand the vault over to ${owner.trim()}? It takes effect at once, with no acceptance step.`)) ownerCall("Hand over ownership", "set_owner", () => [addr(owner.trim())])(); }}>Hand over</button>
        </div>
        <Note>Takes effect at once, with no acceptance step.</Note>
      </div>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </RoleSection>
  );
}

/** A role's section of the Admin page: its title, who holds it, what it does, then one card per action. */
function RoleSection({ title, who, holder, what, children }: { title: string; who?: boolean; holder?: string | null; what: ReactNode; children: ReactNode }) {
  return (
    <section className="role">
      <h2>{title}{who ? <span className="pill ok" style={{ marginLeft: 10, verticalAlign: "middle" }}>you</span> : ""}</h2>
      <div className="small muted">{what}{holder !== undefined && <> Held by {holder ? <Addr a={holder} size={16} /> : "nobody"}.</>}</div>
      {children}
    </section>
  );
}

// ---- Admin ----

/** What protects the vault, read from the chain, and where its policies are set (Trustline's dashboard). */
function TrustlineCard({ v, engine }: { v: VaultState; engine: EngineInfo | null }) {
  const [functions, setFunctions] = useState<string[] | null>(null);
  useEffect(() => { checkedPrototypes(cfg, v.info.id).then(setFunctions).catch(() => setFunctions(null)); }, [v.info.id]);
  const on = v.info.trustlineOn !== false;
  const split = functions ? splitPrototypes(functions) : null;
  return (
    <div className="card stack sm">
      <div className="between"><h3 style={{ margin: 0 }}>Trustline protection</h3><span className={`pill ${on ? "ok" : "warn"}`}><span className="dot" />Trustline {on ? "on" : "off"}</span></div>
      <dl className="kv small">
        <Row k="Validation Engine"><Addr a={v.info.engine} />{engine && <Note cls={engine.knownCode ? "ok" : "muted"}>{engine.knownCode ? "Trustline Validation Engine code" : `code ${engine.codeHash?.slice(0, 12) ?? "?"}…`}{engine.version != null ? `, version ${engine.version}` : ""}</Note>}
          <Note>{on ? "Each checked call needs an approval for that exact call, consumed once." : "Its check is off: every call goes through without an approval (testing)."}</Note></Row>
        {engine && <Row k="Trustline owner">{engine.admin ? <Addr a={engine.admin} /> : "—"}<Note>The engine's admin: switches the check on or off.</Note></Row>}
        {engine?.registry && <Row k="Registry"><Addr a={engine.registry} /></Row>}
        {engine?.sanctionsOn != null && <Row k="Sanctions screening">{engine.sanctionsOn ? "on" : "off"}</Row>}
        <Row k="Checked calls">{(functions ?? CHECKED).map((f) => <div key={f} className="mono">{f}</div>)}</Row>
        <Row k="Not checked">executing due operations, revoke, cap cuts, accrue, process_withdrawals, cancel_withdrawal, share transfers (SEP-41)</Row>
        <Row k="Policies"><a href={TRUSTLINE.dashboardUrl} target="_blank" rel="noreferrer">Trustline's dashboard</a><Note>The vault is registered there, with a policy for each checked function: for example an email code for {split ? `the ${split.admin.length} management functions` : "the management functions"}, investors approved automatically.</Note></Row>
      </dl>
    </div>
  );
}

/** The Trustline owner (the engine's admin) switches Trustline's check off (every call goes through) or on again, e.g. if Trustline is unavailable. */
function TrustlineSwitch({ v, engine, refresh }: P & { engine: EngineInfo | null }) {
  const { me, sign } = useApp();
  const { busy, run, banner } = useRunner(refresh);
  const [next, setNext] = useState("");
  const valid = StrKey.isValidEd25519PublicKey(next.trim()) || StrKey.isValidContract(next.trim());
  if (!engine) return null;
  const on = v.info.trustlineOn !== false;
  const isAdmin = !!me && !!engine.admin && engine.admin === me.address;
  const canSign = !!me && !me.readOnly;
  return (
    <>
      <div className="card stack sm">
        <h3 style={{ margin: 0 }}>Trustline switch</h3>
        <div className="small muted">Switches the engine's check {on ? "off" : "on"} at once. Off, every call is accepted without an approval: the recovery path if Trustline is ever unavailable, and a way to test. Sanctions screening is kept as it is.</div>
        <div className="row"><button className={`btn ${on ? "" : "primary"}`} disabled={!isAdmin || !canSign || !!busy} title={isAdmin ? undefined : "Connect the Trustline owner's account"}
          onClick={run(on ? "Switch Trustline off" : "Switch Trustline on", () => switchTrustline(engine, me!.address, !on, sign))}>{on ? "Switch Trustline off" : "Switch Trustline on"}</button></div>
      </div>
      <div className="card stack sm">
        <h3 style={{ margin: 0 }}>Hand the engine over</h3>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input className="mono" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New admin G… or C…" />
          <button className="btn danger" disabled={!isAdmin || !canSign || !!busy || !valid} onClick={() => { if (confirm(`Hand the Validation Engine over to ${next.trim()}? Only it can switch Trustline afterwards.`)) run("Hand the engine over", () => transferEngineAdmin(engine, me!.address, next.trim(), sign))(); }}>Hand over</button>
        </div>
        <Note>For a real vault, a multisig account or a safe: whoever holds it can let every call through.</Note>
      </div>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </>
  );
}

/** A sentinel takes assets back from an adapter to the vault (checked by Trustline). */
function SentinelDeallocate({ v, refresh }: P) {
  const { sign } = useApp();
  const r = useRoles(v);
  const { busy, run, banner } = useRunner(refresh);
  const [picked, setPicked] = useState("");
  const adapter = v.info.adapters.some((x) => x.address === picked) ? picked : (v.info.adapters[0]?.address ?? "");
  const [amount, setAmount] = useState("");
  const units = parse(amount, v.asset.decimals) ?? 0n;
  const inAdapter = v.info.adapters.find((x) => x.address === adapter)?.realAssets ?? 0n;
  if (v.info.adapters.length === 0) return null;
  return (
    <div className="card stack sm">
      <h3 style={{ margin: 0 }}>Take assets back from an adapter</h3>
      <label className="field">Adapter
        <select value={adapter} onChange={(e) => setPicked(e.target.value)}>{v.info.adapters.map((x) => <option key={x.address} value={x.address}>{short(x.address, 8)} · {fmtAmount(x.realAssets, v.asset.decimals, 2)} {v.asset.symbol}</option>)}</select>
      </label>
      <label className="field">Amount ({v.asset.symbol}){amountInput(amount, setAmount, v.asset.symbol, { value: inAdapter, decimals: v.asset.decimals })}</label>
      <div className="row"><button className="btn" disabled={!r.sentinel || !r.canSign || !!busy || units <= 0n || units > inAdapter} onClick={run("Deallocate", () =>
        call(cfg, v.info, r.me, "deallocate", [addr(r.me), addr(adapter), noData(), i128(units)], { sender: r.me, value: units }, sign))}>Deallocate to idle</button></div>
      <Note>{cannot(r, r.sentinel, "a sentinel")}Checked by Trustline with you as sender and the amount as value: while Trustline refuses, a sentinel cannot deallocate.</Note>
      {busy && <div className="banner info">{busy}…</div>}{banner}
    </div>
  );
}

/** The waiting withdrawals. As the queue manager: cancel any. As an investor: cancel yours, process the queue. */
function QueueTable({ v, refresh, who }: P & { who: "manager" | "holder" }) {
  const { me, sign } = useApp();
  const { busy, run, banner } = useRunner(refresh);
  const d = v.asset.decimals, q = v.info.queue;
  const manager = !!me && v.info.queueManager === me.address;
  const canSign = !!me && !me.readOnly;
  const mayCancel = (owner: string) => canSign && (who === "manager" ? manager : owner === me!.address);
  const body = <>
    {q.length === 0 ? <div className="small muted">No withdrawal waiting.</div> : <table className="list small">
      <thead><tr><th>#</th><th>Owner</th><th align="right">Shares</th><th align="right">Asked</th><th /></tr></thead>
      <tbody>{q.map((x) => <tr key={String(x.id)}>
        <td>{String(x.id)}</td><td className="mono">{short(x.owner)}{me && x.owner === me.address ? " (you)" : ""}</td>
        <td align="right">{fmtAmount(x.shares, v.info.decimals, 4)}</td><td align="right">{x.targetAssets != null ? `${fmtAmount(x.targetAssets, d)} ${v.asset.symbol}` : "their value"}</td>
        <td align="right">{mayCancel(x.owner) && <button className="btn sm" disabled={!!busy} title={who === "manager" ? "The shares and their cost return to the request's owner." : "Take the request back: the shares and their cost return to you."}
          onClick={run(`Cancel request ${x.id}`, () => call(cfg, v.info, me!.address, "cancel_withdrawal", [addr(me!.address), nativeToScVal(x.id, { type: "u64" })], null, sign))}>Cancel</button>}</td>
      </tr>)}</tbody>
    </table>}
    {busy && <div className="banner info">{busy}…</div>}{banner}
  </>;
  if (who === "holder") return body;
  return (
    <div className="card stack sm">
      <h3 style={{ margin: 0 }}>Cancel a waiting withdrawal</h3>
      {body}
    </div>
  );
}

/** The owner's, sentinels' and queue manager's actions; Trustline and its switch. */
function Admin({ v, refresh }: P) {
  const { me } = useApp();
  const r = useRoles(v);
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  useEffect(() => { readEngine(v.info.engine).then(setEngine).catch(() => setEngine(null)); }, [v.info.engine, v.info.trustlineOn]);
  const isEngineAdmin = !!me && !!engine?.admin && engine.admin === me.address;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <OwnerActions v={v} refresh={refresh} />
      <RoleSection title="Sentinels" who={r.sentinel} what="Reduce risk: revoke a pending operation and close an adapter's caps (not checked by Trustline), take assets back from an adapter (checked by Trustline). Named by the owner.">
        <PendingOps v={v} refresh={refresh} who="sentinel" />
        <CapsCard v={v} refresh={refresh} who="sentinel" />
        <SentinelDeallocate v={v} refresh={refresh} />
      </RoleSection>
      <RoleSection title="Queue manager" who={r.queueManager} holder={v.info.queueManager} what="Cancels any waiting withdrawal, for example one that cannot be paid and holds back the others; the shares and their cost go back to its owner. Named by the curator. Not checked by Trustline.">
        <QueueTable v={v} refresh={refresh} who="manager" />
      </RoleSection>
      <RoleSection title="Trustline owner" who={isEngineAdmin} holder={engine ? engine.admin : undefined} what="The administrator of the vault's Validation Engine, given to the engine at deployment (the account that deployed the vault). Holds the Trustline switch and can hand the engine over; neither is checked by Trustline.">
        <TrustlineCard v={v} engine={engine} />
        <TrustlineSwitch v={v} engine={engine} refresh={refresh} />
      </RoleSection>
    </div>
  );
}
