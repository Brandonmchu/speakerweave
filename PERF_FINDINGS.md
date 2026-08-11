# Wave 20 frontend perceived-performance findings

Date: 2026-08-11

Scope: `web/**`, measured with the repository's production Vite build. No API, CLI, design-sync, or agent-internal component files were changed.

## Executive summary

The largest issue was not simply “one big bundle.” The baseline entry file was 315.36 kB, but `dist/index.html` also module-preloaded broad `vendor`, `ui`, `dates`, Clerk, React, and Query chunks. The real startup JavaScript chain was therefore **1,281.99 kB raw / 375.02 kB gzip** before a route rendered. Route-level `lazy()` calls could not help because the catch-all manual chunks pulled route-only dependencies back into that startup chain.

Top five material findings, ranked by impact/risk:

1. **Global vendor/UI chunks defeated route splitting.** Fixed. Critical JavaScript is now **590.17 kB raw / 180.38 kB gzip**, a **54.0% raw / 51.9% gzip reduction**.
2. **Thirteen non-critical pages were eager, while the landing itself paid an extra lazy-import round trip.** Fixed. Twenty-two non-critical page modules are now lazy with structural fallbacks; Home and `AppShell` remain eager. The entry file fell from **315.36 to 232.52 kB raw** and **82.72 to 71.95 kB gzip**.
3. **Capability-disabled chat still shipped its full Markdown stack.** Fixed. The agent source is now a **63.79 kB / 19.42 kB gzip** lazy chunk and Markdown is a separate **334.53 kB / 101.74 kB gzip** lazy chunk. Neither appears in `index.html`; both remain absent when capabilities are off and are warmed only during idle time after capabilities opt in.
4. **The cold dashboard and submissions paths have one real data dependency waterfall.** Partially addressed. The shared events request is deduplicated and submissions' three dependent reads run in parallel, but an event ID is required before event-scoped reads can start. Removing that cold RTT needs a bootstrap contract or trusted cached event identity, so it is proposed rather than guessed at in the frontend.
5. **Large CRM/roster views and shell-owned form state caused avoidable interaction work.** Fixed locally where safe: Directory keeps its prior list during filter fetches, Directory and Speakers defer expensive search work, and create-event keystrokes no longer re-render the entire shell/outlet. Full list virtualization remains a measured-data proposal because it can affect table, focus, and drag semantics.

## Measurement method and before/after

Baseline and final builds used `cd web && npm run build`. Chunk sizes below are Vite's minified output; “critical JS” is the entry plus every JavaScript file module-preloaded by generated `dist/index.html`, not every lazy chunk in `dist`.

| Metric | Baseline | Final | Delta |
|---|---:|---:|---:|
| Entry JS | 315.36 kB / 82.72 kB gzip | 232.52 kB / 71.95 kB gzip | -26.3% raw / -13.0% gzip |
| Critical JS chain | 1,281.99 kB / 375.02 kB gzip | 590.17 kB / 180.38 kB gzip | -54.0% raw / -51.9% gzip |
| CSS | 82.95 kB / 14.19 kB gzip | 83.18 kB / 14.24 kB gzip | +0.23 kB raw (structural route skeleton classes) |
| HTML | 1.56 kB / 0.73 kB gzip | 1.32 kB / 0.69 kB gzip | -0.24 kB raw |
| Landing hero JPEG | 81.82 kB | 81.82 kB | unchanged; now conditionally preloaded |
| Precompressed files | 0 | 46 `.gz` siblings | build-time compression added |

Baseline module-preloads: `framework`, `query`, `vendor`, `auth`, `ui`, `dates`. Final module-preloads: `framework`, `query`, `auth`. Vite supplies these hash-correct modulepreload tags automatically; hard-coding emitted filenames in source HTML would be brittle.

The environment did not permit binding a local preview server (`listen EPERM` on `127.0.0.1:4173`), so browser LCP timing and filmstrips could not be collected here. LCP elements below are identified from the real responsive DOM and asset geometry, not invented timing numbers. Production RUM or a Railway preview should validate them under target devices/network conditions.

## Initial-load critical paths

### `/` landing

Actual path after this wave:

1. `web/index.html:13-21` supplies only an inline background/font fallback; there are no synchronous external scripts or web-font requests. Vite injects the hashed module entry, generated modulepreloads, and the production stylesheet at build time.
2. `web/src/main.tsx:36-45` mounts Router → Clerk → Query → App. Clerk is opt-in, but its SDK is still a static bundle dependency (`web/src/auth/clerk.tsx:3-18`).
3. With Clerk configured and no local demo token, `HomeEntry` waits for `SignedIn`/`SignedOut` to choose between the app and landing (`web/src/App.tsx:171-187`). This is an authentication correctness gate and can delay meaningful landing paint on a cold Clerk session.
4. Home is eager (`web/src/App.tsx:124-125`), so it no longer adds a route-chunk network turn. Its likely desktop LCP is the large agenda screenshot (`web/src/pages/Home.tsx:303-328`, 81.82 kB); on narrow/mobile viewports the 4xl/5xl hero heading at `web/src/pages/Home.tsx:271-273` is the likely LCP because the image moves below it.
5. React 19 emits a conditional high-priority image preload only when Home renders (`web/src/pages/Home.tsx:133-136`). This avoids making `/dashboard` download a marketing image while letting the landing discover its LCP resource before the image commit.

Remaining blocker: the external 83.18 kB CSS file is render-blocking, though it is only 14.24 kB gzip. Critical-CSS extraction or landing prerendering could improve this further, but both add build and hydration complexity and are proposals only.

### `/dashboard` authenticated

Actual path:

1. The same HTML and critical JS chain boot first.
2. In Clerk mode, `ClerkRequireAuth` withholds the shell until Clerk reports `SignedIn` (`web/src/auth/clerk.tsx:52-66`). `ClerkTokenBridge` then supplies the API token getter (`web/src/auth/clerk.tsx:26-41`). This auth wait is required to avoid rendering protected UI for an unknown session.
3. `AppShell` paints eagerly while the Dashboard route chunk loads behind the structural route skeleton (`web/src/App.tsx:94-121`, `web/src/App.tsx:270`). The Dashboard chunk is **12.07 kB / 4.04 kB gzip**, plus shared date helpers.
4. The shell and Dashboard consume the same `['events']` query (`web/src/shell/AppShell.tsx:328-333`, `web/src/pages/Dashboard.tsx:114-115`), so TanStack Query issues one request, not two.
5. The dashboard query is intentionally disabled until that request yields `event.id` (`web/src/pages/Dashboard.tsx:117-124`), creating one sequential API RTT: `/api/events` → `/api/events/{id}/dashboard`. The page header renders before dashboard data, and the body uses a structural skeleton (`web/src/pages/Dashboard.tsx:149-197`, `web/src/pages/Dashboard.tsx:481-503`). The likely dashboard LCP is the “Dashboard” `h1` at line 157; data cards and table rows stream in afterward.
6. The page's explicit five-second polling remains live (`web/src/pages/Dashboard.tsx:38-39`, `web/src/pages/Dashboard.tsx:121-124`); the new reference-data cache defaults do not weaken it.

## Ranked findings

### 1. Catch-all manual chunks made lazy dependencies startup dependencies — implemented

- **Evidence:** Baseline `dist/index.html` module-preloaded 454.18 kB `vendor`, 132.27 kB `ui`, and 25.18 kB `dates` chunks. `react-markdown`, rehype/remark, dnd-kit, and all route Radix usage were forced into these broad chunks. The final policy reserves only stable framework/auth/query chunks and explicit deferred Markdown/dnd chunks (`web/vite.config.ts:49-77`).
- **User-visible impact:** 375.02 kB gzip of JavaScript had to download/parse before either landing or shell. Capability-disabled and non-Agenda users paid for chat parsing and drag-and-drop code.
- **Fix:** Let Rollup place other dependencies with their dynamic consumers; keep named `markdown` and `dnd` chunks for auditability.
- **Risk:** Low. Module boundaries only; behavior is covered by the full test suite.
- **Expected/observed gain:** 194.64 kB less compressed critical JS (-51.9%), plus less main-thread parse/compile work.

### 2. Route loading topology was inverted — implemented

- **Evidence:** The baseline eagerly imported Comms, Dashboard, DevLogin, FormEditor, Forms, Onboarding, Portal, PublicForm, SubmitterDashboard, SpeakerSignin, PublicSchedule, PublicSpeakers, and Review, while Home was lazy. Final lazy declarations are centralized at `web/src/App.tsx:41-92`; Home stays eager at lines 124-125. Structural fallbacks are at lines 94-121.
- **User-visible impact:** Cold users parsed routes they did not visit, while landing users saw an avoidable blank/text fallback round trip. Route transitions could flash a single “Loading…” line.
- **Fix:** Lazy-load every non-critical page, preserve eager landing/shell, show a geometry-stable skeleton, and warm organizer chunks on pointer intent or keyboard focus (`web/src/shell/AppShell.tsx:440-444`, `web/src/lib/routeLoaders.ts:1-41`).
- **Risk:** Low. Route names, native controls, test IDs, and component DOM are unchanged.
- **Expected/observed gain:** Entry raw size -82.95 kB; cold non-visited pages disappear from startup. Intent-prefetched routes usually resolve without showing the fallback on desktop/keyboard navigation.

### 3. Agent capability gating did not gate code delivery — implemented

- **Evidence:** Baseline `AppShell` statically imported `AgentFeature`, pulling `ChatSheet` → `MessageList` → `react-markdown`/rehype/remark into the startup graph. The shell now dynamically imports the mount at `web/src/shell/AppShell.tsx:57-59`, asks capabilities independently at lines 283-290, warms only after opt-in at lines 300-315, and mounts only while open at lines 595-611. The wrapper boundary is `web/src/agent/index.tsx:1-27`; no agent internals were changed.
- **User-visible impact:** Every organizer paid the chat parser cost even when the backend reported `assistant: false`.
- **Fix:** Keep the small native toggle in the shell; lazy-mount the panel on first open and idle-prefetch it only after capability success.
- **Risk:** Low. Existing keyboard shortcut, test ID, native button semantics, open-state persistence, and capability behavior remain; `tests/agentShell.test.tsx` covers enabled and disabled paths.
- **Expected/observed gain:** At least 398.32 kB raw / 121.16 kB gzip of agent + Markdown code removed from cold startup. Disabled deployments never request it.

### 4. Dashboard and event-scoped pages have a genuine ID waterfall — proposed API/bootstrap improvement

- **Evidence:** Dashboard waits for `event.id` (`web/src/pages/Dashboard.tsx:114-124`). Submissions also waits for events, then starts submissions, tracks, and formats together (`web/src/pages/Inbox.tsx:346-371`). Those three dependent calls are parallel and only submissions blocks the main list (`web/src/pages/Inbox.tsx:706`, `web/src/pages/Inbox.tsx:938`).
- **User-visible impact:** A cold dashboard or submissions load costs at least two API RTTs after auth. On higher Railway latency, this dominates once JS is cached.
- **Fix now:** Reuse/deduplicate the events key, retain it for five minutes, and keep dependent reads progressive. Blanket shell-mount prefetch was rejected because it would fetch expensive submissions, speakers, agenda, and content data the user may never view.
- **Proposed next fix:** Return the active/default event ID in an authenticated bootstrap response (optionally with capabilities and event summary), or persist a server-validated active event identity. Then dashboard/submissions can start their primary request immediately. Add data prefetch on nav intent after that contract exists.
- **Risk:** Medium/high because it changes the boot/API contract and tenant/session invalidation behavior.
- **Expected gain:** Approximately one API RTT on cold event-scoped routes; chunk intent prefetch already removes most route-code wait on warm navigation.

### 5. Cache defaults caused avoidable remount loading states — implemented conservatively

- **Evidence:** The project already used a good 60-second global `staleTime`, `refetchOnWindowFocus: false`, and one retry. It had the default five-minute garbage collection window and no longer-lived defaults for stable events/taxonomy. Final settings are `web/src/main.tsx:10-31`.
- **User-visible impact:** Back-navigation after ordinary work could evict cache and repeat skeletons; event and taxonomy metadata could refetch even though their mutations already invalidate/update the same keys.
- **Fix:** Keep the existing live semantics, raise `gcTime` to 15 minutes, use five minutes for events and ten for taxonomy/track/format reference data. Dashboard polling, agent threads, and permission queries keep their own behavior.
- **Risk:** Low. Writes already update or invalidate relevant keys; no live chat/permission stale time was lengthened.
- **Expected gain:** Fewer repeat requests and fewer remount skeletons during a normal organizer session. Network gain depends on navigation patterns.

### 6. Filter switches and large search inputs invalidated visible work — implemented locally

- **Evidence:** Directory used the full filter object as its query key and replaced its table with “Loading directory…” for every change. It now defers search input, retains previous query data, and exposes `aria-busy` (`web/src/pages/Directory.tsx:119-130`, `web/src/pages/Directory.tsx:511-524`). Speakers filters every roster row from a controlled input and renders all matches (`web/src/pages/Speakers.tsx:122`, `web/src/pages/Speakers.tsx:155-177`, `web/src/pages/Speakers.tsx:416`).
- **User-visible impact:** Typing could compete with network/query transitions in Directory and O(n) filtering/reconciliation in Speakers; Directory visibly blanked between filter results.
- **Fix:** `useDeferredValue` for both searches and TanStack `keepPreviousData` for Directory. Previous data is retained only for this read-only list switch; it was deliberately not added to Comms recipient selection or Evaluation assignment switches, where temporarily showing old data could authorize the wrong action.
- **Risk:** Low. Input values remain controlled and immediate; result rows may intentionally lag urgent typing by a render.
- **Expected gain:** Input stays responsive under large datasets and Directory no longer flashes empty between query keys.

### 7. Shell-owned dialog inputs re-rendered the full application frame — implemented

- **Evidence:** Five create-event input states previously lived in `AppShell`, so each keystroke re-executed nav, header, outlet, and agent render work. They now live inside `CreateEventDialog` (`web/src/shell/AppShell.tsx:155-260`), while the shell begins at line 264.
- **User-visible impact:** Typing in the event modal could cause wide invalidation, especially with a large current route mounted below `<Outlet>`.
- **Fix:** Localize form state and mutation to the dialog; pass only open state and the successful event upward.
- **Risk:** Low; the native inputs/select and IDs are unchanged, and `tests/appShellEvents.test.tsx` covers the flow.
- **Expected gain:** Five controlled fields now update the modal subtree rather than the whole shell/outlet.

### 8. The biggest DOMs are not virtualized — proposed after production row-count profiling

- **Evidence:** Speakers renders every filtered speaker (`web/src/pages/Speakers.tsx:416`); Directory renders every returned person; Agenda creates one memoized droppable `SlotCell` per room × time slot (`web/src/pages/Agenda.tsx:459-509`, `web/src/pages/Agenda.tsx:578-591`). Inbox is already locally paginated to 25 rows (`web/src/pages/Inbox.tsx:449-452`, `web/src/pages/Inbox.tsx:988`). Agenda already memoizes slot cells and stabilizes its placement callback, so generic `memo()` advice would not address its main DOM cost.
- **User-visible impact:** Very large speaker/directory datasets grow DOM/layout work; large agenda room/day spans grow dnd-kit droppable registration and collision bookkeeping.
- **Proposed fix:** Capture React Profiler/INP traces at representative p95 row/room counts, then virtualize Speakers/Directory with an accessible table strategy. For Agenda, first isolate preview state to the active room and only then consider viewport-aware droppable registration; ordinary list virtualization can break valid offscreen drops.
- **Risk:** Medium for tables (focus/selection semantics), high for Agenda (drag hit-testing and eval harness semantics).
- **Expected gain:** Potentially large at hundreds/thousands of rows, negligible for current small fixtures; no honest number is possible without production cardinality and browser traces.

### 9. Compression was dynamic on every response and one stable asset was cached as immutable — implemented

- **Evidence:** `nginx:alpine` served runtime gzip only. The build now generates `.gz` siblings (`web/package.json:8`, `web/scripts/precompress.mjs:1-36`) and nginx enables `gzip_static` (`web/nginx/default.conf:13-23`). NGINX documents that `gzip_static on` serves matching precompressed `.gz` files; the module requires the corresponding build option. The repository's base is the official `nginx:alpine` image (`web/Dockerfile:25`), and its build now fails closed if that tag ever lacks `--with-http_gzip_static_module` (`web/Dockerfile:29-31`). The standard module—not third-party Brotli—is used. See [NGINX gzip_static documentation](https://nginx.org/en/docs/http/ngx_http_gzip_static_module.html).
- **User-visible impact:** Dynamic compression burns server CPU and adds response work on cold asset misses. `/favicon.svg` was stable-named but matched the one-year immutable image rule.
- **Fix:** Precompress 46 text assets at build time, serve `.gz` variants, retain dynamic gzip fallback, and give `/favicon.svg` a one-hour cache rule (`web/nginx/default.conf:72-76`). Hashed `/assets/*` remain one-year immutable; HTML remains no-store.
- **Risk:** Low. Both source and `.gz` files ship, so unsupported clients still receive originals. Brotli was not added because the base image does not promise the third-party module.
- **Expected gain:** Removes runtime compression work; for example the 334.53 kB Markdown chunk ships as 101.74 kB gzip. Network bytes match gzip-on-the-fly, but TTFB/CPU is more predictable.

### 10. Optimistic UI and skeleton coverage are uneven — mixed, mostly proposed

- **Evidence:** Agenda moves optimistically (`web/src/pages/Agenda.tsx:1401-1438`); Inbox optimistically updates status, content approval, and decisions (`web/src/pages/Inbox.tsx:546-689`). Many other mutations still wait and invalidate. Page-level data skeletons already exist in Dashboard, Inbox, Speakers, Evaluation, Settings, Forms, and FormEditor; before this wave, route chunks used only a one-line loading message.
- **User-visible impact:** Core review/scheduling interactions feel immediate, but some speaker/CRM/config writes still pause until the network returns. Lazy route transitions previously looked blank even when data skeletons were good.
- **Fix now:** Structural route fallback for every lazy page. Preserve current optimistic paths.
- **Proposed next fix:** Add optimistic updates only to idempotent, locally reversible mutations (for example simple CRM stage/status moves) with snapshot rollback. Do not optimistically claim queued email, uploads, or permission-gated work succeeded.
- **Risk:** Low for route skeletons; medium for each additional optimistic mutation.
- **Expected gain:** No blank route flashes now; mutation-specific gains equal one API RTT when a safe optimistic path is added.

## Implemented versus proposed

Implemented in Wave 20:

- Eager Home + eager shell; lazy loading for every non-critical page with structural public/shell fallbacks.
- Hover/focus route chunk warming through shared dynamic-import functions.
- Capability-gated, first-open agent mount with idle warmup only after opt-in.
- Manual chunk topology that keeps Markdown and dnd-kit out of startup.
- 15-minute query retention; longer event/taxonomy reference freshness; no live-query semantic changes.
- `keepPreviousData` for Directory and deferred Directory/Speakers search.
- Create-event form state isolation.
- Shared CopyButton extraction so lazy pages no longer import the Forms page as a utility dependency.
- Conditional React 19 preload for the landing LCP image.
- Build-time gzip + nginx static serving; corrected favicon caching.

Proposed only:

- Authenticated bootstrap/active-event contract to remove the cold event-ID RTT.
- Production RUM (LCP/INP), Railway-preview Lighthouse/trace runs, and p95 dataset profiling.
- Clerk-aware public landing prerender/progressive auth decision. A naive change risks signed-in landing flashes.
- Accessible Speakers/Directory virtualization and Agenda preview-state isolation.
- Additional reversible optimistic mutations.
- SSR/prerender, service worker, and aggressive blanket data prefetching; these remain intentionally out of scope due deployment/invalidations risk.

## Verification

- `npm run typecheck`: passed.
- `npm run build`: passed; 2,482 modules transformed; 46 gzip assets emitted.
- `npm test`: passed; **57 files, 620 tests**.
- Expected jsdom navigation warnings in two content-export tests remain non-failing and pre-existing.
