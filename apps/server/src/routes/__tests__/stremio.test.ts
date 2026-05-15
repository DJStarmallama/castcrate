/**
 * Routes — stremio addon management endpoints + maskStremioUrl helper.
 *
 * Endpoint tests use lightweight mocks of the service layer so we don't need
 * a live Fastify server. We exercise the routing logic by calling the handler
 * functions directly through a minimal Fastify instance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock service dependencies before importing the routes under test.
// ---------------------------------------------------------------------------

vi.mock("../../services/settings.js", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../../services/stremio.js", () => ({
  validateAddon: vi.fn(),
  normaliseAddonBase: vi.fn((url: string) =>
    url.trim().replace(/\/manifest\.json$/i, "").replace(/\/$/, ""),
  ),
  searchStremioMovie: vi.fn(),
}));

import { maskStremioUrl } from "../stremio.js";
import { getSettings, updateSettings } from "../../services/settings.js";
import { validateAddon, searchStremioMovie } from "../../services/stremio.js";

// ---------------------------------------------------------------------------
// Helper — build fake addon entries.
// ---------------------------------------------------------------------------

type FakeAddon = { id: string; url: string; name: string; enabled: boolean };

function makeAddon(overrides: Partial<FakeAddon> = {}): FakeAddon {
  return {
    id: "abc12345",
    url: "https://torrentio.strem.fun",
    name: "Torrentio",
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// maskStremioUrl — unit tests
// ---------------------------------------------------------------------------

describe("maskStremioUrl", () => {
  it("masks a path-bearing URL, preserving host", () => {
    expect(maskStremioUrl("https://torrentio.strem.fun/debridoptions=RD%7CapiKey=abc123"))
      .toBe("https://torrentio.strem.fun/****");
  });

  it("returns bare host when there is no path (no trailing slash)", () => {
    expect(maskStremioUrl("https://example.com"))
      .toBe("https://example.com");
  });

  it("returns bare host when path is exactly '/'", () => {
    expect(maskStremioUrl("https://example.com/"))
      .toBe("https://example.com");
  });

  it("masks multi-segment paths", () => {
    expect(maskStremioUrl("https://addon.example.com/user/config/secret/manifest.json"))
      .toBe("https://addon.example.com/****");
  });

  it("handles http:// scheme", () => {
    expect(maskStremioUrl("http://localhost:7000/path"))
      .toBe("http://localhost:7000/****");
  });

  it("returns '****' for malformed URLs", () => {
    expect(maskStremioUrl("not-a-url")).toBe("****");
    expect(maskStremioUrl("")).toBe("****");
  });

  it("preserves port in host", () => {
    expect(maskStremioUrl("https://addon.example.com:8080/some-secret/path"))
      .toBe("https://addon.example.com:8080/****");
  });
});

// ---------------------------------------------------------------------------
// Route handlers — exercised via Fastify buildInject pattern.
// We build a real lightweight Fastify instance so plugin boundaries work.
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { stremioRoutes } from "../stremio.js";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(stremioRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// POST /api/stremio/addons
// ---------------------------------------------------------------------------

describe("POST /api/stremio/addons", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();
  });

  it("returns 400 when url is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/stremio/addons", body: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/url must be/i);
  });

  it("returns 400 when url lacks http scheme", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: "ftp://bad.example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/url must be/i);
  });

  it("returns 400 when validateAddon fails", async () => {
    (validateAddon as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "addon doesn't expose stream resource",
    });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: "https://catalog-only.example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/stream resource/i);
  });

  it("returns 409 when addon URL already exists", async () => {
    const existingUrl = "https://torrentio.strem.fun";
    (validateAddon as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      manifest: { id: "org.torrentio", name: "Torrentio", version: "1.0.0", resources: ["stream"], types: ["movie"] },
    });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      stremioAddons: [makeAddon({ url: existingUrl })],
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: existingUrl },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/already added/i);
  });

  it("returns 201 with the new addon entry on success", async () => {
    (validateAddon as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      manifest: { id: "org.torrentio", name: "Torrentio", version: "1.0.0", resources: ["stream"], types: ["movie"] },
    });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [] });
    (updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: "https://torrentio.strem.fun/manifest.json" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ addon: FakeAddon; warning?: string }>();
    expect(body.addon).toBeDefined();
    // id should be 8 chars generated from randomUUID
    expect(body.addon.id).toHaveLength(8);
    expect(body.addon.name).toBe("Torrentio");
    expect(body.addon.enabled).toBe(true);
    // url is normalised — /manifest.json stripped
    expect(body.addon.url).toBe("https://torrentio.strem.fun");
    expect(body.warning).toBeUndefined();
  });

  it("includes warning in 201 response when validateAddon returns one", async () => {
    (validateAddon as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      manifest: {
        id: "org.kitsu",
        name: "Kitsu Addon",
        version: "1.0.0",
        resources: ["stream"],
        types: ["anime"],
        idPrefixes: ["kitsu:"],
      },
      warning: "addon may not support IMDb-keyed (tt…) lookups",
    });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [] });
    (updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: "https://kitsu.example.com" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ addon: FakeAddon; warning?: string }>();
    expect(body.warning).toBeDefined();
    expect(body.warning).toMatch(/IMDb/);
  });

  it("calls updateSettings with the new addon appended to existing list", async () => {
    const existingAddon = makeAddon({ id: "existing1", url: "https://other.example.com" });
    (validateAddon as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      manifest: { id: "org.new", name: "New Addon", version: "1.0.0", resources: ["stream"], types: ["movie"] },
    });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [existingAddon] });
    (updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await app.inject({
      method: "POST",
      url: "/api/stremio/addons",
      body: { url: "https://new-addon.example.com" },
    });

    const updateCall = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      stremioAddons: FakeAddon[];
    };
    expect(updateCall.stremioAddons).toHaveLength(2);
    expect(updateCall.stremioAddons[0]!.id).toBe("existing1");
    expect(updateCall.stremioAddons[1]!.name).toBe("New Addon");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/stremio/addons/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/stremio/addons/:id", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();
  });

  it("returns 404 when id is not found", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [] });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/stremio/addons/nonexistent",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/not found/i);
  });

  it("returns 204 and calls updateSettings with addon removed", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      stremioAddons: [addon],
    });
    (updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await app.inject({
      method: "DELETE",
      url: "/api/stremio/addons/abc12345",
    });
    expect(res.statusCode).toBe(204);

    const updateCall = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      stremioAddons: FakeAddon[];
    };
    expect(updateCall.stremioAddons).toHaveLength(0);
  });

  it("removes only the targeted addon when multiple addons exist", async () => {
    const addon1 = makeAddon({ id: "aaa11111", url: "https://first.example.com" });
    const addon2 = makeAddon({ id: "bbb22222", url: "https://second.example.com" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      stremioAddons: [addon1, addon2],
    });
    (updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await app.inject({
      method: "DELETE",
      url: "/api/stremio/addons/aaa11111",
    });
    expect(res.statusCode).toBe(204);

    const updateCall = (updateSettings as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      stremioAddons: FakeAddon[];
    };
    expect(updateCall.stremioAddons).toHaveLength(1);
    expect(updateCall.stremioAddons[0]!.id).toBe("bbb22222");
  });
});

// ---------------------------------------------------------------------------
// GET /api/stremio/test/:id
// ---------------------------------------------------------------------------

describe("GET /api/stremio/test/:id", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();
  });

  it("returns 404 when id is not found", async () => {
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [] });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/unknownid",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns ok:false when addon is disabled", async () => {
    const addon = makeAddon({ id: "disabled1", enabled: false });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/disabled1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/disabled/i);
  });

  it("calls searchStremioMovie with the single addon as override (Inception imdb)", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });
    (searchStremioMovie as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        {
          title: "Inception.2010.1080p.BluRay.x264",
          streamUrl: undefined,
          magnet: "magnet:?xt=urn:btih:abc",
        },
      ],
      errors: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/abc12345",
    });
    expect(res.statusCode).toBe(200);

    const [imdbArg, overrideArg] = (searchStremioMovie as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(imdbArg).toBe("tt1375666");
    // Override should be a one-element array containing exactly this addon.
    expect(overrideArg).toHaveLength(1);
    expect(overrideArg[0].id).toBe("abc12345");
  });

  it("returns ok:true with sampleCount and firstTitle on success", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });
    (searchStremioMovie as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        {
          title: "Inception.2010.1080p.BluRay.x264",
          streamUrl: undefined,
          magnet: "magnet:?xt=urn:btih:abc",
        },
        {
          title: "Inception 2010 4K",
          streamUrl: "https://cdn.example.com/inception.mkv",
          magnet: "",
        },
      ],
      errors: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/abc12345",
    });
    const body = res.json<{
      ok: boolean;
      sampleCount: number;
      firstTitle: string;
      hasStreamUrl: boolean;
    }>();
    expect(body.ok).toBe(true);
    expect(body.sampleCount).toBe(2);
    expect(body.firstTitle).toBe("Inception.2010.1080p.BluRay.x264");
    expect(body.hasStreamUrl).toBe(true);
  });

  it("returns ok:true with sampleCount:0 when addon returns no results", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });
    (searchStremioMovie as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
      errors: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/abc12345",
    });
    const body = res.json<{ ok: boolean; sampleCount: number; firstTitle?: string }>();
    expect(body.ok).toBe(true);
    expect(body.sampleCount).toBe(0);
    expect(body.firstTitle).toBeUndefined();
  });

  it("returns ok:false with error code when addon errors and returns no results", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });
    (searchStremioMovie as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [],
      errors: [{ addonId: "abc12345", addonName: "Torrentio", code: "timeout" }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/abc12345",
    });
    const body = res.json<{ ok: boolean; error: string }>();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("timeout");
  });

  it("surfaces error code in ok:true response when addon errored but still returned results", async () => {
    const addon = makeAddon({ id: "abc12345" });
    (getSettings as ReturnType<typeof vi.fn>).mockReturnValue({ stremioAddons: [addon] });
    (searchStremioMovie as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        { title: "Inception.2010.1080p", streamUrl: undefined, magnet: "magnet:?xt=urn:btih:abc" },
      ],
      errors: [{ addonId: "abc12345", addonName: "Torrentio", code: "fetch" }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/stremio/test/abc12345",
    });
    const body = res.json<{ ok: boolean; sampleCount: number; error?: string }>();
    // At least one result → ok:true, but error field is still surfaced.
    expect(body.ok).toBe(true);
    expect(body.sampleCount).toBe(1);
    expect(body.error).toBe("fetch");
  });
});
