interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function SearchBar({ value, onChange }: Props) {
  return (
    <div className="relative w-full max-w-2xl">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search for a movie…"
        autoFocus
        className="w-full rounded-full border border-zinc-800 bg-zinc-900/80 px-6 py-4 text-lg text-zinc-100 placeholder-zinc-500 outline-none ring-0 transition focus:border-zinc-600 focus:bg-zinc-900"
      />
    </div>
  );
}
