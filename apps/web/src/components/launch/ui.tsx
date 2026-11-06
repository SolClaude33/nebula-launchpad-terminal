"use client";

import { Check } from "lucide-react";

export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
  aside,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
          {optional && <span className="ml-1.5 text-[11.5px] font-normal text-faint">opcional</span>}
        </label>
        {aside}
      </div>
      {children}
      <p id={`${id}-msg`} className={`mt-1.5 min-h-[1px] text-[12px] ${error ? "text-sell" : "text-faint"}`}>
        {error ?? hint}
      </p>
    </div>
  );
}

export function RadioCard({
  checked,
  onSelect,
  title,
  body,
  badge,
  disabled,
  name,
  value,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  badge?: React.ReactNode;
  disabled?: boolean;
  name: string;
  value: string;
}) {
  return (
    <label
      className={`hover-glow relative flex cursor-pointer gap-3 rounded-[var(--radius-md)] border p-3.5 transition-colors ${
        checked ? "border-accent/50 bg-[color-mix(in_oklab,var(--accent-a)_8%,var(--surface-1))]" : "border-line bg-surface-1"
      } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} disabled={disabled} className="peer sr-only" />
      <span
        aria-hidden
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent-b ${
          checked ? "border-accent bg-accent" : "border-line-strong"
        }`}
      >
        {checked && <Check className="size-2.5 text-[var(--accent-ink)]" strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13.5px] font-medium">
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">{body}</span>
      </span>
    </label>
  );
}

export function SectionTitle({ index, title, body }: { index: string; title: string; body?: string }) {
  return (
    <div className="mb-5">
      <p className="telemetry">{index}</p>
      <h2 className="font-display mt-1 text-[30px] leading-tight italic">{title}</h2>
      {body && <p className="mt-1 max-w-xl text-[13.5px] text-muted">{body}</p>}
    </div>
  );
}

export function Suffix({ children }: { children: React.ReactNode }) {
  return <span className="num pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-faint">{children}</span>;
}
