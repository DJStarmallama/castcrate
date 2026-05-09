import type { MovieSearchResult } from "@castcrate/shared";
import { MovieCard } from "./MovieCard";

interface Props {
  results: MovieSearchResult[];
  onSelect: (movie: MovieSearchResult) => void;
}

export function ResultsGrid({ results, onSelect }: Props) {
  if (results.length === 0) {
    return null;
  }
  return (
    <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {results.map((m) => (
        <MovieCard key={m.imdbId} movie={m} onClick={() => onSelect(m)} />
      ))}
    </div>
  );
}
