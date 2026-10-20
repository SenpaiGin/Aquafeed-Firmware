# AquaFeed Pro — Agent Instructions

Applies to this directory and its descendants. Follow the user's current scope; documentation describing future execution does not by itself start that execution.

## Read first

- [AI_DEVELOPMENT_WORKFLOW.md](AI_DEVELOPMENT_WORKFLOW.md): roles, handoffs, ownership, review and integration.
- [DESIGN.md](DESIGN.md): approved visual and interaction requirements.
- [Notion master plan](https://app.notion.com/p/3ec224a56ef381019c30d3da4e54251e): architecture, backend, device protocol and phased backlog.
- The assigned task and relevant versioned contracts/migrations when those files exist.

Read only relevant sections after initial orientation. Do not assume planned files, commands or integrations are already implemented. Report material conflicts before changing dependent behavior.

## Roles and scope

- Codex GPT-6.1 Sol Max orchestrates, consolidates tasks, reviews, verifies and integrates authorized work. Seek additional architecture review only for a concrete unresolved decision.
- GPT-6 Luna Max implements through Orca. Verify the actual `gpt-6-luna` model and Max effort; give it one self-contained delivery packet and an absolute Orca-managed worktree path.
- Codex accesses Linear through its existing connection and owns issue reads, updates, readiness and blocking relations. Orca owns coding workers and worktree lifecycle; do not connect Linear in Orca or require workers to access it. Follow [planning/DELIVERY_PLAN.md](planning/DELIVERY_PLAN.md), not the old layer-by-layer execution order.
- Check existing installation and callable tools separately. An installed, enabled Linear plugin with missing tools has an access/loading problem; do not reinstall it, suggest installation again, or add a duplicate MCP server. Inspect the existing Codex connection and record pending synchronization until a live issue call succeeds.
- Apply the installed `ponytail:ponytail` skill at full intensity to implementation and review. Read its SKILL.md; reuse existing/platform solutions and avoid speculative abstractions or dependencies. Pass this instruction to every worker.
- Do not silently replace unavailable GPT-6 Luna execution with another model or lower reasoning effort; report the blocker and use only a user-approved fallback.
- Start with one implementation worker; two parallel workers require a passed pilot and explicit area/resource ownership.
- Reading this file is not an instruction to spawn agents. Dispatch only for the current authorized implementation task.
- Stay within the assigned task. No unrelated features, scaffolding, dependencies or refactors.

## Source of truth

Notion owns planning rationale; DESIGN.md owns visual requirements; repository contracts and migrations own the implemented technical baseline; Linear owns execution state once configured; GitHub records actual code and checks. A model's report does not replace evidence.

Preserve the existing four-page design and the selected React Native/Expo/TypeScript/Expo Router/Supabase architecture unless the task authorizes a change. Verify SDK/package compatibility before installation.

## Before editing code

Confirm repository root, worktree, branch, base commit, task scope and current changes. Read the affected flow and its callers. Reuse existing patterns and prefer the smallest complete root-cause change.

Each active coding task has one branch/worktree and one writer. Do not overwrite user changes or modify another worker's directory. Dependency changes are allowed only when included in the assignment.

Worktrees do not isolate databases, cloud services, ports or hardware. Serialize shared schema/contract/lockfile changes unless separate ownership has been established. Never let two workers control the physical feeder concurrently.

## Contract and device rules

- App, backend, simulator and firmware must use the same versioned protocol and fixtures.
- Validate network input at runtime; TypeScript alone is insufficient.
- Check active device access for every protected operation. Never ship project secrets/service-role keys to phones or feeders.
- Each feeder has two nozzles sharing one continuously weighed container. Never dispense in parallel; when both are selected or due together, nozzle 1 precedes nozzle 2.
- Manual feeding offers Nozzle 1, Nozzle 2, or Both, with a separate amount per selected nozzle and explicit confirmation bound to that device and those doses. Schedules target one nozzle each; same-time cross-nozzle schedules run sequentially.
- Protocol v1 lacks nozzle targeting. Update the versioned contract before enabling these controls; never assume an ignored optional field provides safe nozzle selection.
- Persist and deduplicate command/occurrence identities; do not automatically repeat an uncertain or expired feed.
- Keep requested configuration separate from device-applied configuration.
- Unknown, stale or invalid readings are not zero or healthy readings.
- Requested/estimated feed amount is not measured dispensing.
- A database/API success is not physical feeding completion.
- Simulator success is not hardware calibration, accuracy or safety evidence.
- Do not operate GPIO, replace calibration or edit a remote feeder unless the current task authorizes it.
- Verify actual hardware/runtime before using historical tracker claims. Preserve per-device calibration and safety limits.

## Checks and reporting

Run checks appropriate to the changed behavior and the task's acceptance criteria. Non-trivial behavior needs a meaningful executable check. Avoid redundant full builds; documentation-only work needs a consistency review, not app tests.

Complete one user-visible flow with its needed backend, simulator, UI, error states and focused checks in one delivery. Keep review/corrections in that delivery instead of closing it and creating a separate integration/testing task. Reuse passing evidence for the unchanged commit; rerun only affected checks after changes. Preserve authorization, duplicate-feed prevention, sequential execution, recovery and measurement checks. Physical Android only; no emulator, and iOS is deferred until the owner resumes it.

Report the result commit/diff, changed files, behavior, checks actually run, checks not run and remaining uncertainty. Never claim a check, deployment or physical result that was not observed.

Workers submit for review; they do not self-approve or mark Done. Codex inspects the diff and independently verifies critical criteria. After two unsuccessful correction cycles, reassess or escalate instead of repeating the same instructions.

Do not begin dependent tasks merely because a worker says finished. Confirm required predecessor integration and applicable gates. Done requires reviewed integration and task-specific evidence; deployment and hardware acceptance remain separate when out of scope.

## Secrets and integration

Keep tokens, pairing secrets and private credentials out of code, prompts, logs, Notion and Linear. Use sanitized fixtures and isolated development resources.

Do not infer merge, public release, destructive migration or hardware-actuation authority from this file. Use the user's existing authorization without repeatedly asking for the same permission.

Preserve unmerged work and evidence. Archive worktrees only after their worker has stopped and required changes are safely retained.
