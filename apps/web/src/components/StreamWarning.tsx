interface Props {
  onDismiss: () => void;
}

export function StreamWarning({ onDismiss }: Props) {
  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-amber-600/40 bg-amber-950/90 p-4 shadow-2xl backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <svg
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-200">
            Streaming from a private tracker
          </p>
          <p className="mt-1 text-xs text-amber-300/80">
            TorrentDay tracks your upload-to-download ratio. Streaming may not
            contribute much upload. Check your ratio if you stream often.
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 rounded-full p-1 text-amber-400 hover:bg-amber-800/40 hover:text-amber-200"
          aria-label="Dismiss"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
