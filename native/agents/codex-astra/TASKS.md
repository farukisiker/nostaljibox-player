# WP2 / M1b task ledger

## M2 checkpoint (2026-11-09 07:54)

Current baseline ca44689 includes Fable's follow-up fixes; architect reports green CI and build-95
iPhone XR PAL test passing at 50/50 fps, 71 MB. Frozen build-95 refs must never be modified.
Previous M1b rows below are historical; M1b was completed and device-tested after those rows were written.

| Item | Model | Agent/thread ID | Files | Status | % | ETA local | Resume |
|---|---|---|---|---|---:|---|---|
| 1a Session save states + roundtrip tests | gpt-6.1-sol | /root/sol_m2_states | LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/ | 33d67b1, CI 42564524304 green | 100 | done | followup_task(target="/root/sol_m2_states", message="...") |
| 1b Plugin state API | gpt-6.1-terra | /root/terra_m2_states | NativePlayerPlugin/gpt-6.1-terra/ | 33d67b1, CI 42564524304 green | 100 | done | followup_task(target="/root/terra_m2_states", message="...") |
| 2 Inactive start, fixture filter, termination SRAM flush | gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna | /root/sol_m2_states, /root/terra_m2_states, /root/luna_m2_filter | corresponding model folders | 6c4dcdf, CI 42564868518 green | 100 | done | followup_task on respective agent |
| 3 Fable review | lead + gpt-6-sol | /root, /root/sol6_ring_review | TASKS.md | confirmed ring race; replacement requested | 100 | done | root |
| 3a Correct confirmed overflow race | gpt-6-sol | /root/sol6_ring_review | LibretroC/gpt-6-sol/ | stress passed; waiting root-source exclusion | 85 | 08:15 | followup_task(target="/root/sol6_ring_review", message="...") |
| 4 Route-loss manual resume | gpt-6.1-sol | /root/sol_m2_states | LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/ | reviewed, waiting final checkpoint/CI | 85 | 08:15 | followup_task(target="/root/sol_m2_states", message="...") |

Initial review concern for item 3: Fable's drop-oldest ring now permits producer writes to non-atomic
sample storage concurrently with consumer reads. CAS/fetch_add on readIndex does not protect payload
access; overlapping drop/read can also advance readIndex beyond writeIndex. This is a real concurrency
issue to validate and route after the save-state/queued-fix checkpoints; no frozen-build changes.

Review agreement: retain sample-rate-sized audio capacity, core logging, main-thread drawable sizing,
locked renderer size publication, audio reactivation/reconnection, larger core stack, ordered started
events, non-reparenting WebView integration and additive measured/target fps instrumentation. These
changes address the reported device findings without widening M2's render-path scope. Preserve the
successful device-tested baseline. Item 1 checkpoint: 33d67b1, CI 42564524304 in progress.

Lead: codex-astra (gpt-6-astra). Implementation is delegated; existing lead code stays in place.
Baseline: b372869, CI 42529815236 passed, including the real Supafaust 600-frame/replay test.
CLI model probes failed before model startup (home unavailable). Built-in probes returned READY for
gpt-6.1-sol, gpt-6.1-terra, gpt-6-sol and gpt-6-luna. gpt-5.6-sol is not exposed by the built-in runner.
At most two implementation agents run concurrently. Commit/push uses wp2.commit / wp2.pushed helper.

| Task | Sub-agent model | Agent/thread ID | Files | Status | % | ETA local | Resume |
|---|---|---|---|---|---:|---|---|
| Session, frame clock, pause/lifecycle tests | gpt-6.1-sol | /root/sol_session | LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/ | review complete, awaiting CI | 80 | 03:15 | followup_task(target="/root/sol_session", message="...") |
| Plugin, view sandwich, input/saves integration + manifest | gpt-6.1-terra | /root/terra_plugin | NativePlayerPlugin/gpt-6.1-terra/, LibretroHost/gpt-6.1-terra/ | reviewed, awaiting link-layer selection and CI | 80 | 03:15 | followup_task(target="/root/terra_plugin", message="...") |
| Additional core smoke tests | gpt-6-luna | /root/luna_core_tests | Tests/gpt-6-luna/ | reviewed, awaiting CI/core artifacts | 80 | 03:15 | followup_task(target="/root/luna_core_tests", message="...") |
| Review audio/video, integration CI fixes | original authors via sub-agents | pending | model-owned additions only | queued | 0 | 03:40 | pending |

## Integration contract

Session API will be agreed between SOL and Terra before implementation. All emulator calls are
serialized on the session's core Thread/RunLoop; UIKit and plugin results/events use the main queue.
NativeZip belongs to Gemini. Plugin conditionally imports NativeZip, NativeInput and NativeSaves.
No agent edits Package.swift, workflows, or another model's folder. Existing source needing replacement
is reported to lead first so duplicate Swift declarations are not introduced.

## N0 native two-phone play (2026-11-09 12:59)
M2 is shipped in TestFlight 98 per architect; prior pending M2 rows are historical.
Baseline f646b22 includes reviewed Fable JS. Build-95 refs remain frozen.
| Package | Model | Agent | Files | Status | % | ETA | Resume |
|---|---|---|---|---|---:|---|---|
| N0-b C ports | gpt-6-sol | /root/sol6_n0_bridge | LibretroC/gpt-6-sol/ | implementing | 20 | 13:10 | followup_task same agent |
| N0-b session | gpt-6.1-sol | /root/sol_n0 | LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/ | implementing | 20 | 13:10 | followup_task same agent |
| N0-c driver | gpt-6.1-sol | /root/sol_n0 | same folders | next | 0 | 13:35 | followup_task same agent |
| N0-d plugin | gpt-6.1-terra | pending | NativePlayerPlugin/gpt-6.1-terra/ | queued after b | 0 | 13:35 | pending |
| N0-h determinism | gpt-6-luna | pending | Tests/gpt-6-luna/ | queued | 0 | 13:50 | pending |
| N1-a / route review | gpt-6.1-sol | pending | model folders | after N0 | 0 | TBD | pending |

N0-b reviewed 13:02: two-slot bridge GCC warning-clean harness passed; session diff checked, Swift regression awaiting CI. Requesting checkpoint; source exclusion automatic in Package.swift.
N0-b checkpoint 0bfdc82 at 13:02; CI https://github.com/farukisiker/nostaljibox-player/actions/runs/42597830345 running. Lead independently compiled/reran GCC two-port harness, exit0.
N0-c /root/sol_n0 implementing validated driver/session API (20%, ETA13:25); N0-d /root/terra_n0_plugin gpt-6.1-terra implementing plugin FIFO bridge (20%, ETA13:20). At most2 active. Resume both via followup_task.
Contract issue sent wp2.requests: JS owns desync count but no API forwards it to native stats. Native reports0 pending architect decision; no undocumented method added.
N0-b CI GREEN42597830345 (3m22s). N0-c lead reviewed driver/session/tests; requesting independent checkpoint. N0-d reviewed complete plugin held outside agent folder at .ai-runs/dev/astra/terra-plugin-n0.swift so helper can snapshot packages separately. N0-h /root/luna_n0_determinism (gpt-6-luna) preparing tests in scratch before authorized copy, 20%, ETA13:25. Resume via followup_task.
N0-c checkpoint0721ba1 CI42598399274 GREEN (GitHub page confirms Success; gh hit public API rate limit). Independent gpt-6-sol review found only previously reported JS/native desync counter gap. N0-d restored reviewed plugin; requesting checkpoint. N0-h scratch tests reviewed with corrections (buffer pointer lifetimes, held input probe, SRAM variant when present); waiting d checkpoint before copy.
N0-c log retrieved via nightly.link artifact13664522590:7driver tests pass,36Codex tests pass,TEST SUCCEEDED. N0-d af17a93 CI42598942075 running. N0-h final review corrections delegated; SNES input sensitivity not assumed from README; CI decides.
N0-d CI42598942075 failed compile only: CAPPluginCall.options is optional. Terra fixed both call sites to default empty dictionary; requesting correction checkpoint. N0-h complete reviewed scratch preserved pending d build.

## N1 follow-up (2026-11-09 17:58)
Baseline690c259. N0 ba705b8 desync and Fable determinism/native guest changes green and shipped TestFlight100 per architect; prior pending N0 rows historical. Supafaust has no SYSTEM_RAM, full-state checksum fallback is required. Two-iPhone device test remains external. Build95 frozen.
| Item | Model | Agent | Files | Status | % | ETA | Resume |
|---|---|---|---|---|---:|---|---|
|1 Slot-load busy guard|gpt-6.1-sol|/root/sol_n0|LibretroHost/gpt-6.1-sol/EmulatorSession.swift|implementing|30|18:02|followup_task|
|2 ba705b8 review|gpt-6-sol|/root/sol6_n0_bridge|read-only|reviewing|30|18:02|followup_task|
|3 Identity headers|gpt-6.1-sol|/root/sol_n0|LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/|queued|0|18:15|followup_task|
|4 Route ordering|gpt-6.1-sol|/root/sol_n0|same model folders|queued|0|18:20|followup_task|
|5 Paused hint|gpt-6.1-terra|pending|js/gpt-6.1-terra/ + owner hook requested|queued|0|18:25|pending|
