# AquaFeed Pro — consolidated delivery plan

Consolidated October 2, 2026; ART-38 integration evidence updated October 4. The October 2 Linear/Notion reconciliation recorded 51 preserved issue IDs: six Done foundation issues, nine Backlog delivery issues and 36 Canceled source issues consolidated into those deliveries. Those counts and relations are historical snapshots; current tracker access is unavailable to the October 4 run. No issue was deleted or falsely marked implemented. D1–D6, H1–H2 and R1 label the surviving existing Linear issues below.

## Preserve completed work

ART-5 (requirements baseline), ART-6 (old v1 contract), ART-8 (toolchain), ART-10 (repository/CI), ART-11 (navigation) and ART-12 (shared components) have integrated Git evidence. Preserve them as history; do not restart setup or reopen ART-6 for the new requirement. The baseline is main `92f97e0d31655bd966405eec49305594ed5f9b20`, through PR #6. Live Linear confirms all six are Done; their completion history was preserved.

The remaining 45 original tickets are covered by nine delivery bundles. This reduces separate dispatch/review/integration cycles; it does not claim all work disappeared. Each bundle completes a flow through its required layers. Tests, error states, documentation and review corrections belong to that bundle.

## Delivery order and surviving issues

The source column assigns each original outstanding ticket one primary bookkeeping home. Cross-cutting acceptance is allocated below; an old layer ticket is never used as a second work queue or marked Done just because one slice shipped. The surviving issues were updated after checking live contents, ownership and state. Recheck current ownership before dispatch.

| Delivery | Linear issue | Original tickets covered | Real prerequisites |
| --- | --- | --- | --- |
| D1 — Two-nozzle contract and secure data foundation | ART-7 | ART-7, ART-9, ART-14, ART-15 | Integrated baseline and owner-confirmed requirements |
| D2 — Pair, select and manage devices end to end | ART-38 | ART-16, ART-17, ART-26, ART-38, ART-39, ART-40, ART-41 | D1 |
| D3 — Manual nozzle feeding with auditable results | ART-31 | ART-18, ART-19, ART-21, ART-23, ART-31, ART-32, ART-36, ART-37 | D2 |
| D4 — Independent nozzle schedules end to end | ART-33 | ART-24, ART-33, ART-34, ART-35 | D3 shared durable execution path |
| D5 — Complete live monitoring and Home | ART-27 | ART-20, ART-22, ART-27, ART-28, ART-29, ART-30, ART-43 | D4, including applied schedules for the next-feed card |
| D6 — Android preview and reproducible hardware handoff | ART-45 | ART-13, ART-25, ART-42, ART-44, ART-45 | D2–D5 integrated |
| H1 — Physical inspection and characterization | ART-46 | ART-46, ART-47 | Owner resumes hardware work; approved requirements |
| H2 — Hardware integration and bench acceptance | ART-48 | ART-48, ART-49, ART-50, ART-51 | D6, H1 and explicit hardware authorization |
| R1 — Bounded pilot, operational recovery and release handoff | ART-52 | ART-52, ART-53, ART-54, ART-55 | H2 and owner-approved pilot/release scope |

H1/H2/R1 are deferred. H1 does not artificially depend on completed app screens, but it is not authorized now. iOS work is visibly deferred within build/release acceptance and must not be reported passed or removed from eventual iOS release requirements.

## What each delivery finishes

### D1 — Contract and secure foundation

Implement the two-nozzle revision across versioned schemas, API shapes, fixtures and both existing validators, then implement the matching relational model, migrations, seed/profile records, grants and RLS. Define device/sequence/nozzle identities, separate doses, ordered progress and partial outcomes, idempotency equality, schedule occurrence/admission rules and version negotiation. A legacy client/device must fail explicitly rather than ignore nozzle selection. Preserve hardware unknowns and simulation labels.

Include a compact access matrix and the acceptance checks needed by the changed boundaries in the same PR; ART-9 is folded into feature acceptance rather than a separate documentation phase. Exit evidence: both contract consumers agree, migration/reset works in the intended isolated development environment, invalid references/duplicate identities fail, and two-installation/two-device allow/deny cases pass. No real feeder or cloud production change is implied by this planning revision.

### D2 — Device access flow

Finish installation-session restore/secure storage, provisioning/pairing transactions and fixture, QR/manual pairing UI, permission-denied fallback, authorized device reads, selected-device persistence, device list/details, local labels, membership removal and re-pair recovery together. Show supported capabilities honestly; device setting controls ship with the feature that implements their mutation, not as dummy controls.

Exit evidence: pair and switch between two simulated devices; stale responses cannot cross device scope; expired/consumed challenges and revoked access fail; lost/invalid local session storage fails safely; removing the selected/last device clears its scoped cache without deleting applied feeder schedules. Pairing tests use controlled simulator credentials/fixtures; the persistent execution transport is built in D3. Auth/abuse checks for these endpoints are part of this delivery, not postponed to ART-41.

### D3 — Manual feeding and outcomes

Finish command creation/reservation, device sync/event ingestion needed for execution, durable simulator transport/journal, and the app's Feed now → nozzle choice → individual doses → confirmation → progress/result flow. Build Nozzle 1, Nozzle 2 and Both in the same pass. Both reserves the sequence and runs 1 then 2; each has its own outcome and requested/measured amount. Include history reads, date/source/status filters, totals, cursor pages, run detail and timeout reconciliation so the outcome can actually be audited.

Exit evidence: each single nozzle and Both work against the simulator; duplicate submission/delivery produces one operation; changing either nozzle dose with the same key conflicts; one nozzle never overlaps the other; a failure/uncertain stop halts remaining work; interruption and lost responses cannot create replacement feeds. Confirmed targets survive selection changes; deep links never actuate. History stays honest about null measurements, partial outcomes and filtered counts. Include relevant access, event-ordering and recovery checks here.

### D4 — Schedules

Finish configuration mutation/revision acknowledgment, simulator local scheduling, per-nozzle form/list/edit/toggle/delete, validation, pending/rejected/offline states and next-applied-occurrence query together. A schedule targets one nozzle with its own amount. Two nozzles due together form an admitted 1-then-2 group; nozzle 2 is not lost as busy or expired merely while nozzle 1 completes normally.

Exit evidence: distinct amounts at the same time run sequentially with the phone closed; same-nozzle duplicate due slots fail; unrelated manual/schedule collisions have explicit outcomes; full snapshot application is atomic; rejected edits preserve the prior applied state. Edits cannot bypass occurrence deduplication. Invalid time, DST, reboot/clock jumps and interruption follow the revised contract, with no automatic catch-up or resume. These cases finish with the feature, not in a later standalone collision ticket.

### D5 — Monitoring

Finish telemetry sync and valid/faulty simulator samples, filtered graph/read APIs, selected-device subscriptions, DO graph/current values, shared-container inventory, applied next feeding, recent activity, freshness/offline/partial-failure states and supported monitoring settings. Add only the operations diagnostics these flows need: correlation IDs, versions, contact/pending/ingestion age and simulator identity. Retention deletion remains disabled until policy approval; record that explicitly instead of shipping speculative jobs.

Exit evidence: invalid readings are unavailable, replay cannot freshen old data, graph gaps persist, applied and pending settings remain distinct, and rapid switching never mixes devices. Verify affected Android layout/large text and bounded graph rendering once with realistic simulated data. Retain per-nozzle labels in next feeding/activity without presenting two copies of the shared inventory.

### D6 — Android build and handoff

Reuse existing branding/build-profile work where valid; finish the Android preview build and environment mapping. Package the existing scenario commands/evidence from D2–D5, contract/version pins, simulator setup, provisioning/recovery instructions and hardware unknowns. Include the two-nozzle interlock, weighing/settling boundaries, partial-failure handling and per-nozzle calibration requirements from `docs/requirements.md`.

Run only the remaining packaging/clean-install checks and a concise integrated physical Android smoke flow, plus unresolved cross-feature cases. Do not rerun every passed scenario or create a separate test project. Verify no secrets/demo outcomes are represented as production data. Record build links and deferred iOS acceptance. Exit: a hardware implementer can reproduce simulated operation from the package without chat history; this does not authorize hardware operation.

### H1, H2 and R1 — Later physical work and release

H1 verifies the authoritative device source and actual components, then characterizes the shared suspended container, each nozzle, sensor quality, safe stop and calibration. H2 integrates the verified hardware adapter with the existing durable agent/contract and performs the offline/time, interruption, sequential dispensing and independent catch-weighing bench checks before signing the capability profile. Preserve real calibration knobs; never infer accuracy from simulation.

R1 performs the agreed bounded pilot, production provisioning/backup/credential and lost-phone recovery checks, then prepares signed release builds and operational handoff. Restore must not replay old physical actions. Public distribution requires the owner's release authorization. iOS build/testing resumes only when authorized and available; an Android result is not iOS acceptance. The initial Linear import is already historical work, so ART-55 contributes only remaining release/handoff bookkeeping.

## Allocate cross-cutting work once

- ART-18: command mutation in D3; configuration/schedule mutation in D4. ART-19: execution sync/events in D3, configuration acknowledgment in D4, telemetry in D5. Define shared shapes in D1; implement each behavior with its first consuming flow.
- ART-20: authorized device reads in D2; history/counts and command timeout reconciliation in D3; next applied occurrence in D4; graphs/freshness/monitoring subscriptions in D5. No feature waits for an unused query or receives a placeholder endpoint.
- ART-26/39: device selection/access lifecycle in D2; each later flow binds its own subscriptions and supported settings. Reuse the established selection boundary instead of reopening the access delivery.
- ART-9/25/30/35/41/42: checks and evidence belong to the feature that introduces the risk. Maintain one shared scenario entrypoint as needed; D6 packages existing results and closes actual integration gaps only.
- ART-43: necessary diagnostics in D3–D5; retention policy/disposition and handoff in D6; production recovery in R1. No automatic destructive retention job.
- All other source-ticket acceptance transfers to its table delivery. Preserve source links and unresolved criteria during reconciliation; reducing ticket count is not permission to drop requirements.

## Remote reconciliation record — October 2, 2026

- Updated the nine existing surviving issues with combined scope, retained acceptance, source links, exclusions and proportionate verification. Marked the other 36 source issues Canceled with consolidation notices and links; preserved their original descriptions and history.
- Replaced obsolete incoming blockers with native relations: D1 depends on completed ART-6/8/12; D2 → D1; D3 → D2; D4 → D3; D5 → D4; D6 → D5 (transitively D2–D4); H1 depends on completed ART-5 plus future owner authorization; H2 → D6 and H1; R1 → H2. Arrows here mean “depends on.” Verified the nine live dependency sets and the 6 Done / 9 Backlog / 36 Canceled counts.
- Kept D1 in Backlog until actual environment/access/ownership are ready. Hardware, pilot/release and iOS remain deferred. No worker was launched by consolidation.
- Updated the Linear project description and labeled the ten original milestones as historical groupings, not additional phase gates. Existing team states were preserved.
- Updated and re-fetched Notion master, mobile architecture, backend model, protocol, backlog, hardware handoff and design pages. The old phase specifications and v1 examples are explicitly historical; the new two-nozzle contract remains to be implemented in D1.
- `linear-import.json` preserves the original import payload for provenance and records this reconciliation separately. Do not replay its historical statuses or dependencies.

## Current stop point

D1 / ART-7 is integrated through `34f40da8daf34b07d3acdd703d9ff00549002aae`; ART-8 is complete. D2 / ART-38 implementation is reviewed and integrated through [PR #8](https://github.com/kin2001/AquaFeedPro/pull/8): source `d5c7e9eca8582a497e71de4ae89f055bdd72fb19`, implementation merge `8886832eba71c9182909c2d97b25a9fffc5f4987`. PR CI `37168343986` and main CI `37168456532` passed mobile and contracts; local mobile format/lint/type/provider-boundary checks and Sol's independent provider/full-delivery whitespace checks passed. The completed scope includes the secure session/access foundation, pairing/naming/Device added/Open dashboard flow, selection, compact Graphite Bento devices/chooser, localized errors and guarded removal/re-pair recovery. Unchanged development SQL/API/provisioning evidence is reused without rerunning or redeploying those suites. Historical fixture counts are not asserted as current. See [the current checkpoint](../docs/ART-38-checkpoint.md) for exact evidence and worker settlement.

The owner reported earlier Android success with two named/location devices and a selected device. New layout/naming-success and unrecorded native camera/clear-selection/cold-restart/removal/re-pair checks remain unobserved; new manual checks are explicitly deferred for unattended delivery and are not a phone-review gate. Linear/Notion synchronization is pending. The October 4 follow-up verified `linear@openai-curated` is already installed and enabled in Codex, but this chat and the scheduled chat have no callable Linear tools. No new installation completed. Treat this as an existing Codex access/loading problem; do not reinstall Linear or connect it in Orca. No remote Done state, current assignee or readiness is claimed. Codex must synchronize ART-38 and verify the next issue through its existing connection; Orca remains responsible for workers/worktrees.

The owner authorizes successive genuinely ready app deliveries through D6, and parallel independent workers where live dependencies and disjoint ownership permit. Planned order is D3 ART-31, D4 ART-33, D5 ART-27 and D6 ART-45. This run stops before D3 because its actual live readiness/ownership cannot be established; restore tracker access, synchronize ART-38 evidence and re-read the next issue before dispatch. Integrate each required predecessor first. Stop starting work at <=5% five-hour or <=1% weekly remaining, or a real blocker; preserve scoped WIP and an exact checkpoint. A quota stop requires one same-chat continuation using authoritative reset metadata; completion or a non-quota blocker does not. Hardware H1/H2, release R1, production, emulator and iOS remain deferred.
