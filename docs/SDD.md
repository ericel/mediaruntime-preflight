# MediaRuntime Preflight — Software Design Document

- **Repository:** `mediaruntime-preflight`
- **Proposed package:** `@mediaruntime/preflight` (subject to npm scope ownership)
- **Version:** 0.1
- **Status:** Draft for implementation
- **Date:** 2026-11-05
- **Implementation approach:** Developer-written, incremental TypeScript implementation; optional C++/WebAssembly later.

## 1. Purpose

MediaRuntime Preflight is a browser SDK that inspects user-selected files locally before upload. It reports file properties, upload-policy violations, and detectable structural problems with explicit inspection coverage.

The primary priorities are low latency, bounded resource use, honest results, and a straightforward developer API.

The default inspection does not upload file contents, contact a MediaRuntime inspection endpoint, or create a server job. Applications can self-host all SDK assets. Once those assets are available, inspection can operate offline.

## 2. Terminology and product boundary

“Immediate” inspection means one API call returns a report without job creation or polling. The JavaScript API returns a Promise because file reads and worker communication are asynchronous. It must not block the browser UI with synchronous inspection work.

This product is a local SDK, not an HTTP endpoint. MediaRuntime's separate asynchronous service remains available for deeper inspection, server-enforced policies, and processing from Node.js, Python, or other clients.

A browser report is advisory. Applications must independently enforce required rules on their servers because client checks can be bypassed.

## 3. Goals and non-goals

### Goals

- Inspect files before upload without transmitting their contents.
- Report exact file size and detect supported formats from bytes.
- Compare declared MIME and filename extension against detected format.
- Extract metadata needed for upload decisions.
- Detect specific structural defects within an explicit inspection scope.
- Apply application-defined size, format, and dimension policies.
- Keep work off the main thread and constrain reads and concurrency.
- Support cancellation and reusable worker instances.
- Expose consistent reports with stable finding codes and measured coverage.

### Non-goals for the first milestone

- General antivirus detection or a “virus-free” guarantee.
- Complete file integrity certification.
- Sanitization, repair, transcoding, or file modification.
- Full image decoding or full-file CRC validation.
- Audio, video, PDF, or archive inspection.
- A server endpoint, automatic upload, telemetry, or remote fallback.
- A worker pool, WASM runtime, or full FFmpeg distribution.

## 4. First milestone: PNG header inspection

The first milestone deliberately supports PNG only, alongside generic properties for every file.

| Capability | First-milestone behavior |
| --- | --- |
| Name and size | Report filename and exact byte size |
| Declared MIME | Record browser-provided MIME; treat it as untrusted metadata |
| Type detection | Recognize PNG signature from bytes |
| Dimensions | Read width and height from a structurally valid IHDR header |
| Header checks | Check signature, available length, IHDR position/type/length, and supported PNG header field constraints |
| Policy checks | Apply configured byte-size, format, and dimension/pixel limits when evidence permits |
| Corruption reporting | Report definite header defects; do not infer whole-file validity |
| Unsupported input | Return basic information and unsupported/inconclusive coverage |
| Malware | Explicitly report not checked |

A successful PNG header check means only that the examined header passed those checks. Image payload, later chunks, checksums, and decoding remain unvalidated.

A file named `.png` without a PNG signature is not thereby proven corrupt: it may be a renamed file of an unsupported format. Report the mismatch or inability to establish its type without inventing a corruption verdict.

## 5. Architecture

| Component | Responsibility |
| --- | --- |
| Public API | Accept a File and options; return a Promise of a report |
| Worker client | Manage worker lifecycle, IDs, pending requests, queue, and cancellation |
| Worker entry | Handle typed messages and invoke inspection logic |
| Inspection coordinator | Sequence detection, parsing, policy, and report creation |
| Bounded reader | Validate ranges, enforce read budgets, and count bytes |
| Detector | Identify supported formats from signatures |
| Format inspector | Validate format-specific structures and extract metadata |
| Policy evaluator | Decide whether available evidence satisfies application rules |
| Report builder | Normalize results, findings, coverage, and metrics |

The inspection coordinator must not depend on worker messaging or the DOM. It should accept an injected reader and metadata so its logic can be tested directly.

All format inspectors must access bytes through the bounded reader. Inspectors must not create workers, initiate network requests, or make final application upload decisions.

## 6. Project structure

One TypeScript package is sufficient initially. The source is organized around a registry of implemented format modules. Planned modules have explicit placeholders and are not registered until implemented.

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Public exports only |
| `src/inspect.ts` | Public inspection API |
| `src/types.ts` | Public options, reports, checks, findings |
| `src/worker/client.ts` | Worker lifecycle, queue, pending requests |
| `src/worker/entry.ts` | Worker-side message handler |
| `src/worker/protocol.ts` | Typed request, response, and cancellation messages |
| `src/core/inspect-file.ts` | Inspection orchestration, time budgets, and report construction |
| `src/core/reader.ts` | Bounded Blob/File range reads |
| `src/core/detect.ts` | Byte-based detection through registered format detectors |
| `src/core/policy.ts` | Policy evaluation |
| `src/core/registry.ts` | Registered, implemented format inspectors |
| `src/formats/contracts.ts` | Shared detector, check, and inspector contracts |
| `src/formats/png/index.ts` | PNG module definition |
| `src/formats/png/signature.ts` | PNG signature detection |
| `src/formats/png/header.ts` | PNG IHDR inspection |
| `src/formats/png/chunks.ts` | Planned bounded PNG chunk traversal |
| `src/formats/png/integrity.ts` | Planned PNG structure and CRC validation |
| `src/formats/png/sanitize.ts` | Planned explicit PNG transformations |
| `src/formats/jpeg/` | Future JPEG module: index, signature, header, segments, integrity, sanitize |
| `src/binary/crc32.ts` | Planned incremental checksum utility |
| `src/security/contracts.ts` | Reserved for a future malware scanner interface |
| `tests/unit/reader.test.ts` | Read boundaries and budgets |
| `tests/unit/detect.test.ts` | Signature detection and misleading names |
| `tests/unit/png.test.ts` | Valid and malformed PNG headers |
| `tests/unit/policy.test.ts` | Policy decision semantics |
| `tests/browser/preflight.spec.ts` | Production worker integration, reuse, and policy evaluation |
| `tests/fixtures/README.md` | Fixture origin and expected results |
| `examples/browser/index.html` | File-selection demo |
| `examples/browser/main.ts` | Public SDK usage and report rendering |
| `docs/SDD.md` | This design document |
| `package.json` | Package exports, scripts, dependencies |
| `tsconfig.json` | TypeScript configuration |
| `.gitignore` | Generated output and dependency exclusions |
| `README.md` | Installation, purpose, limitations, usage |

Build and test configuration files will be added after selecting the toolchain. Worker packaging must be verified from the built package, not only from source imports.

## 7. Public API contract

The proposed public operation is `inspect(file, options)`, returning `Promise<InspectionReport>`. Exact TypeScript declarations are the first implementation task.

### Input

- A browser File.
- Optional application policy: maximum byte size, allowed detected formats, maximum width, maximum height, maximum pixel count.
- Optional limits: maximum bytes read and inspection time budget.
- Optional early rejection on a definite policy failure.
- Optional AbortSignal for cancellation.

Validate options before scheduling work. Reject negative, non-finite, unsafe, or otherwise invalid numeric limits. Byte-count limits must be integers. Define omitted options explicitly rather than interpreting them as zero.

The AbortSignal stays on the main thread; the worker client converts cancellation into a message containing the request ID.

### Report fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Report schema version |
| `file` | Name, byte size, declared MIME |
| `detected` | Established format and MIME, or unknown |
| `metadata` | Properties established by inspection, such as dimensions |
| `checks` | Individual check IDs, statuses, and scope |
| `findings` | Stable codes, severity, and readable explanations |
| `policy` | allow, reject, or undetermined; associated rule results |
| `coverage` | Completed/skipped checks and limiting reasons |
| `metrics` | End-to-end duration and actual bytes read |

Missing metadata must remain missing, not be filled with invented values or zero dimensions. Do not expose `safe: true` or a blanket `corrupted: false`.

### Check statuses

| Status | Meaning |
| --- | --- |
| `passed` | This specific check completed successfully |
| `failed` | This specific check established a defect or violation |
| `inconclusive` | Attempted work could not establish a result |
| `unsupported` | The implementation cannot perform the check for this input |
| `not_checked` | The check was not attempted |

### Policy semantics

- **reject:** at least one configured rule definitely failed.
- **undetermined:** no rule definitely failed, but at least one configured rule cannot be evaluated.
- **allow:** every configured rule passed. This means only policy compliance within reported coverage, never complete integrity or malware clearance.
- With no configured rules, policy is allow with an empty rule list; documentation must state this narrow meaning.
- A known malformed header produces a failed structural check. Applications can use check failures independently of size/type policy; a future explicit structural-validity policy must specify its required scope.

## 8. Inspection sequence

1. Validate input and options; reject an already-aborted request.
2. Assign a unique request ID and place the request in a bounded queue.
3. Initialize or reuse the worker, then dispatch the request.
4. Read name, byte size, and declared MIME without scanning content.
5. Evaluate rules that require no content reads, such as maximum file size.
6. If configured, return early on definite policy rejection and mark skipped checks.
7. Read the minimum bytes needed for format detection through the bounded reader.
8. Select the matching inspector or report unsupported inspection.
9. Perform scoped checks and extract established metadata within limits.
10. Evaluate remaining policies and construct the report.
11. Resolve the matching pending request and release its queue slot.

Do not use extension or declared MIME as proof of file format. They are useful for mismatch findings and display only.

## 9. Reader and resource rules

- Use range reads rather than reading an entire File into an ArrayBuffer.
- Validate offset and length as nonnegative safe integers and check their sum safely.
- Distinguish truncated input from budget exhaustion and I/O failure.
- Enforce the byte budget before each read.
- Count actual bytes fetched; repeated reads count again unless served from an explicitly bounded cache.
- Prefer reusing a small header buffer to avoid duplicate reads.
- Keep per-read allocation bounded. Memory usage should depend on configured read limits rather than total file size.
- Start with one active inspection per worker and a bounded pending queue. Reject queue overflow with a documented operational error.
- Do not hash full files or decode full content in the default path.

Exact defaults for read budget, queue capacity, and time budget remain implementation decisions to document before release.

## 10. Cancellation, deadlines, and worker lifecycle

Cancellation must settle the caller's Promise with an abort error and remove queued work when possible. Late results for a cancelled request must be ignored.

Running inspections check cancellation between reads and bounded parsing steps. A cancellation message cannot interrupt a long synchronous loop by itself; future expensive parsers must yield or support worker termination.

The initial time budget is cooperative, checked between operations. It is not a hard real-time guarantee. If a hard-stop watchdog is added, terminating the worker must settle affected requests explicitly and allow a new worker to be created.

Reuse the worker across successful calls. Worker crashes must reject affected requests rather than leaving Promises unresolved. Initialization failures must be explicit; do not silently move expensive work onto the main thread. Define an explicit disposal API before release to terminate the worker and settle pending calls.

## 11. Performance and latency

The primary optimization is bounded work and avoiding upload latency. C++ is not required for reading a small PNG header.

Measure:

- Cold first-call latency, including worker startup.
- Warm end-to-end latency, including queueing and communication.
- Inspection execution time separately from queue wait.
- p50 and p95 over a stated corpus and device/browser matrix.
- Bytes read and estimated or measured peak memory where available.
- Package download size; later, WASM download and initialization cost.

A warm quick-check p95 below 100 ms is a candidate engineering target for a defined corpus, not a validated product guarantee. No latency promise should be published before measurement on desktop and mobile.

For the first milestone, increasing unused trailing file data should not increase header inspection bytes. Performance tests should verify this bounded-read behavior rather than assert brittle wall-clock thresholds in ordinary unit tests.

## 12. Error model

| Condition | Behavior |
| --- | --- |
| Malformed supported file | Return a report with failed checks |
| Unsupported format | Return basic metadata and explicit coverage limitations |
| Read/time budget exhausted | Return partial report with inconclusive checks |
| Invalid input/options | Reject with a configuration/input error |
| File read fails | Reject with a file-read error |
| Worker fails to initialize or crashes | Reject with a worker error |
| Queue is full | Reject with a queue-capacity error |
| User aborts | Reject with an abort error |

Malformed input is an expected inspection outcome. It must not be confused with an SDK infrastructure failure.

## 13. Privacy and security scope

- No automatic upload, remote fallback, or telemetry in the default SDK.
- Optional asset loading must be documented and self-hostable.
- Never execute embedded file content while inspecting it.
- Treat all file bytes, offsets, lengths, and declared metadata as untrusted.
- Keep parsing bounds explicit and test maliciously large or truncated fields.
- General malware scanning is not implemented in this milestone; report it as not checked.
- Server-side enforcement remains necessary for security-sensitive upload rules.
- Sanitization is a future separate operation that would return a new file and a transformation report; inspection itself is read-only.

## 14. Testing and acceptance criteria

### Unit coverage

- Valid PNG signature and header produce expected dimensions.
- A misleading extension or MIME does not override byte-based detection.
- Empty input and truncated signature/header return truthful findings.
- Invalid IHDR length/type or header field combinations are detected within scope.
- Read requests cannot exceed bounds or configured budgets.
- Budget exhaustion remains distinct from corrupt input.
- Size, width, height, and pixel policies behave at exact boundaries.
- Unknown required metadata produces undetermined policy results.
- Full-file integrity and malware checks remain explicitly unperformed.

### Browser integration

- File objects reach a real worker and reports return to the correct caller.
- Multiple calls reuse the worker and obey the queue bound.
- Queued and active cancellation settle correctly; stale results are ignored.
- Worker failure does not strand pending Promises.
- The packaged SDK resolves its worker asset in the supported example app.
- Inspection produces no file-content network requests.

### First-milestone completion

The milestone is complete when PNG header inspection works through the public API in the browser example, the above tests pass, read counts remain bounded, and the report clearly distinguishes header success from full-file validation.

## 15. Incremental implementation plan

1. Define public report/options types and check/policy semantics.
2. Define worker protocol types without implementing transport yet.
3. Implement and test the bounded reader.
4. Implement and test PNG signature detection and header parsing.
5. Implement policy evaluation and report construction.
6. Connect the coordinator and test it without worker messaging.
7. Add worker transport, queueing, cancellation, and error handling.
8. Expose the public API and build the browser example.
9. Verify built-package worker loading and measure cold/warm latency.
10. Document supported checks, limitations, defaults, and disposal behavior.

Each step should be understandable and reviewable independently. Do not add a framework or abstraction until a concrete requirement justifies it.

## 16. Future extension points

| Extension | Direction |
| --- | --- |
| Additional images | Add inspectors behind the shared reader/inspector contract |
| Audio/video | Read relevant container ranges; avoid default full decoding |
| Deep validation | Explicit opt-in with separate coverage and budgets |
| C++/WASM | Add only for useful parser reuse or measured compute needs |
| WASM loading | Load by format, cache versioned assets, reuse initialized modules |
| Server integration | Explicit application-controlled action, never silent fallback |
| Antivirus | Separate capability with maintained detection data and honest scope |
| Sanitization | Separate operation producing a new artifact |

A full FFmpeg WASM dependency is not part of the initial package. Future native parser reuse must consider licensing, maintenance, memory limits, and cold-start cost before adoption.

## 17. Decisions still open

- Build/test tools and supported browser versions.
- Exact worker asset distribution and Content Security Policy requirements.
- Default byte/time budgets and queue capacity.
- Public disposal API and worker idle lifetime.
- Final TypeScript property names and stable finding-code naming scheme.
- Package license and npm scope availability.
- Broader format order after PNG.

These are draft design decisions, not claims about an existing implementation.
