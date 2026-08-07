# pi-advisor

An evidence-aware execution advisor for [Pi](https://github.com/earendil-works/pi).

This is a narrow fork of `@monotykamary/pi-supervisor` that keeps its useful
algorithmic conversation compaction and isolated-model session, while changing
the authority model:

- supervision is always loaded and activates from real work signals;
- interactive and RPC input are the only trusted user-input sources;
- `pi-tasks` state and actual tool results back completion decisions;
- task evidence, step closure, and final completion can be blocked before the
  task reducer runs;
- final completion requires a current one-use permit from a settled check;
- messages are agent-attributed Pi custom messages, never user impersonation;
- native Pi remains the compaction owner, with a single continuity reminder
  after compaction;
- the only command is `/advisor`, optionally followed by a natural-language
  question or explicit correction.

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
});
```

Install or pin the repository as a Pi package with its extensions disabled,
then load the policy adapter as a local extension. This keeps private routing,
credentials, and instruction topology out of the public package.

## What it does not do

The Advisor does not perform work, grant user authority, formally accept a
change, create project configuration, discover project prompt files, scan for
child processes, stop or restart sessions, or maintain a second compaction
summary.

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
