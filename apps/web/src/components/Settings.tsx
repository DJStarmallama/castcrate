import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RuntimeSettings } from "../lib/api";
import { useEscape } from "../hooks/useEscape";
import { useLocalState } from "../hooks/useLocalState";

export const SMOOTH_PLAYBACK_KEY = "castcrate.smoothPlayback";

interface Props {
  onClose: () => void;
}

export function Settings({ onClose }: Props) {
  useEscape(onClose);
  const qc = useQueryClient();
  const sys = useQuery({
    queryKey: ["system-check"],
    queryFn: () => api.systemCheck(),
  });
  const settings = useQuery({
    queryKey: ["runtime-settings"],
    queryFn: () => api.getSettings(),
  });
  const [smooth, setSmooth] = useLocalState(SMOOTH_PLAYBACK_KEY, false);

  // Local form state, seeded from the server values once they arrive.
  const [bufferPercent, setBufferPercent] = useState<string>("");
  const [transcodeBufferPercent, setTranscodeBufferPercent] = useState<string>("");
  const [transcodeBitrate, setTranscodeBitrate] = useState<string>("");
  useEffect(() => {
    if (!settings.data) return;
    setBufferPercent(String(settings.data.bufferPercent));
    setTranscodeBufferPercent(String(settings.data.transcodeBufferPercent));
    setTranscodeBitrate(settings.data.transcodeBitrate);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (body: Partial<RuntimeSettings>) => api.updateSettings(body),
    onSuccess: (data) => {
      qc.setQueryData(["runtime-settings"], data);
      qc.invalidateQueries({ queryKey: ["system-check"] });
    },
  });

  const dirty =
    settings.data &&
    (Number(bufferPercent) !== settings.data.bufferPercent ||
      Number(transcodeBufferPercent) !== settings.data.transcodeBufferPercent ||
      transcodeBitrate !== settings.data.transcodeBitrate);

  const onSave = () => {
    const body: Partial<RuntimeSettings> = {};
    const bp = Number(bufferPercent);
    const tbp = Number(transcodeBufferPercent);
    if (Number.isFinite(bp) && bp >= 0 && bp <= 100) body.bufferPercent = bp;
    if (Number.isFinite(tbp) && tbp >= 0 && tbp <= 100)
      body.transcodeBufferPercent = tbp;
    if (/^\d+(?:\.\d+)?[kKmM]?$/.test(transcodeBitrate))
      body.transcodeBitrate = transcodeBitrate;
    save.mutate(body);
  };

  const ffmpegAvailable = sys.data?.ffmpeg.available ?? false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-2xl font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-zinc-900 p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mt-2 text-sm text-zinc-500">
          Defaults come from <code>.env</code>. Edits below persist to{" "}
          <code>~/.castcrate/settings.json</code> and apply at runtime.
        </p>

        {sys.isPending && <p className="mt-6 text-zinc-500">Loading…</p>}
        {sys.data && (
          <>
            <dl className="mt-6 space-y-4">
              <Row label="OMDb API key">
                {sys.data.omdbConfigured ? (
                  <span className="text-emerald-400">configured</span>
                ) : (
                  <span className="text-amber-400">missing</span>
                )}
              </Row>
              <Row label="ffmpeg">
                {ffmpegAvailable ? (
                  <span className="text-emerald-400">{sys.data.ffmpeg.version ?? "available"}</span>
                ) : (
                  <span className="text-amber-400">not found</span>
                )}
              </Row>
              <Row label="Download path">
                <code className="text-zinc-300">{sys.data.downloadPath}</code>
              </Row>
              <Row label="Buffer threshold (%)">
                <NumberField
                  value={bufferPercent}
                  onChange={setBufferPercent}
                  min={0}
                  max={100}
                />
              </Row>
              <Row label="Transcode buffer (%)">
                <NumberField
                  value={transcodeBufferPercent}
                  onChange={setTranscodeBufferPercent}
                  min={0}
                  max={100}
                />
              </Row>
              <Row label="Transcode bitrate">
                <input
                  type="text"
                  value={transcodeBitrate}
                  onChange={(e) => setTranscodeBitrate(e.target.value)}
                  placeholder="5M"
                  className="w-24 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-right text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
                />
              </Row>
            </dl>

            <div className="mt-4 flex items-center justify-end gap-3">
              {save.isError && (
                <span className="text-xs text-red-400">{save.error.message}</span>
              )}
              {save.isSuccess && !dirty && (
                <span className="text-xs text-emerald-400">Saved</span>
              )}
              <button
                onClick={onSave}
                disabled={!dirty || save.isPending}
                className="rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-medium text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>

            <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-start gap-3">
                <button
                  onClick={() => setSmooth(!smooth)}
                  disabled={!ffmpegAvailable}
                  role="switch"
                  aria-checked={smooth}
                  className={`mt-0.5 h-6 w-11 flex-shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    smooth ? "bg-emerald-500" : "bg-zinc-700"
                  }`}
                >
                  <span
                    className={`block h-5 w-5 rounded-full bg-white transition ${
                      smooth ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
                <div className="flex-1">
                  <p className="text-sm font-medium">Smooth playback (transcode)</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Re-encodes the source on the fly to {sys.data.transcodeBitrate}, fragmented MP4. Helps when 1080p sources lag, plays HEVC sources on older Chromecasts. Costs laptop CPU and disables seeking during playback.
                  </p>
                  {!ffmpegAvailable && (
                    <p className="mt-2 text-xs text-amber-400">
                      Install ffmpeg to enable: <code>brew install ffmpeg</code>
                    </p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        <div className="mt-8 border-t border-zinc-800 pt-6 text-xs text-zinc-500">
          <p className="font-medium text-zinc-400">Network notes</p>
          <ul className="mt-2 list-disc pl-4">
            <li>The server binds to <code>0.0.0.0:3000</code> so Chromecasts on the LAN can reach the stream.</li>
            <li>YTS / EZTV rotate domains. Override <code>YTS_BASE_URL</code> / <code>EZTV_BASE_URL</code> in <code>.env</code> if a default stops responding.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-zinc-400">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      max={max}
      step={1}
      className="w-20 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-right text-sm text-zinc-200 focus:border-emerald-500 focus:outline-none"
    />
  );
}
