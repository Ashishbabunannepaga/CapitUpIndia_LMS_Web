"use client";

import { useEffect, useRef } from "react";

const format = (n: number, decimals: number) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

/**
 * A number that rolls up from zero when it first appears. The server renders
 * the final value, so the figure is right without JavaScript and for screen
 * readers; the roll writes straight to the DOM node, one frame at a time.
 */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1100,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const text = (n: number) => prefix + format(n, decimals) + suffix;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const target = Number.isFinite(value) ? value : 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || target === shown.current) {
      node.textContent = text(target);
      shown.current = target;
      return;
    }
    const from = shown.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      const current = from + (target - from) * eased;
      node.textContent = text(t === 1 ? target : current);
      shown.current = current;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals, prefix, suffix, duration]);

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {text(value)}
    </span>
  );
}
