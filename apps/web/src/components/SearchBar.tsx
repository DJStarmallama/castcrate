import { forwardRef } from "react";

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, Props>(function SearchBar(
  { value, onChange },
  ref,
) {
  return (
    <div className="relative w-full max-w-2xl">
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search for a movie…"
        autoFocus
        className="w-full rounded-full border border-zinc-800 bg-zinc-900/80 px-6 py-4 text-lg text-zinc-100 placeholder-zinc-500 outline-none ring-0 transition focus:border-zinc-600 focus:bg-zinc-900"
      />
      <kbd className="pointer-events-none absolute right-5 top-1/2 hidden -translate-y-1/2 select-none rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-500 sm:block">
        ⌘K
      </kbd>
    </div>
  );
});
