import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface Props {
  title: string;
  year: number | null;
  onClose: () => void;
}

export function TrailerView({ title, year, onClose }: Props) {
  const q = useQuery({
    queryKey: ["trailer", title, year],
    queryFn: () => api.trailer(title, year),
    staleTime: 1000 * 60 * 60 * 24,
  });

  return (
    <div className="flex h-full min-h-[60vh] w-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-zinc-900 px-6 py-3">
        <button
          onClick={onClose}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        <p className="truncate text-sm text-zinc-400">
          {title}
          {year ? ` (${year})` : ""} — trailer
        </p>
        <span className="w-10" />
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        {q.isPending && (
          <p className="text-sm text-zinc-500">Looking up trailer…</p>
        )}
        {q.isError && (
          <p className="text-sm text-red-400">{q.error.message}</p>
        )}
        {q.data && q.data.embedUrl && (
          <div className="aspect-video w-full max-w-4xl overflow-hidden rounded-lg bg-zinc-900">
            <iframe
              src={`${q.data.embedUrl}?autoplay=1&rel=0&modestbranding=1`}
              title={`${title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              className="h-full w-full"
            />
          </div>
        )}
        {q.data && !q.data.embedUrl && (
          <div className="text-center">
            <p className="text-sm text-zinc-500">
              No embeddable trailer found.
            </p>
            <a
              href={q.data.searchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              Search on YouTube ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
