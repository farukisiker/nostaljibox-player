# WP2 / M1b task ledger

## M2 checkpoint (2026-11-09 07:54)

Current baseline ca44689 includes Fable's follow-up fixes; architect reports green CI and build-95
iPhone XR PAL test passing at 50/50 fps, 71 MB. Frozen build-95 refs must never be modified.
Previous M1b rows below are historical; M1b was completed and device-tested after those rows were written.

| Item | Model | Agent/thread ID | Files | Status | % | ETA local | Resume |
|---|---|---|---|---|---:|---|---|
| 1a Session save states + roundtrip tests | gpt-6.1-sol | /root/sol_m2_states | LibretroHost/gpt-6.1-sol/, Tests/gpt-6.1-sol/ | reviewed; checkpoint/CI pending | 85 | 08:05 | followup_task(target="/root/sol_m2_states", message="...") |
| 1b Plugin state API | gpt-6.1-terra | /root/terra_m2_states | NativePlayerPlugin/gpt-6.1-terra/ | reviewed; checkpoint/CI pending | 85 | 08:05 | followup_task(target="/root/terra_m2_states", message="...") |
| 2 Inactive start, fixture filter, termination SRAM flush | gpt-6.1-sol, gpt-6.1-terra, gpt-6-luna | /root/sol_m2_states, /root/terra_m2_states, /root/luna_m2_filter | corresponding model folders | reviewed, waiting item 1 CI before checkpoint | 80 | 08:05 | followup_task on respective agent |
| 3 Fable review | lead + gpt-6-sol | /root, /root/sol6_ring_review | TASKS.md | audio ring concurrency concern under confirmation | 70 | 08:10 | root |
| 4 Route-loss manual resume | gpt-6.1-sol | pending | LibretroHost/gpt-6.1-sol/ | optional after 1–3 | 0 | 08:25 | pending |

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
