import { useEffect } from "react";

interface Options {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  enabled?: boolean;
}

export function useGlobalShortcut(opts: Options, handler: (e: KeyboardEvent) => void): void {
  const { key, meta = false, ctrl = false, enabled = true } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== key) return;
      if (meta && !e.metaKey) return;
      if (ctrl && !e.ctrlKey) return;
      handler(e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [key, meta, ctrl, enabled, handler]);
}
