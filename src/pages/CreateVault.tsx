// Deploy a vault (Trustline's reference vault): its Validation Engine (Trustline on, or off for testing as the vault's own
// deploy script does), the vault (you are its owner), the reference adapter; then either the
// quick setup (testing) or Trustline activation; last, the dead deposit.
import { useEffect, useState } from "react";
import { Asset, StrKey } from "@stellar/stellar-sdk";
import { useApp } from "../state";
import { cfg, REFERENCE_VAULT, NETWORK, TESTNET_USDC, TRUSTLINE, WASM } from "../lib/config";
import { checkedPrototypes, createVault, vaultPlanProblems, QUICK_SETUP_TXS, QUICK_SETUP_TRUSTLINE_TXS, QuickSetupError, quickSetup, readVault, seedVault, setupRoles, SHARE_OFFSET, splitPrototypes, type VaultPlan } from "../lib/vault";
import { fmtFees, type Fees } from "../lib/fees";
import { nameAddress, saveVault } from "../lib/store";
import { tokenInfo } from "../lib/tokens";
import { Addr, fmtDelay } from "../components/ui";
import FeesForm from "../components/FeesForm";
import Seed from "../components/Seed";

/** The initial delays offered for the curator timelock. */
const TIMELOCKS = [0, 60, 600, 3600, 86_400, 3 * 86_400];

export default function CreateVault({ onCreated }: { onCreated: (vault: string) => void }) {
  const { me, sign, toast, go } = useApp();
  const [name, setName] = useState("Trustlined Vault");
  const [symbol, setSymbol] = useState("tvXLM");
  const [assetKind, setAssetKind] = useState<"xlm" | "usdc" | "custom">("xlm");
  const [custom, setCustom] = useState("");
  const [assetInfo, setAssetInfo] = useState<{ symbol: string; decimals: number } | null>(null);
  const [fees, setFees] = useState<Fees>({ receiver: me!.address, managementBps: 100, performanceBps: 0, penalties: [] });
  const [timelock, setTimelock] = useState(0);
  const [trustline, setTrustline] = useState<"trustline" | "off">("trustline");
  const [quick, setQuick] = useState(true);
  const [review, setReview] = useState(false);
  const [running, setRunning] = useState<{ step: number; text: string; error?: string; trustlineLeftOff?: boolean } | null>(null);
  const [created, setCreated] = useState<{ vault: string; functions: string[] } | null>(null);

  const asset = assetKind === "xlm" ? Asset.native().contractId(NETWORK.passphrase)
    : assetKind === "usdc" ? new Asset(TESTNET_USDC.code, TESTNET_USDC.issuer).contractId(NETWORK.passphrase) : custom.trim();
  useEffect(() => {
    setAssetInfo(null);
    if (!StrKey.isValidContract(asset)) return;
    // A lookup that resolves after the asset changed again must not win: its decimals would be baked into the vault.
    let live = true;
    tokenInfo(asset, true).then((t) => { if (live) setAssetInfo({ symbol: t.symbol, decimals: t.decimals }); }).catch(() => undefined);
    return () => { live = false; };
  }, [asset]);

  /** Every vault gets the reference adapter (`dummy-adapter` in stellar-vault): it holds what the vault allocates to it. */
  const adapterLabel = "Reference adapter";
  const plan: VaultPlan = {
    name, symbol, asset, assetDecimals: assetInfo?.decimals ?? 7, fees, defaultTimelockSecs: timelock,
    engine: { kind: trustline, registry: TRUSTLINE.registry },
  };
  const problems = [...vaultPlanProblems(plan), ...(!assetInfo ? ["Choose a token the app can read"] : [])];
  /** Quick setup needs a zero timelock so submit→execute is immediate; Trustline may stay on (briefly switched off then back on). */
  const canQuick = timelock === 0;
  /** Without the quick setup, the roles (curator, queue manager) get their own step: after activation with Trustline on. */
  const quickRuns = canQuick && quick;
  const quickApprovals = quickRuns ? QUICK_SETUP_TXS + (trustline === "trustline" ? QUICK_SETUP_TRUSTLINE_TXS : 0) : 2;

  const create = async () => {
    setRunning({ step: 1, text: "Starting" });
    try {
      const c = await createVault(cfg, me!.address, plan, { vault: REFERENCE_VAULT.vault, adapter: REFERENCE_VAULT.adapter, engine: WASM.engine }, sign, (step, text) => setRunning({ step, text }));
      // From here the vault exists: a failure below must not lead to a second deployment.
      setCreated({ vault: c.vault, functions: [] });
      toast("Vault deployed", "ok");
      saveVault({ vault: c.vault, name: name.trim(), createdAt: new Date().toISOString() });
      nameAddress(c.vault, name.trim());
      nameAddress(c.adapter, `${name.trim()} adapter`);
      if (canQuick && quick) {
        setRunning({ step: 4, text: "Setting up" });
        await quickSetup(cfg, me!.address, c.vault, c.adapter, sign, (text) => setRunning({ step: 4, text }));
      }
      setCreated({ vault: c.vault, functions: trustline === "off" ? [] : await checkedPrototypes(cfg, c.vault) });
      setRunning({ step: trustline === "trustline" ? 5 : quickRuns ? 7 : 6, text: "" });
    } catch (e) {
      const trustlineLeftOff = e instanceof QuickSetupError && e.trustlineLeftOff;
      setRunning((r) => ({ step: r?.step ?? 1, text: r?.text ?? "", error: (e as Error).message, trustlineLeftOff }));
    }
  };

  if (running) {
    const ROLES = "Roles: you as curator and queue manager";
    const items = ["Validation Engine", "Vault", adapterLabel, ...(quickRuns ? ["Quick setup: curator, queue manager, allocator, adapter and its caps"] : []), ...(trustline === "trustline" ? ["Register the vault with Trustline"] : []), ...(!quickRuns ? [ROLES] : []), "Dead deposit"];
    const stepOf = (t: string) => ({ "Validation Engine": 1, Vault: 2, [adapterLabel]: 3, "Register the vault with Trustline": 5, [ROLES]: 6, "Dead deposit": 7 } as Record<string, number>)[t] ?? 4;
    return (
      <div className="body full"><main className="main" style={{ maxWidth: 680 }}>
        <div className="card stack">
          <h2>Deploying “{name}”</h2>
          <p className="muted">Approve each transaction in Freighter. Keep this page open.</p>
          <div className="steplist">
            {items.map((t, i) => {
              const s = stepOf(t);
              return (
                <div key={t} className={`it ${running.step > s ? "done" : running.step === s ? "cur" : ""}`}>
                  <span className="n">{running.step > s ? "✓" : i + 1}</span>
                  <div className="stack" style={{ gap: 6, minWidth: 0, flex: 1 }}>
                    <div>{t}</div>
                    {running.step === s && !running.error && s < 5 && <div className="small muted">{running.text}…</div>}
                    {s === 5 && running.step === 5 && created && <>
                      <RegisterStep vault={created.vault} functions={created.functions} onDone={() => setRunning({ step: quickRuns ? 7 : 6, text: "" })} />
                    </>}
                    {s === 6 && running.step === 6 && created && <RolesStep vault={created.vault} trustline={trustline === "trustline"} onDone={() => setRunning({ step: 7, text: "" })} />}
                    {s === 7 && running.step === 7 && created && <>
                      <Seed symbol={assetInfo?.symbol ?? ""} decimals={assetInfo?.decimals ?? 7}
                        seed={async (units) => seedVault(cfg, await readVault(cfg, created.vault), me!.address, units, sign)} onDone={() => { toast("Vault seeded", "ok"); onCreated(created.vault); }} />
                      <button className="btn link" style={{ justifySelf: "start" }} onClick={() => onCreated(created.vault)}>Skip</button>
                    </>}
                  </div>
                </div>
              );
            })}
          </div>
          {running.error && <>
            <div className="banner bad">{running.error}</div>
            {created ? <>
              <div className="small muted">The vault is deployed and listed under Vaults. Finish its setup from its pages: Admin for the curator and the queue manager, Curator for the adapter and its caps, Overview for the dead deposit.</div>
              {running.trustlineLeftOff && <div className="banner warn">Trustline was switched off for the quick setup and is still off. Switch it back on from Management → Admin (Trustline switch) once the setup is finished.</div>}
              <div className="row"><button className="btn primary" onClick={() => onCreated(created.vault)}>Open the vault</button></div>
            </> : <div className="row"><button className="btn" onClick={() => setRunning(null)}>Back to the review</button></div>}
          </>}
        </div>
      </main></div>
    );
  }

  return (
    <div className="body full"><main className="main" style={{ maxWidth: 780 }}>
      <div className="pagehead"><div><h1>Deploy a vault</h1><div className="muted">Trustline's reference SEP-56 vault · commit {REFERENCE_VAULT.commit} · {NETWORK.name}</div></div></div>
      <div className="card stack">
        {!review ? <>
          {me?.readOnly && <div className="banner warn">Watch-only: connect Freighter to deploy a vault.</div>}
          <h2>Vault</h2>
          <div className="grid2">
            <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
            <label className="field">Share symbol<input value={symbol} onChange={(e) => setSymbol(e.target.value.trim())} maxLength={12} /></label>
          </div>
          <label className="field">Asset
            <select value={assetKind} onChange={(e) => setAssetKind(e.target.value as typeof assetKind)}>
              <option value="xlm">XLM (native)</option>
              {NETWORK.isTestnet && <option value="usdc">USDC (Circle testnet)</option>}
              <option value="custom">Other token (SEP-41 contract)</option>
            </select>
          </label>
          {assetKind === "custom" && <input className="mono" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="C…" />}
          {assetInfo && <div className="small muted">{assetInfo.symbol} · {assetInfo.decimals} decimals → shares with {assetInfo.decimals + SHARE_OFFSET} decimals (one share per asset unit at first)</div>}

          <h2>Fees</h2>
          <FeesForm fees={fees} onChange={setFees} shareDecimals={(assetInfo?.decimals ?? 7) + SHARE_OFFSET} />

          <h2>Curator timelock</h2>
          <label className="field">Initial delay of every timelocked operation (adapters, allocators, caps up, fees, delays, abdication)
            <select value={timelock} onChange={(e) => setTimelock(Number(e.target.value))}>
              {TIMELOCKS.map((t) => <option key={t} value={t}>{t === 0 ? "none: submit, then execute at once" : fmtDelay(t)}</option>)}
            </select>
          </label>
          <div className="small muted">The curator submits each operation (checked by Trustline); anyone executes it once due; the curator or a sentinel can revoke it meanwhile. Delays can be raised per operation later.</div>

          <h2>Trustline</h2>
          <label className="row" style={{ color: "var(--ink)" }}><input type="radio" name="trustline" style={{ width: "auto" }} checked={trustline === "trustline"} onChange={() => setTrustline("trustline")} />
            Trustline on: a dedicated Validation Engine; you then register the vault and its policies on Trustline's dashboard</label>
          <label className="row" style={{ color: "var(--ink)" }}><input type="radio" name="trustline" style={{ width: "auto" }} checked={trustline === "off"} onChange={() => setTrustline("off")} />
            Trustline off (testing): the same engine with its check switched off; its administrator (you) can switch it on later</label>
          <div className="small muted">The vault comes with the reference adapter (<span className="mono">dummy-adapter</span> in {REFERENCE_VAULT.repo}): it holds what the allocators put in it, with no yield. Other adapters plug into the same interface.</div>
          {canQuick && <label className="row" style={{ color: "var(--ink)" }}><input type="checkbox" style={{ width: "auto" }} checked={quick} onChange={(e) => setQuick(e.target.checked)} />
            Quick setup: make me curator, queue manager and allocator, register the adapter, lift its caps and make it the liquidity adapter{trustline === "trustline" ? " (Trustline is switched off for these calls, then back on)" : ""}</label>}
          {!canQuick && <div className="small muted">Quick setup needs a timelock of 0 (submit then execute at once). With a delay, set roles and the adapter from the vault's Management pages after deploy.</div>}
          {problems.length > 0 && <div className="bad small">{problems.join(" · ")}</div>}
          <div className="between">
            <button className="btn" onClick={() => go("vaults")}>Back</button>
            <button className="btn primary" disabled={problems.length > 0 || !!me?.readOnly} onClick={() => setReview(true)}>Review</button>
          </div>
        </> : <>
          <h2>Review</h2>
          <dl className="kv">
            <dt>Name</dt><dd>{name} · {symbol}</dd>
            <dt>Asset</dt><dd><Addr a={asset} /> <span className="small muted">{assetInfo?.symbol}</span></dd>
            <dt>Owner</dt><dd><Addr a={me!.address} /><div className="small muted">You. The owner appoints the curator and sentinels (checked by Trustline).</div></dd>
            <dt>Fees</dt><dd>{fmtFees(fees)}<div className="small muted">changes through the curator timelock (SetFees), after {timelock ? fmtDelay(timelock) : "no delay"}</div></dd>
            <dt>Timelock</dt><dd>{timelock ? fmtDelay(timelock) : "none"}</dd>
            <dt>Trustline</dt><dd>{trustline === "off" ? "engine deployed with its check off (testing)" : "dedicated Validation Engine, then registration on Trustline's dashboard"}</dd>
            <dt>Setup</dt><dd>{quickRuns ? `quick setup (curator, queue manager, allocator, adapter, caps${trustline === "trustline" ? "; Trustline off then on" : ""})` : "roles step after deploy"}</dd>
            <dt>Adapter</dt><dd>{adapterLabel}<div className="small muted">holds what is allocated to it, no yield</div></dd>
            <dt>Dead deposit</dt><dd>Last step, 1 {assetInfo?.symbol} deposited by you right after creation, kept until the vault closes: against the donation attack.</dd>
            <dt>Code</dt><dd className="mono small">vault {REFERENCE_VAULT.vault.slice(0, 16)}… · adapter {REFERENCE_VAULT.adapter.slice(0, 16)}…</dd>
            <dt>Approvals</dt><dd>About {4 + (trustline === "off" ? 1 : 0) + quickApprovals} Freighter approvals, plus up to 3 when the shared contract code needs its rent extended (about every two months)</dd>
          </dl>
          <div className="between">
            <button className="btn" onClick={() => setReview(false)}>Back</button>
            <button className="btn primary" disabled={!!me?.readOnly} onClick={create}>Deploy</button>
          </div>
        </>}
      </div>
    </main></div>
  );
}

/** After deployment: the owner makes itself curator and queue manager, so the vault can be managed and its queue unblocked. */
function RolesStep({ vault, trustline, onDone }: { vault: string; trustline: boolean; onDone: () => void }) {
  const { me, sign } = useApp();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const go = async () => {
    setError("");
    try { await setupRoles(cfg, me!.address, vault, sign, setBusy); onDone(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">The curator manages adapters, caps, fees and delays; the queue manager cancels a waiting withdrawal that cannot be paid, so one request never blocks the others. You can hand both over later: the curator from Management › Admin, the queue manager from Management › Curator.{trustline ? " Each call is checked by Trustline under the admin policy: an email code each." : ""}</div>
      <div className="row">
        <button className="btn primary" disabled={!!busy} onClick={go}>Make me curator and queue manager</button>
        <button className="btn link" disabled={!!busy} onClick={onDone}>Skip</button>
      </div>
      {busy && <div className="banner info">{busy}…</div>}
      {error && <div className="banner bad">{error}</div>}
    </div>
  );
}

/** With Trustline on: the vault is registered on Trustline's dashboard, where its policies are set. */
function RegisterStep({ vault, functions, onDone }: { vault: string; functions: string[]; onDone: () => void }) {
  const { admin, investors } = splitPrototypes(functions);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="small muted">Until it is registered, Trustline refuses every checked call. On <a href={TRUSTLINE.dashboardUrl} target="_blank" rel="noreferrer">Trustline's dashboard</a>, connect the same Freighter account (it administers the vault's engine), add this contract on Stellar testnet, and map these functions to policies, for example as below. The dashboard lists the vault's read-only functions too: leave them unmapped. A function without a policy is refused while the engine's check is on.</div>
      <dl className="kv small">
        <dt>Contract</dt><dd><Addr a={vault} /></dd>
        <dt>Admin functions</dt><dd>{admin.map((f) => <div key={f} className="mono">{f}</div>)}</dd>
        <dt>Investor functions</dt><dd>{investors.map((f) => <div key={f} className="mono">{f}</div>)}</dd>
      </dl>
      <div className="row">
        <a className="btn" href={TRUSTLINE.dashboardUrl} target="_blank" rel="noreferrer">Open the dashboard</a>
        <button className="btn primary" onClick={onDone}>It is registered: continue</button>
      </div>
    </div>
  );
}
