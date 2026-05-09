import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect ~/.castcrate to a temp dir before importing the module.
const TMP = mkdtempSync(join(tmpdir(), "castcrate-history-"));
vi.mock("node:os", async () => {
  const real = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...real, homedir: () => TMP };
});

const { listHistory, appendHistory, clearHistory, updateHistoryById } =
  await import("../history.js");

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearHistory();
});

const sample = (overrides: Partial<Parameters<typeof appendHistory>[0]> = {}) => ({
  id: "id-1",
  title: "Inception",
  posterUrl: null,
  imdbId: "tt1375666",
  resolution: "1080p",
  videoName: "Inception.2010.1080p.mp4",
  startedAt: new Date(0).toISOString(),
  endedAt: new Date(1).toISOString(),
  completed: true,
  ...overrides,
});

describe("history", () => {
  it("starts empty", async () => {
    expect(await listHistory()).toEqual([]);
  });

  it("appendHistory persists and prepends", async () => {
    await appendHistory(sample({ id: "a" }));
    await appendHistory(sample({ id: "b" }));
    const list = await listHistory();
    expect(list.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("clearHistory empties the list", async () => {
    await appendHistory(sample({ id: "a" }));
    await clearHistory();
    expect(await listHistory()).toEqual([]);
  });

  it("caps at 200 entries", async () => {
    for (let i = 0; i < 210; i++) {
      await appendHistory(sample({ id: `id-${i}` }));
    }
    const list = await listHistory();
    expect(list.length).toBe(200);
    expect(list[0]?.id).toBe("id-209");
  });

  it("updateHistoryById merges fields and returns true", async () => {
    await appendHistory(sample({ id: "a", completed: false }));
    const ok = await updateHistoryById("a", {
      endedAt: new Date(42).toISOString(),
      completed: true,
    });
    expect(ok).toBe(true);
    const list = await listHistory();
    expect(list[0]?.completed).toBe(true);
    expect(list[0]?.endedAt).toBe(new Date(42).toISOString());
  });

  it("updateHistoryById returns false for unknown id", async () => {
    await appendHistory(sample({ id: "a" }));
    const ok = await updateHistoryById("missing", { completed: false });
    expect(ok).toBe(false);
  });

  it("atomic write leaves no .tmp behind on success", async () => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    await appendHistory(sample({ id: "a" }));
    expect(existsSync(join(TMP, ".castcrate", "history.json"))).toBe(true);
    expect(existsSync(join(TMP, ".castcrate", "history.json.tmp"))).toBe(false);
  });

  // D3: cast-start writes an entry; removal updates that entry instead of
  // appending a duplicate. This exercises the route storage contract.
  it("cast-start → removal updates the same entry, no duplicate", async () => {
    const startedAt = new Date(0).toISOString();
    // Cast start path: append with completed=false
    await appendHistory(
      sample({
        id: "session-1",
        startedAt,
        endedAt: startedAt,
        completed: false,
      }),
    );
    // Removal path: the route calls updateHistoryById when meta.historyId is set
    const ended = new Date(60_000).toISOString();
    const ok = await updateHistoryById("session-1", { endedAt: ended, completed: true });
    expect(ok).toBe(true);
    const list = await listHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "session-1",
      completed: true,
      endedAt: ended,
      startedAt,
    });
  });
});

// D4: corrupted JSON / missing file recovery.
// The history module caches in memory, so to exercise the on-disk read path
// we use vi.resetModules() to force a fresh import each time.
describe("history corruption recovery", () => {
  it("treats malformed JSON as empty without throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(TMP, ".castcrate", "history.json"), "{not valid json", "utf8");
    vi.resetModules();
    const { listHistory: list } = await import("../history.js");
    expect(await list()).toEqual([]);
  });

  it("treats a partial / truncated write as empty without throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // Truncated array — JSON.parse will throw
    await writeFile(
      join(TMP, ".castcrate", "history.json"),
      '[{"id":"a","title":"x"',
      "utf8",
    );
    vi.resetModules();
    const { listHistory: list } = await import("../history.js");
    expect(await list()).toEqual([]);
  });

  it("treats a missing file as empty without throwing", async () => {
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(TMP, ".castcrate", "history.json"), { force: true });
    vi.resetModules();
    const { listHistory: list } = await import("../history.js");
    expect(await list()).toEqual([]);
  });
});
