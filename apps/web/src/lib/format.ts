function compactNum(v: number) {
  const a = Math.abs(v);
  const [d, s] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : [1e3, "K"];
  return `${(v / d).toLocaleString("es-ES", { maximumFractionDigits: a / d >= 100 ? 0 : 1 })}${s}`;
}

export function fmtUsd(v: number, compact = true) {
  if (compact && Math.abs(v) >= 1000) return `$${compactNum(v)}`;
  return `$${v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtSol(v: number, digits = 3) {
  return `${v.toLocaleString("es-ES", { minimumFractionDigits: digits > 2 ? 2 : digits, maximumFractionDigits: digits })} SOL`;
}

export function fmtNum(v: number, digits = 0) {
  return v.toLocaleString("es-ES", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtTokens(v: number) {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 2 })} M`;
  if (v >= 1e3) return `${(v / 1e3).toLocaleString("es-ES", { maximumFractionDigits: 1 })} K`;
  return fmtNum(v);
}

export function fmtPct(v: number, digits = 2, signed = false) {
  const s = v.toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${signed && v > 0 ? "+" : ""}${s} %`;
}

export function shortAddr(a: string, head = 4, tail = 4) {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

export function clock(ms: number) {
  return new Date(ms).toLocaleTimeString("es-ES", { hour12: false });
}
