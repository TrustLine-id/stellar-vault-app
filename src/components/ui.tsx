import { useEffect, useState, type ReactNode } from "react";
import { explorer } from "../lib/config";
import { addressBook, nameAddress } from "../lib/store";

export const short = (a: string, n = 6) => (a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

/** Deterministic 5x5 symmetric identicon, no dependency. */
export function Identicon({ address, size = 32 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 16777619) >>> 0;
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), h / 4294967296);
  const hue = Math.floor(rnd() * 360);
  const fg = `hsl(${hue} 70% 62%)`, bg = `hsl(${(hue + 180) % 360} 45% 22%)`, spot = `hsl(${(hue + 40) % 360} 80% 70%)`;
  const cells: ReactNode[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    const r = rnd();
    if (r < 0.45) continue;
    const c = r > 0.9 ? spot : fg;
    cells.push(<rect key={`${x}${y}`} x={x} y={y} width="1" height="1" fill={c} />);
    if (x < 2) cells.push(<rect key={`m${x}${y}`} x={4 - x} y={y} width="1" height="1" fill={c} />);
  }
  return (
    <svg className="ident" width={size} height={size} viewBox="0 0 5 5" shapeRendering="crispEdges" aria-hidden="true" style={{ borderRadius: "50%", background: bg }}>
      {cells}
    </svg>
  );
}

/** Copy to the clipboard; falls back to a hidden textarea where the Clipboard API is refused. */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back */ }
  const t = document.createElement("textarea");
  t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
  document.body.appendChild(t); t.select();
  const ok = document.execCommand("copy");
  t.remove();
  if (!ok) throw new Error("Copy refused by the browser");
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="iconbtn" title="Copy" aria-label="Copy" onClick={() => copyText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => undefined)}>
      {done ? "✓" : "⧉"}
    </button>
  );
}

/** Text that copies `text` to the clipboard when clicked (also inside links: the link is not followed). */
export function CopyText({ text, children, className = "" }: { text: string; children: ReactNode; className?: string }) {
  const [state, setState] = useState<"" | "done" | "blocked">("");
  const copy = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault(); e.stopPropagation();
    const flash = (s: "done" | "blocked") => { setState(s); setTimeout(() => setState(""), 1500); };
    copyText(text).then(() => flash("done"), () => flash("blocked"));
  };
  return (
    <span className={`copytext ${state} ${className}`} role="button" tabIndex={0} title={state === "done" ? "Copied" : `${text}\nClick to copy`}
      onClick={copy} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") copy(e); }}>
      {state === "done" ? "Copied ✓" : state === "blocked" ? "Copy blocked by the browser" : children}
    </span>
  );
}

/** Address with identicon, optional name (address book), copy and explorer link. */
export function Addr({ a, label, size = 28, full }: { a: string; label?: string; size?: number; full?: boolean }) {
  const [, force] = useState(0);
  const name = label ?? addressBook()[a];
  const rename = () => {
    const n = window.prompt("Name for this address (saved in this browser)", name ?? "");
    if (n !== null) { nameAddress(a, n); force((x) => x + 1); }
  };
  return (
    <span className="addr" title={a}>
      <Identicon address={a} size={size} />
      <span className="txt">
        {name && <span className="label">{name}</span>}
        <CopyText text={a} className={`mono ${full ? "full" : ""}`}>{full ? a : short(a)}</CopyText>
      </span>
      {!label && <button className="iconbtn" title="Name this address" aria-label="Name this address" onClick={(e) => { e.preventDefault(); rename(); }}>✎</button>}
      <Copy text={a} />
      <a className="iconbtn" href={explorer.account(a)} target="_blank" rel="noreferrer" title="Open in explorer" aria-label="Open in explorer">↗</a>
    </span>
  );
}

export function Modal({ children, onClose, label }: { children: ReactNode; onClose?: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="card" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
export const fmtDelay = (s: number) =>
  s >= 172_800 ? unit(Math.round(s / 8640) / 10, "day") : s >= 3600 ? unit(Math.round(s / 360) / 10, "hour")
    : s >= 120 ? unit(Math.round(s / 6) / 10, "minute") : unit(s, "second");

export const fmtAmount = (v: bigint, decimals: number, max = 7) => {
  const neg = v < 0n; const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = s.slice(s.length - decimals, s.length - decimals + max).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
};
