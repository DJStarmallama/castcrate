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
});
