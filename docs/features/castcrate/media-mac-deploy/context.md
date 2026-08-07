# media-mac-deploy — Context

**Last updated:** 2026-08-07

Running notes / decisions / surprises from executing the runbook. Grow this as things happen; each session, drop a short entry with what was done, what deviated from the plan, and any config that had to be tuned.

## Session log

_(empty — nothing done yet. Format below.)_

### 2026-MM-DD — Phase X: <summary>

- What was done: <bullet list>
- Deviations from `tasks.md`: <e.g. NodeSource had no 26.04 codename, used noble repo>
- Values chosen: <e.g. LAN CIDR = 192.168.1.0/24, IP reservation = .42>
- Errors / follow-ups: <e.g. mDNS not reaching Chromecast until router IGMP-snooping disabled>

---

## Key values (fill in as you go)

- **LAN IP (reserved):** _tbd_
- **LAN CIDR (used in ufw rules):** _tbd_
- **Hostname:** `castcrate` (`.local` via avahi)
- **User:** `castcrate`
- **Download path:** `/home/castcrate/castcrate-downloads`
- **OMDb key location:** `apps/server/.env` on the box (never committed)
- **Chromecast device name(s):** _tbd_

## Known gotchas we've hit

_(none yet — populate as we hit them)_
