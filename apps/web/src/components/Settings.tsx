import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { VpnHealth } from "@castcrate/shared";
import { api, type ProxyProvider, type ProxyTestResult, type SettingsPatch, type StremioAddon, type StremioAddonTestResult, type TorrentDayTestResult } from "../lib/api";
import { redactProxyUrl } from "../lib/format";
import { countryFlag } from "../lib/countryFlag";
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

  // Proxy form state
  const [proxyUrlInput, setProxyUrlInput] = useState<string>("");
  const [proxyUrlEditing, setProxyUrlEditing] = useState<boolean>(false);
  const [proxyUrlError, setProxyUrlError] = useState<string>("");
  const [proxyEnabled, setProxyEnabled] = useState<{
    yts: boolean;
    eztv: boolean;
    knaben: boolean;
    torrentday: boolean;
    stremio: boolean;
  }>({ yts: false, eztv: false, knaben: false, torrentday: false, stremio: false });
  // Track the stored masked URL for display
  const [storedProxyUrl, setStoredProxyUrl] = useState<string | null>(null);
  // Test results per provider — reset when settings change
  const [proxyTestResults, setProxyTestResults] = useState<
    Partial<Record<ProxyProvider, ProxyTestResult | "loading">>
  >({});

  // Public-indexer enable toggles (defaults true on server)
  const [sourceEnabled, setSourceEnabled] = useState<{
    yts: boolean;
    eztv: boolean;
    knaben: boolean;
  }>({ yts: true, eztv: true, knaben: true });

  // Stremio addon state
  const [stremioAddons, setStremioAddons] = useState<StremioAddon[]>([]);
  const [stremioUrlInput, setStremioUrlInput] = useState("");
  const [stremioAddError, setStremioAddError] = useState("");
  const [stremioAddSuccess, setStremioAddSuccess] = useState<{ name: string; warning?: string } | null>(null);
  const [stremioAddPending, setStremioAddPending] = useState(false);
  const [stremioTestResults, setStremioTestResults] = useState<
    Partial<Record<string, StremioAddonTestResult | "loading">>
  >({});
  const [stremioRemoveConfirm, setStremioRemoveConfirm] = useState<string | null>(null);
  const stremioAddonsVersion = useRef(0);

  // TorrentDay state
  const [tdEnabled, setTdEnabled] = useState(false);
  // "stored" = server has a value (masked as "***"); null = not set
  const [tdUidStored, setTdUidStored] = useState<string | null>(null);
  const [tdPassStored, setTdPassStored] = useState<string | null>(null);
  const [tdUidInput, setTdUidInput] = useState("");
  const [tdPassInput, setTdPassInput] = useState("");
  const [tdUidEditing, setTdUidEditing] = useState(false);
  const [tdPassEditing, setTdPassEditing] = useState(false);
  const [tdUidError, setTdUidError] = useState("");
  const [tdPassError, setTdPassError] = useState("");
  const [tdTestResult, setTdTestResult] = useState<TorrentDayTestResult | "loading" | null>(null);
  const [tdHelpOpen, setTdHelpOpen] = useState(false);
  // Ref to track whether settings have changed so we can reset test result
  const tdSettingsVersion = useRef(0);

  useEffect(() => {
    if (!settings.data) return;
    setBufferPercent(String(settings.data.bufferPercent));
    setTranscodeBufferPercent(String(settings.data.transcodeBufferPercent));
    setTranscodeBitrate(settings.data.transcodeBitrate);
    // Proxy
    const url = settings.data.proxyUrl ?? null;
    setStoredProxyUrl(url);
    setProxyUrlInput("");
    setProxyUrlEditing(false);
    setProxyUrlError("");
    setProxyEnabled({
      yts: settings.data.proxyEnabled?.yts ?? false,
      eztv: settings.data.proxyEnabled?.eztv ?? false,
      knaben: settings.data.proxyEnabled?.knaben ?? false,
      torrentday: settings.data.proxyEnabled?.torrentday ?? false,
      stremio: settings.data.proxyEnabled?.stremio ?? false,
    });
    // Reset test results when settings load/change
    setProxyTestResults({});
    // Public indexers
    setSourceEnabled({
      yts: settings.data.sourceEnabled?.yts ?? true,
      eztv: settings.data.sourceEnabled?.eztv ?? true,
      knaben: settings.data.sourceEnabled?.knaben ?? true,
    });
    // Stremio addons
    setStremioAddons(settings.data.stremioAddons ?? []);
    stremioAddonsVersion.current += 1;
    setStremioTestResults({});
    setStremioAddSuccess(null);
    // TorrentDay
    const td = settings.data.torrentDay;
    setTdEnabled(td?.enabled ?? false);
    setTdUidStored(td?.uid ?? null);
    setTdPassStored(td?.pass ?? null);
    setTdUidInput("");
    setTdPassInput("");
    setTdUidEditing(false);
    setTdPassEditing(false);
    setTdUidError("");
    setTdPassError("");
    tdSettingsVersion.current += 1;
    setTdTestResult(null);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (body: SettingsPatch) => api.updateSettings(body),
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
    const body: SettingsPatch = {};
    const bp = Number(bufferPercent);
    const tbp = Number(transcodeBufferPercent);
    if (Number.isFinite(bp) && bp >= 0 && bp <= 100) body.bufferPercent = bp;
    if (Number.isFinite(tbp) && tbp >= 0 && tbp <= 100)
      body.transcodeBufferPercent = tbp;
    if (/^\d+(?:\.\d+)?[kKmM]?$/.test(transcodeBitrate))
      body.transcodeBitrate = transcodeBitrate;
    save.mutate(body);
  };

  const PROXY_URL_RE = /^(socks5h?|http|https):\/\/.+/;

  const saveProxyUrl = () => {
    const trimmed = proxyUrlInput.trim();
    if (trimmed === "") {
      // Clear the proxy URL
      save.mutate({ proxyUrl: null });
      setProxyUrlEditing(false);
      setProxyTestResults({});
      return;
    }
    if (!PROXY_URL_RE.test(trimmed)) {
      setProxyUrlError("URL must start with socks5://, socks5h://, http://, or https://");
      return;
    }
    setProxyUrlError("");
    save.mutate({ proxyUrl: trimmed });
    setProxyUrlEditing(false);
    setProxyTestResults({});
  };

  const saveProxyEnabled = (provider: ProxyProvider, checked: boolean) => {
    save.mutate({
      proxyEnabled: { ...proxyEnabled, [provider]: checked },
    });
    setProxyEnabled((prev) => ({ ...prev, [provider]: checked }));
    // Reset test result for the toggled provider
    setProxyTestResults((prev) => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  };

  const runProxyTest = async (provider: ProxyProvider) => {
    setProxyTestResults((prev) => ({ ...prev, [provider]: "loading" }));
    try {
      const result = await api.testProxy(provider);
      setProxyTestResults((prev) => ({ ...prev, [provider]: result }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "request failed";
      setProxyTestResults((prev) => ({
        ...prev,
        [provider]: { ok: false, error: msg },
      }));
    }
  };

  const UID_RE = /^\d+$/;
  const PASS_RE = /^[A-Za-z0-9]+$/;

  const saveTdUid = () => {
    const trimmed = tdUidInput.trim();
    if (trimmed === "") {
      save.mutate({ torrentDay: { uid: null } });
      setTdUidEditing(false);
      setTdTestResult(null);
      return;
    }
    if (!UID_RE.test(trimmed)) {
      setTdUidError("uid must be digits only");
      return;
    }
    setTdUidError("");
    save.mutate({ torrentDay: { uid: trimmed } });
    setTdUidEditing(false);
    setTdTestResult(null);
  };

  const saveTdPass = () => {
    const trimmed = tdPassInput.trim();
    if (trimmed === "") {
      save.mutate({ torrentDay: { pass: null } });
      setTdPassEditing(false);
      setTdTestResult(null);
      return;
    }
    if (!PASS_RE.test(trimmed) || trimmed.length < 16) {
      setTdPassError("pass looks too short / has invalid characters");
      return;
    }
    setTdPassError("");
    save.mutate({ torrentDay: { pass: trimmed } });
    setTdPassEditing(false);
    setTdTestResult(null);
  };

  const saveSourceEnabled = (source: "yts" | "eztv" | "knaben", checked: boolean) => {
    save.mutate({ sourceEnabled: { ...sourceEnabled, [source]: checked } });
    setSourceEnabled((prev) => ({ ...prev, [source]: checked }));
  };

  const saveTdEnabled = (checked: boolean) => {
    save.mutate({ torrentDay: { enabled: checked } });
    setTdEnabled(checked);
    setTdTestResult(null);
  };

  const clearTdUid = () => {
    save.mutate({ torrentDay: { uid: null } });
    setTdTestResult(null);
  };

  const clearTdPass = () => {
    save.mutate({ torrentDay: { pass: null } });
    setTdTestResult(null);
  };

  const runTdTest = async () => {
    setTdTestResult("loading");
    const version = tdSettingsVersion.current;
    try {
      const result = await api.testTorrentDay();
      if (tdSettingsVersion.current === version) {
        setTdTestResult(result);
      }
    } catch (err) {
      if (tdSettingsVersion.current === version) {
        const msg = err instanceof Error ? err.message : "request failed";
        setTdTestResult({ ok: false, error: msg });
      }
    }
  };

  const STREMIO_URL_RE = /^https?:\/\/.+/;

  const addStremioAddon = async () => {
    const trimmed = stremioUrlInput.trim();
    if (!STREMIO_URL_RE.test(trimmed)) {
      setStremioAddError("URL must start with http:// or https://");
      return;
    }
    setStremioAddError("");
    setStremioAddSuccess(null);
    setStremioAddPending(true);
    try {
      const result = await api.addStremioAddon(trimmed);
      setStremioUrlInput("");
      const nextAddons = [...stremioAddons, result.addon];
      setStremioAddons(nextAddons);
      stremioAddonsVersion.current += 1;
      setStremioTestResults({});
      setStremioAddSuccess({ name: result.addon.name, warning: result.warning });
      // Also update the query cache so the effect re-sync doesn't clobber local state
      qc.setQueryData(["runtime-settings"], (old: typeof settings.data) =>
        old ? { ...old, stremioAddons: nextAddons } : old,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "request failed";
      setStremioAddError(msg);
    } finally {
      setStremioAddPending(false);
    }
  };

  const toggleStremioAddon = (id: string, enabled: boolean) => {
    const nextAddons = stremioAddons.map((a) =>
      a.id === id ? { ...a, enabled } : a,
    );
    setStremioAddons(nextAddons);
    stremioAddonsVersion.current += 1;
    setStremioTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    save.mutate({ stremioAddons: nextAddons });
  };

  const runStremioTest = async (id: string) => {
    setStremioTestResults((prev) => ({ ...prev, [id]: "loading" }));
    const version = stremioAddonsVersion.current;
    try {
      const result = await api.testStremioAddon(id);
      if (stremioAddonsVersion.current === version) {
        setStremioTestResults((prev) => ({ ...prev, [id]: result }));
      }
    } catch (err) {
      if (stremioAddonsVersion.current === version) {
        const msg = err instanceof Error ? err.message : "request failed";
        setStremioTestResults((prev) => ({
          ...prev,
          [id]: { ok: false, error: msg },
        }));
      }
    }
  };

  const removeStremioAddon = async (id: string) => {
    try {
      await api.removeStremioAddon(id);
      const nextAddons = stremioAddons.filter((a) => a.id !== id);
      setStremioAddons(nextAddons);
      stremioAddonsVersion.current += 1;
      setStremioTestResults((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      qc.setQueryData(["runtime-settings"], (old: typeof settings.data) =>
        old ? { ...old, stremioAddons: nextAddons } : old,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "request failed";
      setStremioAddError(msg);
    } finally {
      setStremioRemoveConfirm(null);
    }
  };

  // Both uid and pass are stored on the server when they read back as "***"
  const tdCredentialsStored = tdUidStored === "***" && tdPassStored === "***";

  const ffmpegAvailable = sys.data?.ffmpeg.available ?? false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-lg max-h-[90vh] flex-col rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-shrink-0 border-b border-zinc-800 px-8 pt-8 pb-4">
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
        </div>

        <div className="overflow-y-auto px-8 py-6">
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

        <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-sm font-medium text-zinc-200">Network — Proxy (optional)</p>
          <p className="mt-1 text-xs text-zinc-500">
            Routes indexer searches only. Peer traffic is not proxied.
          </p>

          {/* Proxy URL */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-zinc-400 mb-1">Proxy URL</label>
            {!proxyUrlEditing && storedProxyUrl ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-400 truncate">
                  {redactProxyUrl(storedProxyUrl)}
                </code>
                <button
                  onClick={() => { setProxyUrlEditing(true); setProxyUrlInput(""); }}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Edit
                </button>
                <button
                  onClick={() => { setProxyUrlInput(""); save.mutate({ proxyUrl: null }); setProxyTestResults({}); }}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-red-400 hover:bg-zinc-800"
                >
                  Clear
                </button>
              </div>
            ) : proxyUrlEditing || !storedProxyUrl ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={proxyUrlInput}
                    onChange={(e) => { setProxyUrlInput(e.target.value); setProxyUrlError(""); }}
                    placeholder="socks5h://user:pass@host:1080"
                    className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                  />
                  <button
                    onClick={saveProxyUrl}
                    disabled={save.isPending}
                    className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                  >
                    {save.isPending ? "Saving…" : proxyUrlInput.trim() === "" ? "Clear" : "Save"}
                  </button>
                  {proxyUrlEditing && (
                    <button
                      onClick={() => { setProxyUrlEditing(false); setProxyUrlInput(""); setProxyUrlError(""); }}
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {proxyUrlError && (
                  <p className="text-xs text-red-400">{proxyUrlError}</p>
                )}
              </div>
            ) : null}
          </div>

          {/* Provider toggles + Test buttons */}
          <div className="mt-4 space-y-2">
            {(
              [
                { key: "yts", label: "YTS" },
                { key: "eztv", label: "EZTV" },
                { key: "knaben", label: "Knaben" },
                { key: "torrentday", label: "TorrentDay" },
                { key: "stremio", label: "Stremio" },
              ] as { key: ProxyProvider; label: string }[]
            ).map(({ key, label }) => {
              const testResult = proxyTestResults[key];
              return (
                <div key={key} className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id={`proxy-${key}`}
                    checked={proxyEnabled[key]}
                    onChange={(e) => saveProxyEnabled(key, e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-600 accent-emerald-500"
                  />
                  <label
                    htmlFor={`proxy-${key}`}
                    className="w-24 text-xs text-zinc-300 cursor-pointer"
                  >
                    {label}
                  </label>
                  <button
                    onClick={() => void runProxyTest(key)}
                    disabled={testResult === "loading"}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {testResult === "loading" ? "Testing…" : "Test"}
                  </button>
                  {testResult && testResult !== "loading" && (
                    <span
                      className={`text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}
                    >
                      {testResult.ok
                        ? `OK ${testResult.egressIp ?? ""}${testResult.elapsedMs != null ? ` · ${testResult.elapsedMs}ms` : ""}`
                        : `Failed: ${testResult.error ?? "unknown error"}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Public indexers section — enable/disable YTS, EZTV, Knaben */}
        <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-sm font-medium text-zinc-200">Public indexers</p>
          <p className="mt-1 text-xs text-zinc-500">
            Toggle which public sources cratebuddy queries. All on by default.
            TorrentDay and Stremio addons are configured separately below.
          </p>
          <div className="mt-3 space-y-2">
            {(["yts", "eztv", "knaben"] as const).map((src) => {
              const labels: Record<typeof src, { name: string; hint: string }> = {
                yts: { name: "YTS", hint: "movies — primary source, fastest for popular titles" },
                eztv: { name: "EZTV", hint: "TV episodes + season packs, IMDb-keyed" },
                knaben: { name: "Knaben", hint: "free-text aggregator, fallback when others empty" },
              };
              const label = labels[src];
              return (
                <label
                  key={src}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 hover:border-zinc-700"
                >
                  <input
                    type="checkbox"
                    checked={sourceEnabled[src]}
                    onChange={(e) => saveSourceEnabled(src, e.target.checked)}
                    className="mt-1 accent-emerald-500"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200">{label.name}</p>
                    <p className="text-xs text-zinc-500">{label.hint}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Network / VPN section */}
        <VpnSection />

        {/* Indexers section */}
        <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-sm font-medium text-zinc-200">
            Indexers — Private Trackers (optional)
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Add credentials for private trackers used as a last-resort fallback when public
            indexers come up empty. Cratebuddy is unofficial — your account standing is your
            responsibility.
          </p>

          {/* TorrentDay subsection */}
          <div className="mt-4 space-y-4">
            {/* Enable toggle */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => saveTdEnabled(!tdEnabled)}
                disabled={!tdCredentialsStored && !tdEnabled}
                role="switch"
                aria-checked={tdEnabled}
                className={`h-6 w-11 flex-shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  tdEnabled ? "bg-emerald-500" : "bg-zinc-700"
                }`}
                title={
                  !tdCredentialsStored && !tdEnabled
                    ? "Save uid and pass first"
                    : undefined
                }
              >
                <span
                  className={`block h-5 w-5 rounded-full bg-white transition ${
                    tdEnabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
              <div>
                <p className="text-xs font-medium text-zinc-300">Enable TorrentDay</p>
                {!tdCredentialsStored && !tdEnabled && (
                  <p className="text-xs text-zinc-600">Save uid and pass first to enable</p>
                )}
              </div>
            </div>

            {/* uid input */}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                uid cookie
              </label>
              {!tdUidEditing && tdUidStored ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-400 truncate">
                    ••••••••
                  </code>
                  <button
                    onClick={() => { setTdUidEditing(true); setTdUidInput(""); }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={clearTdUid}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-red-400 hover:bg-zinc-800"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={tdUidInput}
                      onChange={(e) => { setTdUidInput(e.target.value); setTdUidError(""); }}
                      placeholder="2462145"
                      className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      onClick={saveTdUid}
                      disabled={save.isPending}
                      className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                    >
                      {save.isPending ? "Saving…" : tdUidInput.trim() === "" ? "Clear" : "Save"}
                    </button>
                    {tdUidEditing && (
                      <button
                        onClick={() => { setTdUidEditing(false); setTdUidInput(""); setTdUidError(""); }}
                        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  {tdUidError && <p className="text-xs text-red-400">{tdUidError}</p>}
                </div>
              )}
            </div>

            {/* pass input */}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                pass cookie
              </label>
              {!tdPassEditing && tdPassStored ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-400 truncate">
                    ••••••••
                  </code>
                  <button
                    onClick={() => { setTdPassEditing(true); setTdPassInput(""); }}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={clearTdPass}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-red-400 hover:bg-zinc-800"
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={tdPassInput}
                      onChange={(e) => { setTdPassInput(e.target.value); setTdPassError(""); }}
                      placeholder="32-char token"
                      className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <button
                      onClick={saveTdPass}
                      disabled={save.isPending}
                      className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400 disabled:opacity-40"
                    >
                      {save.isPending ? "Saving…" : tdPassInput.trim() === "" ? "Clear" : "Save"}
                    </button>
                    {tdPassEditing && (
                      <button
                        onClick={() => { setTdPassEditing(false); setTdPassInput(""); setTdPassError(""); }}
                        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  {tdPassError && <p className="text-xs text-red-400">{tdPassError}</p>}
                </div>
              )}
            </div>

            {/* How to get these cookies — collapsible */}
            <div>
              <button
                onClick={() => setTdHelpOpen((v) => !v)}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
              >
                <svg
                  className={`h-3 w-3 transition-transform ${tdHelpOpen ? "rotate-90" : ""}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
                How to get these cookies
              </button>
              {tdHelpOpen && (
                <ol className="mt-2 space-y-1 pl-4 text-xs text-zinc-500 list-decimal">
                  <li>Log into torrentday.com.</li>
                  <li>Open DevTools → Application → Cookies → torrentday.com.</li>
                  <li>Copy the <code>uid</code> and <code>pass</code> values into the fields above.</li>
                  <li>{"Don't share these — they're equivalent to your password."}</li>
                </ol>
              )}
            </div>

            {/* Test connection */}
            <div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void runTdTest()}
                  disabled={!tdCredentialsStored || tdTestResult === "loading"}
                  className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {tdTestResult === "loading" ? "Testing…" : "Test connection"}
                </button>
                {tdTestResult && tdTestResult !== "loading" && (
                  <span
                    className={`text-xs ${tdTestResult.ok ? "text-emerald-400" : "text-red-400"}`}
                  >
                    {tdTestResult.ok
                      ? `✓ ${tdTestResult.sample?.length ?? 0} results — first: ${tdTestResult.sample?.[0] ?? ""}`
                      : `✗ ${tdTestResult.error ?? "unknown error"}`}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-zinc-600">
                Streaming via a private tracker may affect your seed ratio. TorrentDay{"'"}s ToS may
                not permit third-party clients.
              </p>
            </div>
          </div>

          {/* Stremio Addons subsection */}
          <div className="mt-6 border-t border-zinc-800 pt-5">
            <p className="text-xs font-medium text-zinc-300">Stremio Addons</p>
            <p className="mt-1 text-xs text-zinc-500">
              Paste a Stremio addon URL to pull in its indexer coverage. Most popular:{" "}
              <strong className="text-zinc-400">Torrentio</strong> with optional Real-Debrid.
              Self-host or use a personalised configured URL if rate-limited.
            </p>

            {/* Add row */}
            <div className="mt-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={stremioUrlInput}
                  onChange={(e) => { setStremioUrlInput(e.target.value); setStremioAddError(""); setStremioAddSuccess(null); }}
                  placeholder="Manifest URL — e.g. https://torrentio.strem.fun/.../manifest.json"
                  className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
                <button
                  onClick={() => void addStremioAddon()}
                  disabled={stremioUrlInput.trim() === "" || stremioAddPending}
                  className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {stremioAddPending ? "Adding…" : "Add"}
                </button>
              </div>
              {stremioAddError && (
                <p className="mt-1 text-xs text-red-400">{stremioAddError}</p>
              )}
              {stremioAddSuccess && (
                <div className="mt-1 space-y-1">
                  <p className="text-xs text-emerald-400">✓ Added: {stremioAddSuccess.name}</p>
                  {stremioAddSuccess.warning && (
                    <p className="text-xs text-amber-400">⚠ {stremioAddSuccess.warning}</p>
                  )}
                </div>
              )}
            </div>

            {/* Addon list */}
            {stremioAddons.length === 0 ? (
              <p className="mt-3 text-xs text-zinc-600">No Stremio addons configured.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {stremioAddons.map((addon) => {
                  const testResult = stremioTestResults[addon.id];
                  return (
                    <div
                      key={addon.id}
                      className="rounded-lg border border-zinc-700 bg-zinc-950 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-zinc-200">{addon.name}</p>
                          <code className="block truncate text-[10px] text-zinc-600 mt-0.5">
                            {addon.url}
                          </code>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-2">
                          <input
                            type="checkbox"
                            id={`stremio-enabled-${addon.id}`}
                            checked={addon.enabled}
                            onChange={(e) => toggleStremioAddon(addon.id, e.target.checked)}
                            className="h-4 w-4 rounded border-zinc-600 accent-emerald-500"
                            title={addon.enabled ? "Disable addon" : "Enable addon"}
                          />
                          <label
                            htmlFor={`stremio-enabled-${addon.id}`}
                            className="text-xs text-zinc-400 cursor-pointer"
                          >
                            {addon.enabled ? "Enabled" : "Disabled"}
                          </label>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <button
                          onClick={() => void runStremioTest(addon.id)}
                          disabled={testResult === "loading"}
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
                        >
                          {testResult === "loading" ? "Testing…" : "Test"}
                        </button>
                        <button
                          onClick={() => setStremioRemoveConfirm(addon.id)}
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-red-400 hover:bg-zinc-800"
                        >
                          Remove
                        </button>
                        {stremioRemoveConfirm === addon.id && (
                          <span className="flex items-center gap-1 text-xs text-zinc-400">
                            Remove this addon?
                            <button
                              onClick={() => void removeStremioAddon(addon.id)}
                              className="rounded-md bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-500"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setStremioRemoveConfirm(null)}
                              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
                            >
                              Cancel
                            </button>
                          </span>
                        )}
                      </div>
                      {testResult && testResult !== "loading" && (
                        <div className="mt-1.5">
                          {testResult.ok && (testResult.sampleCount ?? 0) > 0 ? (
                            <span className="text-xs text-emerald-400">
                              ✓ {testResult.sampleCount} results — first: {testResult.firstTitle ?? ""}
                              {testResult.hasStreamUrl ? (
                                <span className="ml-2 rounded-full border border-amber-600/40 bg-amber-900/30 px-1.5 py-0.5 text-[10px] text-amber-400">
                                  Real-Debrid wired
                                </span>
                              ) : (
                                <span className="ml-1 text-zinc-600">(torrent magnets only)</span>
                              )}
                            </span>
                          ) : testResult.ok && (testResult.sampleCount ?? 0) === 0 ? (
                            <span className="text-xs text-amber-400">
                              ✓ Reachable, but 0 results for Inception (may be anime-only or not configured)
                            </span>
                          ) : (
                            <span className="text-xs text-red-400">✗ {testResult.error ?? "unknown error"}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Security warning */}
            <p className="mt-3 text-xs text-zinc-600">
              Addon URLs may contain personalised secrets (Real-Debrid API keys). Treat them like
              passwords — do not share screenshots.
            </p>
          </div>
        </div>

        <div className="mt-8 border-t border-zinc-800 pt-6 text-xs text-zinc-500">
          <p className="font-medium text-zinc-400">Network notes</p>
          <ul className="mt-2 list-disc pl-4">
            <li>The server binds to <code>0.0.0.0:3000</code> so Chromecasts on the LAN can reach the stream.</li>
            <li>YTS / EZTV rotate domains. Override <code>YTS_BASE_URL</code> / <code>EZTV_BASE_URL</code> in <code>.env</code> if a default stops responding.</li>
          </ul>
        </div>
        </div>
      </div>
    </div>
  );
}

function relativeTime(ts: number | null): string {
  if (ts === null) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function VpnBadge({ health }: { health: VpnHealth }) {
  const { mode, leaking, reachable } = health;
  let label = "OFF";
  let cls = "border-zinc-700 bg-zinc-800/60 text-zinc-300";
  let ariaState = "off";
  if (leaking) {
    label = "LEAKING";
    cls = "border-red-700/50 bg-red-900/40 text-red-300";
    ariaState = "leaking";
  } else if (mode === "vpn" && reachable) {
    label = "VPN";
    cls = "border-emerald-700/50 bg-emerald-900/40 text-emerald-300";
    ariaState = "healthy";
  } else if (mode === "vpn" && !reachable) {
    label = "UNREACHABLE";
    cls = "border-amber-700/50 bg-amber-900/40 text-amber-300";
    ariaState = "unreachable";
  }
  return (
    <span
      role="status"
      aria-label={`VPN status: ${ariaState}`}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

function VpnSection() {
  const vpn = useQuery({
    queryKey: ["vpn-health"],
    queryFn: () => api.vpnHealth(),
  });
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const qc = useQueryClient();

  // Bump every 10s so the "last checked" relative time re-renders.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);
  void tick;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await api.vpnHealth(true);
      qc.setQueryData(["vpn-health"], data);
    } finally {
      setRefreshing(false);
    }
  };

  const h = vpn.data;

  return (
    <div
      id="vpn-settings"
      className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 scroll-mt-8"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200">Network / VPN</p>
        {h && <VpnBadge health={h} />}
      </div>

      {vpn.isPending && (
        <p className="mt-3 text-xs text-zinc-500">Loading…</p>
      )}
      {vpn.isError && (
        <p className="mt-3 text-xs text-red-400">
          Failed to load VPN health: {vpn.error.message}
        </p>
      )}

      {h && (
        <>
          <dl className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-xs text-zinc-400">Exit IP</dt>
              <dd className="text-xs text-zinc-200">
                <code>{h.publicIp ?? "—"}</code>
                <span className="mx-1 text-zinc-600">·</span>
                <span>{countryFlag(h.country)}</span>{" "}
                <span>{h.country ?? "—"}</span>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-xs text-zinc-400">Last checked</dt>
              <dd className="text-xs text-zinc-500">
                {relativeTime(h.lastCheckedAt)}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-[11px] text-zinc-600">
            Peer: <code className="text-zinc-500">{h.wgPeer ?? "—"}</code>
          </p>

          {h.mode === "off" && (
            <p className="mt-3 text-xs text-zinc-500">
              VPN routing disabled. Set <code>VPN_MODE=vpn</code> and provide{" "}
              <code>/etc/castcrate/wg0.conf</code> to enable.
            </p>
          )}

          <div className="mt-4 flex items-center justify-end">
            <button
              onClick={() => void onRefresh()}
              disabled={refreshing}
              aria-label="Refresh VPN health"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </>
      )}
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
