# MediaRuntime Preflight

Browser file inspection through a reusable Web Worker. The current implementation
detects PNG signatures, inspects IHDR fields, and evaluates upload policies.

## Source layout

```text
src/
  index.ts                  Public exports
  inspect.ts                Browser API and worker creation
  types.ts                  Public options and report contracts
  core/
    reader.ts               Bounded reads, byte budgets, and cancellation
    detect.ts               Detection through registered format modules
    inspect-file.ts         Check coordination, time budgets, and reports
    policy.ts               Application policy evaluation
    registry.ts             Implemented format inspectors
  formats/
    contracts.ts            Shared detector, check, and inspector interfaces
    png/
      index.ts              PNG module definition
      signature.ts          PNG signature detection
      header.ts             Existing IHDR inspection
      chunks.ts             Planned chunk traversal
      integrity.ts          Planned structure and CRC validation
      sanitize.ts           Planned explicit transformations
    jpeg/                   Future implementation; not registered
      index.ts
      signature.ts
      header.ts
      segments.ts
      integrity.ts
      sanitize.ts
  binary/
    crc32.ts                Planned incremental checksum utility
  security/
    contracts.ts            Reserved for a future malware scanner interface
  worker/
    protocol.ts             Worker message contracts
    entry.ts                Worker request handler
    client.ts               Worker lifecycle, queue, and cancellation
```

`core/registry.ts` registers the PNG module. Detection uses the registered
signatures; the coordinator runs the matching module's checks and builds the
report. Format-specific parsing belongs in `formats/`, while policy decisions
remain in `core/policy.ts`.

The public entry point remains `src/index.ts`. PNG inspection reads at most 33
bytes and does not validate CRCs or image data. `file.integrity` and
`file.malware` remain `not_checked`. Files marked as planned or reserved contain
only scaffolding; JPEG support and sanitization are not implemented.

## Validation

Using Node.js 24 and the installed dependencies:

```sh
npx tsc --noEmit
npx vitest run tests/unit
npx playwright test
```

The browser tests build the demo and exercise its production worker in Chromium.
See [the design document](docs/SDD.md) for the inspection model and limitations.
