# Development startup diagnostic — implementation handoff

Date: 2026-09-09. Scope: diagnosis only; no production fix applied.

**A. Root cause and blocking mechanism**

The reproduced multi-minute delay is primarily Vite/Chokidar recursively registering
Windows file watchers for generated Python environments, package caches and local tools.
It is not a requirement to start Wrangler, restore a Durable Object or load an AI model.

The installed Vite 7.3.6 implementation calls `chokidar.watch([root, ...])` in
`node_modules/vite/dist/node/chunks/config.js`. Its default exclusions cover `.git`,
`node_modules`, `test-results`, its cache and the resolved build output. They do **not**
consume this project's `.gitignore`. Actual `fs.watch` calls and `getWatched()` snapshots
confirmed traversal of directories explicitly listed in `.gitignore`.

The listener can print ready while this asynchronous crawl continues. Registration itself
uses synchronous `fs.watch` calls. Thousands of these calls occupy the Node event loop;
individual calls to Python DLL/PYD files took 0.5–1.3 seconds. In run `cold-3`, cumulative
time **inside `fs.watch`** included 106.132 s for `.tools/uv-cache`, 18.057 s for
`.tools/uv-python`, 12.520 s for `ai/.venv`, and 1.879 s for `ai/.venv-test`.
These are measured registration costs, not file-size estimates or CSS compiler CPU times.

One concrete request timeline (`cold-3`, seconds after launching the actual npm command):

| Event                                                  |            Time |
| ------------------------------------------------------ | --------------: |
| Vite reports ready                                     |           1.536 |
| `/src/styles.css` issued / received by Vite middleware |   1.515 / 1.562 |
| Tailwind transform starts / ends                       |   2.209 / 7.381 |
| `vite:css` transform starts / ends                     | 7.382 / 150.213 |
| CSS response headers                                   |         150.222 |
| React home page visible                                |         151.460 |

The 142.831 s `vite:css` hook elapsed time is downstream waiting under watcher contention;
it must not be interpreted as 143 seconds of active CSS compilation. The same hook took
1 ms in the first exclusion experiment. Tailwind candidate scanning itself took 24.82 ms
in `cold-2` and 21.13 ms in frontend-only mode. Its dependency registration can add initial
work, but the automatic Vite root watcher is the demonstrated large-directory problem.

The longest recorded one-second timer delays were 82.719, 70.760 and 52.448 s in the three
baseline runs. A separate `/` request issued during `cold-1` timed out at 5 s; Vite's
HTTP request event was not emitted until 18.737 s after issuance. Thus both reported
symptoms are explained: requests already inside the pipeline finish late, and new
requests can fail to reach the JavaScript HTTP handler promptly.

During the first stall, about 5 GiB RAM remained available. Vite accumulated native/system
CPU time and event-loop stalls while Wrangler/workerd were mostly idle. Defender activity
was observable, but its causal share was not isolated. No antivirus setting was changed.

**B. Three real process-cold starts and controlled before/after**

All three starts ran `npm.cmd run dev:all` in the actual workspace with existing Vite cache,
Wrangler persistence, tools, models, virtual environments and media retained. AI :8765
was off. Each process tree was stopped before the next launch. “Cold” here means a new
process, not a reboot or a forced OS-cache flush. Times below are seconds from npm launch;
HTTP columns use response-header arrival as the TTFB/readiness observation.

| Run    | Vite ready (CLI's own duration) | Wrangler ready |   `/` | `main.tsx` | `styles.css` | React visible | Observed registrations |
| ------ | ------------------------------: | -------------: | ----: | ---------: | -----------: | ------------: | ---------------------: |
| cold-1 |                   0.821 (0.368) |          2.516 | 0.991 |      3.356 |      136.335 |       136.726 |            not counted |
| cold-2 |                   0.870 (0.381) |          2.350 | 0.991 |      7.635 |      173.627 |       173.881 |                 25,619 |
| cold-3 |                   1.536 (0.991) |          2.893 | 1.809 |      7.475 |      150.222 |       151.460 |                 28,948 |

Wrangler/Vite child spawn times respectively were 0.401/0.412, 0.439/0.448 and
0.462/0.472 s. TCP 5173/8787 became connectable at 0.875/1.574, 0.892/1.609 and
1.507/2.109 s. Initial `/` requests were issued at 0.876, 0.893 and 1.508 s;
their durations were 115, 98 and 301 ms. Main request durations were 2.477, 6.739 and
5.961 s; CSS request durations were 135.456, 172.731 and 148.707 s.

Baseline 1 used process/request/timer instrumentation. Baseline 2 added watcher counters
and Tailwind debug timings. Baseline 3 additionally wrapped plugin hooks and sampled
`getWatched()`. Its temporary config instrumentation caused a normal optimizer rebuild;
the existing optimizer settings were retained. No watcher exclusions were active in any
baseline. Counts are cumulative registration calls observed before shutdown, not a claim
that the entire crawl finished. The last baseline-3 live snapshot contained 27,246 tracked
entries in 2,675 directories.

The controlled experiments changed only the temporary Vite watcher ignore list, with the
same instrumentation and real commands. Nothing was physically removed.

| Experiment                                |   `/` | `main.tsx` |                    CSS |             React visible | Registrations | Maximum sampled timer delay |
| ----------------------------------------- | ----: | ---------: | ---------------------: | ------------------------: | ------------: | --------------------------: |
| Exclude generated directories, dev:all #1 | 1.815 |     12.309 |                 12.259 |                    13.269 |           220 |                     6.236 s |
| Same exclusions except allow `.tools`     | 0.867 |      2.937 | >45 s request deadline | >45 s navigation deadline |        ≥1,732 |                    ≥5.432 s |
| Same exclusions except allow virtualenvs  | 0.929 |      7.382 | >45 s request deadline | >45 s navigation deadline |        ≥3,799 |                   ≥24.853 s |
| Exclude generated directories, dev:all #2 | 0.808 |      2.858 |                  3.454 |                     3.641 |           220 |                     1.364 s |

The excluded configuration's live snapshot had 220 entries in 56 directories; legitimate
source trees remained present. Reintroducing either `.tools` or virtualenv traversal
independently reintroduced an unusable startup within the bounded experiment. Counts and
timer samples in timed-out runs are lower bounds because the blocked loop cannot flush
its next sample. This supports a causal fix without clearing any cache.

**C. Frontend-only, proxy and AI verdicts**

The real `npm.cmd run dev` reproduced the failure with Wrangler absent: Vite printed
ready in 330 ms (0.679 s from npm launch), `/` returned at 0.746 s, `main.tsx` at 2.525 s,
but CSS and browser navigation exceeded their 90 s deadlines. There were at least 11,449
watch registrations. An earlier bounded frontend attempt also failed to listen within
20 s; the expanded attempt above supplied the useful HTTP comparison.

With watcher exclusions, frontend-only rendered at 26.759 s and passed three reloads.
This slower control is retained rather than hidden: npm/Vite startup consumed 11.751 s
and the React/Babel entry hook took 11.480 s. There were still only 220 registrations,
no measured >500 ms `fs.watch` calls, and the CSS hook took 765 ms. Exclusions remove the
demonstrated multi-minute crawl, but do not prove every OS/plugin-cold start will be <5 s.

Wrangler and `scripts/dev.mjs` are **not necessary** for the stall. Their general resource
overhead was not separately quantified. The proxy matches `/api` only. Actual HTML,
source, CSS and poster requests were handled by Vite; none appeared as frontend-path
requests in the Worker logs. Direct `/api/health` and proxied `/api/health` both returned
200 in exclusion runs; proxied health took 7–11 ms after startup. Frontend-only health
returned the expected connection-refused 500 while the home UI remained usable.

There were no browser requests to :8765 or AI model loads. `App.tsx` eagerly imports room,
Studio and renderer-wrapper modules, but `BrowserDubRenderer.ts` loads ffmpeg/core through
dynamic imports only on render. AI health is inside the explicit Studio action. Eager
route imports increase request count; they are not the established cause and do not need
a refactor in this fix.

**D. Directory-by-directory verdict**

| Directory          | Verdict                            | Evidence                                                                                                                                                                                           |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.tools/uv-cache`  | Major                              | 10,853 registrations; 106.132 s cumulative native watch time in baseline 3.                                                                                                                        |
| `.tools/uv-python` | Major                              | 3,188 registrations; 18.057 s native watch time.                                                                                                                                                   |
| `ai/.venv`         | Major                              | 10,706 registrations; 12.520 s in baseline 3, 27.884 s within the bounded virtualenv-only control.                                                                                                 |
| `.venv-test`       | Material secondary contributor     | Actual path is `ai/.venv-test`, not a root directory. 2,307 registrations/1.879 s in baseline 3; 11.035 s within the virtualenv-only control. Not isolated from the other venv as a sole variable. |
| `ai/.cache`        | Minor in measured state            | 61 registrations, 0.302 s native watch time. Large model bytes were not loaded.                                                                                                                    |
| `.wrangler`        | Minor Vite watcher overhead        | tmp/state approximately 145 registrations, 0.303 s native watch time in baseline 3; not the multi-minute bottleneck.                                                                               |
| `dist`             | Not a contributor in these runs    | Already excluded by resolved Vite output-directory handling; no registrations observed.                                                                                                            |
| `local-test-media` | Minor/negligible measured overhead | About 20 registrations, approximately 9 ms native watch time. Preserve all media.                                                                                                                  |

Other `.tools` children also add avoidable cost: browser binaries and browser Worker test
state each consumed about 2.8 s of native watch registration in baseline 3. Excluding the
whole generated `.tools` tree is supported, rather than maintaining a partial list of
Python cache children. `node_modules` was already excluded. `.gitignore` has **no automatic
effect on the observed Vite watcher traversal**, although other tools may honor it.

**E. SQLite warning and process stability**

The exact `NOSENTRY SQLite alarm handler canceled with requestScheduledAlarm` warning
occurred in `ignore-generated-1`, after direct Worker health returned 200. The application
loaded and all three reloads passed. The same multi-minute stall occurred without
Wrangler at all. Verdict: **incidental to this startup failure**; this is not a blanket
claim about all alarm correctness, which was not audited. Existing persistence was used,
not reset or replaced.

All three unexcluded full-stack runs reached React and then exceeded a 30 s reload limit;
neither server independently exited during those reloads. Both exclusion full-stack runs
passed three reloads each (roughly 0.7–0.8 s apiece). Excluded frontend-only passed three
more. No spontaneous process exit was reproduced.

Process logs record spawn PIDs, child exit code/signal, requests, resource samples and
forwarded output. Full-stack parents exited 0 only after the diagnostic stop request.
The stalled frontend-only trees required the harness's bounded `taskkill` fallback and
exited 1; these were deliberate diagnostic cleanups, not reload-induced crashes.

`scripts/dev.mjs` starts Node children without a shell, shares inherited stdio, has no
browser-reload termination path, and stops the sibling whenever either child exits.
It currently omits child identity and signal from its exit logging. That can obscure a
future failure, but the historical disappearance's actual trigger remains **unproven**.
The tests used a drained pipe, not the user's original interactive terminal session.

**F. Why the existing test passes**

`scripts/check-dev-server.mjs` uses `createServer()` in-process, an isolated temporary
optimizer cache and port 5199, and checks only `/` then `/src/main.tsx`. It prints success
and closes the server without checking CSS completion, rendering the import graph in a
browser, or keeping it alive through reloads while watcher registration continues.
Vite can enqueue imported-module warmups without the entry response awaiting their
completion. The test uses the real root/config; it is not a smaller source-tree fixture.

The concrete counterexample is baseline 1: `/` took 115 ms and `main.tsx` 2.477 s, both
within that test's individual 8 s budgets, yet required CSS took 135.456 s and the app
appeared at 136.726 s. The private optimizer cache checks a different concern. Passing
those two requests cannot validate the long-lived development lifecycle.

**G. Ordered implementation handoff for GPT-5.6 Sol**

1. In `vite.config.ts`, add a deliberate `server.watch.ignored` list for generated local
   artifacts. The exact list exercised successfully in this diagnosis is:

   ```ts
   ignored: [
     '**/.tools/**',
     '**/ai/.venv*/**',
     '**/ai/.cache/**',
     '**/local-test-media/**',
     '**/.wrangler/**',
     '**/.worker-build/**',
     '**/.ruff_cache/**',
     '**/ai/.tmp-pytest*/**',
     '**/__pycache__/**',
     '**/.pytest_cache/**',
   ]
   ```

   Keep Vite's existing `dist`/`node_modules` defaults. If a root `.venv-test` is introduced,
   explicitly cover it too; the measured test environment is under `ai/`. Do not ship
   the diagnostic environment variables/plugin. Do not disable watching globally.

2. Preserve watching/HMR for `src/**`, `shared/**`, `worker/**`, `ai/src/**`, public assets
   and relevant config files. Verify both that generated descendants are absent from
   subscriptions and that a normal frontend source change still updates the page.
   `worker/**` must remain available to Wrangler's own reload mechanism as well.

3. Preserve the current `optimizeDeps.include` list, `noDiscovery: true`,
   `holdUntilCrawlEnd: false`, and `exclude: ['@ffmpeg/ffmpeg']`. Do not clear caches,
   upgrade dependencies or alter the renderer's relative Worker URL behavior.

4. Improve `scripts/check-dev-server.mjs` / `package.json` with an actual-lifecycle check
   as described below. Retain the isolated optimizer check as a separate narrow test if
   useful; do not continue labeling it sufficient proof of normal startup.

5. A small, separately reviewable `scripts/dev.mjs` observability change may label each
   child's name/PID, exit code/signal and whether shutdown was intentional. Preserve
   sibling cleanup and validate owned-process cleanup on Windows. There is no evidence
   supporting a larger orchestration rewrite or a claimed reload-crash repair.

**H. Regression design and things not to change**

- Run the real `npm.cmd run dev:all` lifecycle from this workspace with normal caches and
  local generated directories present, at least three independent starts. Fail clearly
  if ports are already owned; never stop an unrelated process or delete its cache.
- Capture npm/child spawn, ready output, TCP, bounded HTTP response times and child exits.
  Use a separately running probe so a blocked Vite event loop cannot postpone the test's
  own deadline. Keep stdout/stderr drained, including during failure and cleanup.
- In fresh Chromium contexts, require the actual home controls to become visible, all
  required CSS to finish, no frontend request/page errors, successful Worker health and
  the intended proxied API call. Follow with at least three reloads while checking that
  both children remain alive. Explicitly verify the AI companion is unnecessary.
- Use an app-ready budget capable of rejecting 90–174 s stalls (initially 30 s with
  separate diagnostic timings), and track the normal few-second baseline. Do not hide
  readiness behind retries that discard the initial timeout. Include a delayed request
  after initial success to catch continued watcher starvation.
- Add a structural check that representative `.tools/uv-cache`, `.tools/uv-python`,
  `ai/.venv`, `ai/.venv-test` and other excluded descendants cannot be watched. A clean CI
  checkout with none of these directories is not a reproduction of the user's workspace;
  use safe generated fixtures to verify exclusion and keep the real-workspace lifecycle
  check. Do not install Python models just to run a JavaScript regression.
- Preserve Phase 11B1.3 speaker identity, models/environments/data, local media, Worker
  authority/persistence, API/WebSocket proxy, ffmpeg behavior and the optimizer fix.
  No Phase 11B2, UI work or unrelated full regression suite belongs to this checkpoint.

**I. Limits, artifacts and final workspace state**

The exact share of Defender, filesystem cache and other system load in native watch
latency was not isolated. The residual 26.759 s excluded frontend-only run demonstrates
plugin/startup variability still exists. No kernel-level profiler was installed and no
guarantee of universal sub-five-second startup is made. The historical terminal/server
disappearance remains unproven; nine successful controlled reloads do not prove every
interactive-terminal circumstance. No need to investigate unrelated AI/media quality.

Raw evidence and reusable temporary probes are local under
`test-results/startup-diagnostic/`; `metrics.json` summarizes ten attempts, including the
bounded frontend startup failure rather than omitting it. Per-run `timeline.jsonl`,
`process-*.jsonl` and (where enabled) `vite-stages.jsonl` contain the timestamps and
directory counts. `cold-3/windows-resources.json` retains a Windows resource snapshot.
The baseline-summary text is supplementary; use `metrics.json` for structured data.

`vite.config.ts` was restored byte-for-byte to its pre-diagnostic contents, SHA-256
`DA656C3129A63120CAD53F5643C947485075ED0F25E3A330D5A2AB23D3336BD3`.
No production implementation, cache/model/media deletion, dependency upgrade or broad
test suite was performed. Probe-owned servers were stopped. Documentation/Memory Bank
record this diagnosis; the watcher fix is intentionally left for Sol.

DIAGNOSTIC COMPLETE — READY FOR IMPLEMENTATION
