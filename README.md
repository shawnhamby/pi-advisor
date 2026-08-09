# pi-advisor

An evidence-aware execution advisor for [Pi](https://github.com/earendil-works/pi).

This is a narrow fork of `@monotykamary/pi-supervisor` that keeps its useful
algorithmic conversation compaction and isolated-model session, while changing
the authority model:

- supervision is always loaded and activates from real work signals;
- interactive and RPC input are the only trusted user-input sources;
- `pi-tasks` state and actual tool results back completion decisions;
- agent-requested task completion is checked before `TaskUpdate` can mark it complete;
- an unsupported completion attempt returns one corrective tool error without terminating or pausing the agent;
- direct user completion through `/tasks` remains user-authoritative and is reconciled after the transition;
- messages are agent-attributed Pi custom messages, never user impersonation;
- an OMP-derived deterministic watch lane observes bounded text, thinking,
  tool, result, task, and lifecycle streams without calling a model;
- host-supplied regex and AST rules can remind at a safe boundary or schedule
  one semantic check, but cannot block tools or grant authority;
- native Pi remains the compaction owner, with a single continuity reminder
  after compaction;
- the only command is `/advisor`, optionally followed by a natural-language
  question or explicit correction.

When the user submits input during an automatic settled check, Advisor cancels
the stale check and hands that input back to Pi's normal steering lane exactly
once. Advisor model-routing failures are reported once per unchanged failure
instead of repeating after every settled turn.

## Host integration

The package deliberately has no automatic Pi entrypoint. A host policy adapter
must supply a different-family model binding from its own canonical routing
system:

```ts
import { createAdvisorExtension } from '@shawnhamby/pi-advisor';

export default createAdvisorExtension({
  async resolveModel(ctx) {
    return {
      selector: 'fast-advisor:medium',
      provider: 'provider-id',
      modelId: 'model-id',
      effort: 'medium',
      family: 'different-family',
    };
  },
  watchContract,
  matchAst: workspaceAstMatcher,
  resolveToolSnapshots: workspaceSnapshotResolver,
});
```

Install or pin the repository as a Pi package with its extensions disabled,
then load the policy adapter as a local extension. This keeps private routing,
credentials, and instruction topology out of the public package.

## What it does not do

The Advisor does not perform work, grant user authority, formally accept a
change, create project configuration, discover project prompt files, scan for
child processes, stop or restart sessions, block execution tools, mutate task
state, or maintain a second compaction summary. Its only gate is an agent's
`TaskUpdate status=completed` request; rejection keeps the task active and the
agent running. Shared hooks retain security and authorization enforcement. The
public package ships no policy rule pack and does not discover
repository-controlled rules. A host must admit its own watch contract.

## Development

```bash
pnpm install --ignore-scripts
pnpm typecheck
```

## Attribution

The isolated model session and algorithmic conversation-compaction pipeline are
derived from `monotykamary/pi-supervisor`, itself derived from earlier
`pi-supervisor` work. The fork retains the MIT license and substantially narrows
runtime authority, lifecycle, and completion behavior.

The deterministic watch engine is adapted from Oh My Pi's TTSR architecture at
commit `08819b279cf02ae2545e69dad7111ab48d91d35e`. It retains bounded
source-aware buffers, regex/AST predicates, path/tool scoping, repeat policy,
and persisted violation-signature deduplication while omitting OMP rule
discovery, opinion packs, interrupt/retry ownership, memory, todos, and
model-on-every-turn behavior.
