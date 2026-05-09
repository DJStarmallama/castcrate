# knaben-fallback — Context

**Last updated:** 2026-05-09
**Status:** Implemented (retrospective doc)

## Status

- Knaben fallback wired on movie + TV episode searches
- DNS bypass via Cloudflare always-on by default
- `tried` array surfaces which indexers were consulted
- Recent commit `1d279aa` migrated host (`.eu` → `.org`), added `magnetUrl` support, added S1E5 / 1x5 forms

## Key files

- `apps/server/src/services/knaben.ts` — adapter
- `apps/server/src/lib/dns.ts` — `setupDnsBypass()`
- `apps/server/src/routes/torrents.ts` — fallback wiring
- `apps/server/src/index.ts` — boots DNS bypass
- `apps/server/src/services/__tests__/knaben.test.ts`

## Decisions

- **Empty-result-only fallback (not error-based or timeout-based).** Simpler; latency hit is acceptable on the rare empty primary.
- **DNS bypass is global.** Avoid the complexity of per-host plumbing; works for every indexer with no extra config.
- **Cloudflare 1.1.1.1 / 1.0.0.1 default.** Reliable and not commonly blocked at the resolver layer.
- **Fall through to OS resolver on upstream failure.** Preserves `/etc/hosts` and mDNS.
- **`\b`-bounded regex for episode forms.** Prevents `S01E5` matching `S01E50`. Critical for correctness.
- **No automatic rotation.** If Knaben's `.org` host dies too, env override + redeploy. Adding rotation logic for two indexers is overkill.

## Gotchas

- **No env example for Knaben/DNS vars.** Document them in `.env.example`.
- **Title required for episode fallback** — without it the route silently skips Knaben.
- **DNS bypass doesn't fix port-53 interception.** Mention VPN in README (already done).
- **Magnet reconstruction uses hardcoded trackers.** If they all die, peer count is zero.
- **No rate limiting.** Bulk searches could trip 429.
- **Episode tag + regex both miss → silent skip.** No fuzzy-match fallback.
