# Status: what shipped vs remaining

This replaces the earlier review and integration plan. Each item below was checked against `src/`, `functions/`, `public/`, `tests/`, and `docs/` as they stand. Items not re-checked are marked as such.

Checks run for this status: `npx tsc -b` passes, `npx oxlint src` reports no errors or warnings, and `npx vitest run` passes 124 tests in 4 files.

## Shipped

### Earlier review items

| Item (original review) | Status | Where |
|---|---|---|
| Password hashed twice at login and signup | Fixed. The form no longer hashes. `login` upgrades old double-hashed values. | `LoginScreen.tsx`, `store.ts` |
| Pipeline ingest called with the wrong arguments | Fixed. The call matches `bulkAddEntities(caseId, typeId, items, clearance)`. The store returns `BulkAddResult`. | `PipelineTab.tsx`, `store.ts` |
| Hooks after an early return (Explorer, Analytics) | Fixed. Hooks sit above the guards in both tabs. | `ExplorerTab.tsx`, `AnalyticsTab.tsx` |
| Unescaped incident text in map popups and icons | Fixed. Values go through `escapeHtml`. | `MapTab.tsx`, `utils/html.ts` |
| Deleting an ontology type deleted its objects | Fixed. The store removes only the type, and the dialog says objects keep their data. | `store.ts`, `OntologyTab.tsx` |
| `Math.random` IDs | Fixed. `crypto.randomUUID`, with a `getRandomValues` fallback on plain http. | `store.ts` |
| Whole-workspace save on every click, unbounded log, silent quota errors | Mostly fixed. Saves are debounced 300 ms, the log is capped at 150, quota errors show a banner, and `App` uses `useSyncExternalStore`. | `store.ts`, `App.tsx` |
| No shared detail view | Done. `DetailDrawer` is mounted once in `App`. | `ui/DetailDrawer.tsx` |
| Invalid dates gave NaN timeline bounds | Fixed. Non-finite times are ignored. | `MapTab.tsx` |
| `AnalyticsTab` and `OmniSearch` never mounted | Fixed. Both are mounted. `store.askCopilot` is still a stub with no callers. | `App.tsx`, `store.ts` |
| Anyone could sign up as TOP_SECRET | Fixed. Signup always creates UNCLASSIFIED. Only a TOP_SECRET user can change clearance. | `store.ts`, `SettingsTab.tsx` |
| AI keys in localStorage | Fixed. Keys are in sessionStorage only. | `store.ts`, `ai/` |
| Case data reaching AI providers without a gate | Fixed for the AI tab. The send gate builds the payload and requires an acknowledgement. | `ai/gate.ts` |
| Lint errors, `any`, README wrong about pnpm and D3 | Fixed. No `any` remains in `src/`. README is corrected. | `src/`, `README.md` |
| No tests, no git, `dist/` tracked, no code splitting | Partly fixed. Vitest runs 124 tests. The repo is a git repo and `dist/` is ignored. Tabs are lazy-loaded. A Playwright smoke test does not exist. | `tests/`, `.gitignore`, `App.tsx` |

### Osiris integration plan

| Phase | Status | Notes |
|---|---|---|
| 1. Foundations | Mostly done | Dev proxy for `/osiris`, `docker-compose.yml` with a sidecar behind nginx. The image tag is required through `OSIRIS_IMAGE_TAG`, with no default. Osiris's LICENSE and SECURITY notes are not reviewed here. |
| 2. Live Feeds layer | Done | Seven layers: earthquakes, flights, fires, weather, GDELT, news, satellites. Client has an 8 s timeout and a 60 s cache. Feed items are not stored in the case. |
| 3. Promote to case | Partly done | Promotes to an **incident** only, with provenance in the description. No separate `source` field, no entity promotion, and no audit entry. |
| 4. Signals from feeds | Done, different shape | Up to 5 rule-based watch rules per case: minimum severity, keyword, or distance to an incident. Auto-run every 5 minutes. Deduplicated by `source_id`. No AI. |
| 5. Enrichment | Done, different shape | Sanctions, wallet, WHOIS, and IP lookups from the entity drawer and Explorer. Classified objects need confirmation. Not built as Ontology Action Types. |
| 6. Osiris assistant in the AI tab | Not done | The AI tab calls providers directly with the user's key, through the send gate. Osiris OI and the MCP endpoint are not wired in. |
| 7. Global Ops tab | Done | Sandboxed frame for an https address the user enters. |
| 8. Real backend | Not done | No server. See Remaining. |

### Added since the original plan

- **Browser tab**: reader view of third-party pages through `/browse`, with tabs, bookmarks, and save to case. See `docs/CLOUDFLARE.md` and `docs/ARCHITECTURE.md`.
- **Settings tab**: storage meter, workspace and case backup and restore, password change, user clearance and deletion (TOP_SECRET only), and erase all local data.

## Remaining

These are the open items from the earlier review and this pass.

1. **Osiris response shapes are unverified against a live instance.** The normalizers accept several plausible shapes and drop anything else silently. OSINT query parameter names and the bounding-box format are unverified too.
2. **Browser proxy, DNS gap.** The address check reads the URL text only. A public name that resolves to a private address, or rebinds at fetch time, is not blocked by the code. This needs a test from the deployed site. A Cloudflare WAF rate-limit rule for `/browse*` is needed and is not in the repo. Terms of service for proxied sources have not been checked.
3. **Default admin password.** The first run creates `admin` / `admin` as TOP_SECRET. Settings warns while it is unchanged. Nothing forces a change.
4. **Authentication is client-side and demo-grade.** Passwords use a 32-bit unsalted hash (`mockHash`). There is no server, session expiry, lockout, or rate limiting.
5. **16 KB cookie cap.** The whole site shares 16,000 bytes of cookies. Bookmarks now count against it too.
6. **Non-Anthropic model names are unverified.** The default model names for OpenAI, Gemini, and Mistral in `src/ai/providers.ts` must be checked against each provider's current list.
7. **EONET fallback timeout.** The keyless weather fallback has a 10 s upstream timeout and a 16 MB cap. The EONET payload is large, so the weather layer can return 504.

Also open, found in code:

- **OpenSanctions attribution** is shown in the entity drawer's Enrich section only. The Explorer sanctions button shows results without it.
- **Native `alert()`** is still used twice in `MapTab.tsx` for geocoding errors.
- **Clearance filtering** is applied in the AI gate, export, and several views, not uniformly. Not re-audited in this pass.
- **Source entities** from the Browser tab use the type string `Source`, which is not an ontology type.
- **Osiris promotion** writes no audit entry and no `source` field (see Phase 3).
- **Google Fonts** is still loaded at runtime from `index.html`, so offline use fails for the font.
- **Naming.** `package.json` is still `palantir`, the cookie prefix is `aegis_ws`, and the folder is `Palantir`. The UI says Aegis Nexus.
- **Tests** do not cover `functions/`, `src/browser/`, the Settings tab, or the Browser tab.
- **Accessibility and responsive layout** were not re-checked in this pass.
- **Dependency audit** (4 high-severity findings in dev tooling, per README) was not re-run in this pass.

Intentionally out of scope: RECON port and vulnerability scanning (not in the repo, per `.env.example`), and Telegram scraping and camera feeds (no code for either exists in `src/` or `functions/`).
