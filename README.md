# reg-runtime

Zero-libc **register-machine scripting runtime**: a small JavaScript-subset
language is interpreted at build time and emitted as a freely relocatable
**UEFI PE32+ application** — no GCC, no Clang, no NASM, no `ld`, no libc, no
`ld.so`, and no EFI development toolkit on the build host. A legacy static
x86-64 ELF target is still available with `--linux` / `KZERO_PLATFORM=linux`
for comparison and for running the test suite without a VM.

The whole toolchain is plain Node.js + raw machine-code emission.

## Capabilities

The runtime language (`.kz` scripts) supports:

- `let name = value` — variable bindings (numbers, strings, arrays, variables,
  parenthesized expressions, `require(...)`/`fs.*`/`net.*`/`fetch(...)`/
  object-method expressions).
- `console.log(value)` — numbers, strings, arrays, variables, expressions,
  multiple arguments (comma-separated), `+` concatenation / numeric add.
- `console.error(...)` / `console.warn(...)` — routed to stderr.
- Timers: `setTimeout(callback, delay)` and `setInterval(callback, delay)`,
  with `clearTimeout(id)` / `clearInterval(id)`. Callbacks may be arrow
  functions (block or expression body) or references to named functions.
  Delays are milliseconds. Pending timers run in an event loop after the script
  reaches end of input; intervals repeat until cleared. `process.exit(code)`
  stops immediately without running pending timers. On UEFI the millisecond
  clock advances with `BootServices->Stall`; on the Linux target it advances
  with `nanosleep`.
- Arrays: `[1, 2, 3]` literals (including nested arrays), element reads with
  `a[i]`, element writes with `a[i] = value`, `.length`, `.push(v)`, `.pop()`,
  and `console.log` rendering as `[1, 2, 3]`. Arrays use a stable handle whose
  data buffer doubles on growth, so `push` is unbounded and never invalidates a
  stored variable. Out-of-range, negative, and non-integer index writes are
  ignored. Logged arrays are deep-snapshotted at call time, so deferred output
  is unaffected by later mutation of the array or any nested arrays.
- Control flow: `while (cond) { ... }` and C-style
  `for (init; cond; step) { ... }`, including nested loops. Conditions support
  `<`, `>`, `<=`, `>=`, `==`, `!=`, plus a plain-value truthiness test. Loop
  bodies must be brace-delimited (the opening `{` may be on the next line);
  `step` may be an assignment such as `i = i + 1`. Array `.length` and element
  reads are valid in conditions.
- Branching: `if (cond) { ... } else if (cond) { ... } else { ... }`, with
  arbitrary nesting and loops inside either branch. An `if / else if / else`
  chain is evaluated as a single switch-like construct: conditions are tested in
  order, the first true body runs, and control resumes after the whole chain.
  `else` and `else if` are optional, and the opening `{` may be on the next
  line.
- Functions: `function name(p0, p1, ...) { ... }` with `return expr;` (an
  expression, a bare `return`, or an implicit return of `0` at the closing
  brace). Calls work as statements, as values in `let`/`console.log`, and
  nested inside arguments. Member and index access chains on call results work
  too, e.g. `mk()[2]` and `str().length`. Parameters are bound per call (missing
  arguments become `0`, extras are ignored), locals are isolated, and recursion
  works up to a depth of 128; deeper calls return `0`. A function can read the
  caller's variables, but writes to them are discarded when it returns.
  Definitions are sequential: a call before its `function` declaration is
  treated as unknown and evaluates to `0`, and a later redefinition shadows an
  earlier one. At most 8 named parameters and 64 defined functions are tracked.
- Plain assignment `name = value` (in addition to `let name = value`), which is
  what makes C-style loop steps and counters work.
- Builtins: `require`, `fs.readFileSync`, `fs.writeFileSync`, `fs.existsSync`,
  `net.connect`, `net.write`, `net.read`, `net.close`, `fetch(url)`,
  `process.exit(code)`.
- Value model: 64-bit tagged words — integer, inline short string (≤7 bytes),
  heap string/buffer, array pointer, socket descriptor, negative integer.

### Concurrency model

The dispatcher parses script statements; input / file / net / output stages run
as `clone(CLONE_VM)` workers on pinned physical cores via SPSC cache-line-padded
rings. `node build.js --single-core` collapses every stage onto core 0.

The UEFI target is deliberately smaller: the script is loaded synchronously
from the boot volume (or embedded at build time), console writes go straight to
`ConOut->OutputString`, and the file/net worker processes are not spawned, so
`fs`, `net`, and `fetch` fail fast and return `0`. Timer callbacks and function
calls still use the same interpreter and register ring as the Linux build.

The runtime requires AVX-512F (plus opmask/ZMM state) because the variable ring
lives in ZMM registers. UEFI entry checks CPUID and XCR0 and prints a clear
message instead of faulting if the firmware/CPU cannot provide that state.

### Function calls: selective spill and remote execution

A local call does not unconditionally save the whole ZMM variable ring. At
definition time the runtime scans the function body, records every ring slot it
names, and adds every parameter slot (binding writes a parameter even when the
body never reads it). A call then saves and restores only those registers. The
old full-spill behaviour is still available with `KZERO_FULL_SPILL=1` for
comparison.

Simple functions can also run on a dedicated compute worker pinned to CPU 10.
The dispatcher sends only the body start address, the arguments, and a snapshot
of the ring slots the body reads; the worker binds the snapshot and the
parameters into its own ring, replays the body with the same interpreter, and
publishes the return value through a sequence-numbered mailbox. The caller's
ring is untouched, and the normal return path resumes its continuation as soon
as the response line arrives. Nested calls inside a remote body stay local on
the worker, so there is at most one cross-core hop per call.

Remote execution is deliberately conservative. A function stays local if its
body contains a call, member access (`.`), index access (`[`/`]`), a nested
`function`, or any of `console`, `require`, `fs`, `net`, or `process`; if the
call has more than 8 arguments; or if the body needs more than the 16 ring-slot
dependency snapshot. Exceeding the dependency cap clears the remote flag, so a
body can never run remotely with a missing global. Global reads therefore see
the caller's values, while writes to globals are discarded on return on both
the local and remote paths, matching the existing copy-on-call semantics.
Single-core builds never dispatch remotely. `KZERO_NO_SPILL=1` is a diagnostic
build that omits caller-ring preservation entirely; it is not a valid runtime
mode.

Remote execution is **off by default**, because the synchronous round trip does
not pay for itself. `KZERO_REMOTE=1` opts in; `KZERO_NO_REMOTE=1` still forces
every call local and wins if both are set. The raw cross-core ping-pong probe
(`tests/pingpong.js`) measures roughly 105–110 ns on CPU 0↔CPU 2, but a full
request/response call through the mailbox adds roughly 200–520 ns per call on
the reference machine, while the local selective spill is far cheaper.
Representative medians over 50,000 calls, with empty-program startup
subtracted:

| workload (50k calls)      | local selective | local full | remote | node v24 |
|---------------------------|----------------:|-----------:|-------:|---------:|
| small body (one add)      |           11 ms |      10 ms |  21 ms |    ~70 ms |
| 12-step body              |           32 ms |      31 ms |  54 ms |    ~65 ms |
| 12 globals + 12 steps     |           34 ms |      36 ms |  60 ms |    ~68 ms |

The local path wins across the range, so remote execution remains available
for measurement and experimentation but is not the default. Making it
worthwhile would require overlapping calls asynchronously instead of blocking
on every response.

### Native fetch

> `fetch`, `fs`, and `net` are available on the Linux target only. The UEFI
> build has no network stack or file worker yet; these calls return `0`.

`fetch(url)` performs the whole HTTP exchange on the net worker and returns a
response object:

```js
let res = fetch("http://example.com/");
console.log(res.status);   // numeric status code
console.log(res.body);     // response body as a string
console.log(res.text);     // alias for .body
console.log(res.headers);  // raw header block, including the status line
console.log(res.ok);       // 1 for 200..299, else 0
console.log(res.length);   // body byte length
```

Members can be chained (`fetch(u).body.length`, `res.headers.length`) and used
in `+` expressions. A failed fetch (bad scheme, DNS failure, connect timeout,
malformed response) returns `0`; non-string URL arguments also return `0`
without dereferencing them.

Responses can be chained with `.then(callback)`. Because fetch already blocks
until the exchange completes, `.then` invokes the callback immediately rather
than deferring it:

```js
fetch("http://example.com/").then(res => {
  console.log(res.status);
  console.log(res.body);
});

fetch(url).then(res => res.status).then(status => { console.log(status); });
```

Callbacks may be arrow functions with a block body (`res => { ... }`), a single
expression (`res => res.status`), zero or more parameters
(`(a, b) => ...`), or a reference to a named function (`fetch(u).then(show)`).
The receiver is passed as the first argument. A callback that returns a value
becomes the chain value; a callback that returns nothing (implicitly `0`) keeps
the receiver, so further `.then` calls continue to see the response. Callbacks
live in the same registry as named functions, so each distinct `.then` site
uses one of the 64 function-table entries; the entry is reused when the same
site is executed again.

The raw `.headers` block contains the complete response headers, including
every `Set-Cookie` line, so cookies and other metadata are available without a
separate cookie jar:

```
HTTP/1.1 200 OK
content-type: text/plain
set-cookie: session=abc123; Path=/; HttpOnly
```

- **HTTP and HTTPS.** Plain HTTP is spoken directly by the runtime. `https://`
  URLs fork `/usr/bin/openssl s_client -quiet` behind a pair of pipes: the
  runtime writes the plaintext request to the helper's stdin and reads the
  decrypted response from its stdout. The runtime contains no crypto and never
  sends an HTTPS request as plaintext. OpenSSL does the handshake and reads the
  system trust store, but its verification diagnostics are discarded, so an
  untrusted or self-signed certificate does not block the exchange; this is not
  a hardened TLS client. The helper's stderr and (unreliable) exit status are
  ignored. If `openssl` is missing or the handshake fails, the fetch returns
  `0`.
- Up to five `3xx` redirects carrying a `Location` header are followed.
  Absolute (`https://...`), scheme-relative (`//host/...`) and path-relative
  (`/path`) locations are supported. After the limit, or for any other
  location form, the `3xx` response itself is returned.
- DNS uses UDP to Cloudflare's public resolver at `1.1.1.1:53`, with a 2 s
  receive timeout; the transaction ID and RCODE are validated. IPv4 literals
  and `localhost` are resolved locally; other digit-leading names fall through
  to DNS. There is no secondary resolver fallback yet.
- The connection uses a non-blocking connect with a 5 s poll timeout, then
  returns to blocking reads. Requests use `HTTP/1.0` plus
  `Connection: close`, so the response is read to EOF.
- The response body and headers are copied into per-worker heap objects; the
  request buffer is 8 KiB, the raw response buffer is 1 MiB, and the worker heap
  is 32 MiB.


### Language limits

- Loop and branch bodies **must** use braces. `break`, `continue`,
  `do ... while`, `switch`, and single-statement bodies are not implemented.
- Conditions compare raw tagged words, so ordering comparisons are reliable for
  non-negative integers. Negative values carry a tag bit and will not order
  numerically.
- Arithmetic is limited to `+` (numeric add / string concatenation); there is
  no `-`, `*`, `/`, or `%`. Recursive counters must therefore count upward to a
  bound rather than subtract toward zero.
- Functions support at most 8 parameters, a call depth of 128, and 64 defined
  functions. Call bodies and all locals must still fit the variable ring (248
  slots), so scripts with hundreds of distinct names alias slots; the function
  table ignores definitions past 64.
- Timer callbacks follow function-call semantics: global writes made inside a
  callback are discarded when it returns. To stop an interval from a timer,
  clear it from a separate timer instead of mutating a counter inside the
  interval callback.
- Input scripts are read through a fixed 1 MiB buffer (`INPUT_CAP`); larger
  scripts are truncated at the buffer boundary.

## Build

```sh
npm run build            # -> ./kzero.efi (UEFI PE32+)
npm run build:linux      # -> ./kzero (legacy static ELF64)
npm run build:single     # Linux single-core variant -> ./kzero_single
node build.js --source app.kz   # embed app.kz as the default script
node build.js out.efi            # emit to a custom path
node build.js --out out.efi      # same, explicit
node build.js app.kz             # shorthand for --source app.kz
node build.js --linux out.kz     # legacy ELF to a custom path
```

Pipeline: `asm.js` (raw x86-64 assembler) → `engine.js` (runtime assembly
generator, single source of truth) → `uefi.js` (PE32+ image writer) or
`elf.js` (legacy static ELF64 writer).

## Usage

```sh
# UEFI: install as \EFI\BOOT\BOOTX64.EFI on a FAT filesystem and boot it.
# The default script path is \script.kz; the load option can override it.
qemu-system-x86_64 -accel kvm -cpu host -machine q35 -m 256 \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/qemu/edk2-x86_64-code.fd \
  -drive format=raw,file=fat:rw:uefi_root -nographic

# Legacy Linux binary:
./kzero script.kz        # run a script file
./kzero < script.kz      # or via stdin
echo 'console.log(42);' | ./kzero
```

QEMU's TCG backend does not implement AVX-512, so the UEFI image must run with
hardware virtualization (`-accel kvm -cpu host`) on an AVX-512-capable CPU.
Without it, the runtime prints `reg-runtime: AVX-512F is required` and returns
`EFI_UNSUPPORTED`.

## Tests

- `npm test` — builds the legacy Linux target as `./kzero`, then runs the smoke
  runner (`tests/run.mjs`): every pure-kz script under `tests/kz/` is executed
  and reported pass/fail. A script with a matching `<name>.expected` file must
  also match its stdout. Single script: `node tests/run.mjs <name>`.
  `tests/kz/test_timers.js` covers timer ordering, zero delay, nested timers,
  intervals, `clearTimeout`, `clearInterval`, block and expression callback
  bodies.
- `node tests/fetch_test.mjs` — boots loopback HTTP and HTTPS servers (the TLS
  one uses a throwaway self-signed certificate) and checks `fetch()`
  status/body/headers/ok/length, chained members, empty and binary bodies,
  absolute/path-relative/scheme-relative redirects (including the five-hop cap),
  the OpenSSL HTTPS helper, clean failure for unsupported schemes and non-string
  URLs, `.then` chaining (block, expression, named-function, zero- and
  multi-parameter callbacks, loops), and `Set-Cookie` visibility in
  `.headers`.
- `npm run test:asm` — x86-64 instruction suite (`tests/instruction_test.js`).
- `node tests/pingpong.js [rounds]` — builds and runs a two-core shared-memory
  ping-pong probe and prints the cross-core round-trip latency in ns. Used to
  bound the cost of any worker-core design before building one.

## Layout

- `asm.js` — pure-JS x86-64 assembler (GPR/XMM/VEX/EVEX, branches, syscalls).
- `uefi.js` — PE32+ UEFI application writer (.text + .reloc).
- `elf.js` — legacy static ELF64 executable writer (PT_LOAD segments, no libc).
- `engine.js` — runtime assembly generator (dispatcher + worker stages + parser).
- `build.js` — build entry point / CLI (UEFI by default, ELF with `--linux`).
- `ring.js` — ZMM register-file slot load/store emitters.
- `pipeline.js` — SPSC ring + thread primit+ .reloc).
- `elf.js` — legacy static ELF64 executable writer (PT_LOAD segments, no libc).
- `engine.js` — runtime assembly generator (dispatcher + worker stages + parser).
- `build.js` — build entry point / CLI (UEFI by default, ELF with `--linux`).
- `ring.js` — ZMM register-file slot load/store emitters.
- `pipeline.js` — SPSC ring + thread primitive emitters.
- `tests/` — smoke scripts (`tests/kz/`) + runners/harnesses.
- `legacy/` — superseded implementations (e.g. the pre-ASM JS interpreter).
# js-os
# js-os
