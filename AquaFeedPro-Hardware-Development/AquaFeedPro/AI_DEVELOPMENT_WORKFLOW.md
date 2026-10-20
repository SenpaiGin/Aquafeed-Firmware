# AquaFeed Pro — AI Development Workflow

Updated October 4, 2026. This is the owner's revised delivery workflow. Setup and completed foundation work must not be restarted. Feature implementation follows the owner's authorized deliveries and the current evidence in the delivery plan.

## Roles and tools

| Owner/tool | Responsibility |
| --- | --- |
| GPT-6.1 Sol Max | Orchestrate, access and update Linear from Codex, select genuinely ready work, prepare a short packet, independently review and integrate authorized results. Handle planning and coordination documentation directly. |
| GPT-6 Luna Max | Perform substantive implementation, including the backend, simulator and app changes needed for the assigned flow. Submit evidence; do not self-approve or merge. |
| Orca | Manage worktrees, exact worker identity, dispatch, correction, settlement and cleanup. Use the installed version-matched orchestration guide. |
| Linear | Track delivery status, acceptance checklists, ownership and real blocking relations. |
| Ponytail full | Required for implementer and reviewer: read the installed `ponytail:ponytail` SKILL.md and apply the simplest complete solution. |
| Project owner | Decide product scope and authorize production release, destructive operations and physical hardware work when needed. |

Verify actual `gpt-6-luna` and Max effort in the owned worker; a prompt asking for Max is insufficient. Do not silently downgrade or change accounts, Codex home or global settings. If Orca's preference validator cannot express Max, use only its documented custom-launch path and verify the actual session before dispatch. Do not substitute a native subagent for Orca provenance. Architecture escalation is for a specific unresolved decision, not a mandatory extra review on every bundle.

## Deliver complete flows

Use [planning/DELIVERY_PLAN.md](planning/DELIVERY_PLAN.md). The original 51-ticket import remains provenance, not the current execution order.

- One delivery is one coherent outcome, one active writer, one Orca-managed worktree/branch, and normally one PR. Include the required contract/API/data changes, simulator behavior, app UI, error states and focused evidence in that delivery.
- Combine work that shares the same flow and files. Do not finish a form-only ticket, move elsewhere, then reopen it to add submission, results or failure handling. Keep findings/corrections in the current delivery until its acceptance passes.
- Implement shared execution and transport where the first consuming flow needs them. Extend them for a genuinely new flow later; do not create speculative universal helpers or repeat completed setup.
- Old cross-cutting tickets are decomposed once into explicitly owned acceptance items in the consolidated plan. They are historical references, not a second queue of work.
- Dependencies describe real prerequisites, not phase numbers. Manual feeding need not wait for the DO graph. A new schedule flow does need the durable shared execution path.
- Work serially by default. Parallel workers require explicit approval and disjoint ownership/resources; saving tokens does not justify overlapping writers.
- If a bundle becomes too broad to review, split at a complete observable outcome before dispatch. Do not split into coding, testing and integration tickets or prewrite detailed packets for all future work.

## Sources and current product revision

The owner's latest decisions take precedence. [DESIGN.md](DESIGN.md) owns visual/interaction requirements; [docs/requirements.md](docs/requirements.md) records behavior and hardware evidence boundaries. Notion holds planning rationale; versioned schemas/migrations define what is actually implemented; GitHub records code and checks; Linear records execution state.

Two nozzles share one continuously weighed container. Nozzle 1 precedes nozzle 2 when both are chosen or due together. Feed now offers one, two or both with separate amounts; each schedule targets one nozzle. Preserve per-nozzle results and a device-wide execution reservation. Protocol v1 does not implement this revision: change the versioned semantics before enabling dependent controls.

When Linear or Notion access is unavailable, preserve a concrete local reconciliation plan and report the unsynced state. Do not fabricate updates, recreate projects, blindly replay the old import, or spend the feature task rebuilding connectors. Recheck live state before applying queued changes. A locally prepared bundle is not automatically Ready in Linear.

## Linear task and dependency handling

Codex owns Linear access; use its existing native connection. Orca manages coding workers and worktrees and does not need a Linear connection. Give workers the coordinator's verified issue scope, dependencies and acceptance in their packet; workers report through Orca and do not update issue status.

Before troubleshooting Linear, distinguish installation, enabled state, callable tool exposure and successful authenticated issue access. Check the existing plugin inventory and tool registry once. If the plugin is installed and enabled, do not reinstall it, suggest installation again, add a duplicate MCP server, or connect Linear in Orca. Missing tools are an access/loading problem, not evidence that the plugin is absent. Inspect the existing Codex connection; an Orca connection error does not establish Codex's connection state. Consider installation only when the plugin is actually absent and installation is requested.

If Codex's issue tools remain unavailable, read an existing chat's handoff when useful, preserve verified GitHub/code evidence and record the exact pending synchronization. Do not repeatedly retry the same failed access or claim remote updates. Prepare independent handoff material while blocked, but obtain live ownership and dependencies before dispatching a dependent delivery. Restore the existing Codex connection rather than restarting setup.

Reuse the proposed surviving existing issues in the delivery plan, after confirming their live content and ownership. Copy every retained acceptance criterion and source link before retiring absorbed issues. Preserve completed work and history; consolidated/superseded does not mean implemented or Done. Redirect external blockers to the surviving delivery, remove obsolete phase-only/internal edges, and check for cycles. Split hardware/iOS-deferred criteria visibly instead of dropping them.

Map to existing team states, without changing workspace-wide configuration:

`Backlog → Ready → In Progress → Review/Testing → Done`

Review/Testing is one delivery gate; use separate existing states only if the actual team workflow needs them. Blocked records a concrete unmet prerequisite and unblocking condition. Ready requires merged prerequisites, access, sufficient acceptance criteria and uncontested ownership. GitHub evidence wins over stale issue status.

Each delivery needs only: outcome; scope/exclusions; true blockers; observable acceptance; owned paths/resources; check commands; and result links. Link shared requirements instead of duplicating long plans. Record the worker/dispatch, worktree, base and result commit on the same issue or its short local checkpoint.

## Orca execution loop

1. Inspect the exact repository, branch/base, uncommitted files and existing worktrees. Use Orca to reuse a suitable task worktree or create one when needed; documentation-only coordination does not require a new worktree.
2. Load the version-matched Orca skill. Reuse the settled, proven Luna Max terminal when suitable and authorized; otherwise launch one worker. A timeout is not proof that no worker started. Inspect before retrying.
3. Send one self-contained packet: delivery outcome, source issue IDs and coordinator-verified live ownership/dependencies, acceptance, absolute worktree/branch/base, owned areas, restrictions, Ponytail full, and the smallest relevant checks. The worker does not need its own Linear connection.
4. Let Luna finish the whole flow. Use event/bounded waits; investigate meaningful silence or failures rather than repeatedly polling unchanged state.
5. Sol reads the actual diff and evidence, checks critical behavior and returns one consolidated correction packet if necessary. Keep corrections on the same delivery. After two unsuccessful correction rounds, reassess the cause/scope rather than repeating the prompt.
6. Accept only the current dispatch's completion. Settle messages and record reuse, user-requested retention or release using Orca's actual lifecycle rules. Preserve unmerged files and evidence before cleanup; never reset the runtime or close unrelated terminals.

Worktrees do not isolate shared databases, credentials, ports or feeders. Serialize migrations, contracts and lockfiles unless ownership genuinely isolates them. One writer per assigned checkout; never operate the physical feeder concurrently.

## Proportionate verification

Choose checks once in the packet and attach them to the feature acceptance:

| Change | Minimum useful evidence |
| --- | --- |
| Requirements/workflow/plan only | Diff/link/coverage/dependency consistency review; no app build or phone retest. |
| UI behavior | Affected lint/types plus one physical Android flow covering the changed interaction. Reuse prior unchanged visual evidence. |
| Contract or parser | Existing validators for both consumers when affected; a small case exposing the changed semantics. |
| Access/data mutations | Targeted allow/deny, isolation, transaction and malformed-input checks at the changed boundary. |
| Feeding/scheduling | Focused simulator evidence for ordering, duplicate prevention, deadlines, interruption/unknown results and changed collisions; per-nozzle measurement attribution when affected. |
| Hardware | Later, explicitly authorized bench evidence for actual calibration, exclusive operation, safe stop and recovery. Simulator output is insufficient. |

The worker runs the agreed checks once on its final candidate. Sol independently inspects evidence and verifies critical gaps or high-risk behavior; it does not automatically repeat the worker's entire suite. Required PR CI still runs. After a correction, repeat only affected checks and required integration checks. After merge, verify required CI; if the tree matches the tested tree, do not repeat unchanged phone tests or full local suites. Broaden testing only for a changed dependency/shared behavior, new failure or unresolved concern.

Keep one meaningful runnable regression check for nontrivial new behavior, using existing mechanisms. Do not add frameworks, coverage targets or per-function test scaffolding by default. Do not remove input validation, access controls, accessibility basics, duplicate-feed prevention, exclusive nozzle execution or data-loss protection for speed. No emulator. iOS is deferred until the owner resumes it; no iOS success claim.

## Review, integration and stopping

The worker report is short: result commit, implemented acceptance, checks/results, and remaining gaps. Sol verifies the actual diff and integrates within the owner's authorization: push/open the delivery PR, verify CI on the exact commit, merge with a head-commit guard, sync local main safely, and verify required post-merge CI. Update Linear with the actual evidence when connected; otherwise record the pending update explicitly.

Done means reviewed integration and the delivery's applicable evidence, not a worker completion message. Deployment, physical readiness and deferred platform acceptance remain distinct. Respect the owner's stop instruction; a finished bundle is not blanket authorization to start the next one or release publicly.
