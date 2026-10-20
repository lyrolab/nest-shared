# DNS and SCRAM work outlive recovery shutdown

Preloaded TLS material does not resolve the complete acquisition bound. The public recovery function returns while a DNS lookup or pg SCRAM key derivation is unfinished. SCRAM then starts more crypto work after return. Founding Engineer must select a supported acquisition/disposal boundary before implementation resumes. No production workaround or weaker guarantee is applied.

## Reproduce

From a built checkout with locked dependencies:

```sh
npm run build
node openspec/changes/recover-retained-test-databases/verification/queued-connection-probe.cjs
```

The data file supplies four cases to one runner. Each starts an ordinary fresh Node process importing the built public database subpath. The runner does not explicitly preload pg or the administration helper. A parent-owned loopback server speaks only PostgreSQL startup and a valid SCRAM challenge; it never receives a SQL query. No real PostgreSQL server, acquisition, DROP or native acceptance is involved.

For DNS, four finite PBKDF2 jobs occupy the child's ordinary four-worker pool before recovery uses localhost. For SCRAM, the child uses a literal IP, and the fixture waits for the initial SCRAM response before filling the pool and sending a valid server-first message with 4,096 iterations. This separates crypto from DNS and certificate-file acquisition. No delayed filesystem, DNS or crypto result is injected.

Pass-through observers on public dns.lookup and WebCrypto methods count actual starts/settlements without changing their results. No pg methods, transport internals or private auth state are patched. The four fixture-owned PBKDF2 jobs are counted separately from recovery-started lookup/key derivation. Cancellation runs 20 ms after scheduling the DNS case, or 20 ms after SCRAM derivation starts. Timers and protocol exchanges can add ordinary scheduling time.

The child snapshots pending operations when recovery settles, then joins only its unrelated finite fixture jobs. Its one-shot beforeExit report observes eventual natural exit without calling process.exit, forceExit or unref. The parent leaves its server/peer open until child exit and has a 15-second failure watchdog for only its own child. It then destroys its own peers and closes its fixture. No private material, names, OIDs, endpoints or raw errors are printed.

## Observed results

Fresh build of implementation e5d4d97299db94000216772394dd28cca2d969c8; Node 24.13.0, pg 8.23.1 and locked/installed @types/pg 8.23.1. Each case uses work=100 ms and close=100 ms:

| Case               | API settles           | Pending recovery operation at return | Derivation settles | Crypto calls started after return | All child work done |
| ------------------ | --------------------- | ------------------------------------ | ------------------ | --------------------------------- | ------------------- |
| DNS deadline       | 111 ms                | One lookup                           | —                  | 0                                 | 1,164 ms            |
| DNS cancellation   | 44 ms, abort at 40 ms | One lookup                           | —                  | 0                                 | 1,029 ms            |
| SCRAM deadline     | 112 ms                | One key derivation                   | 969 ms             | 9                                 | 1,182 ms            |
| SCRAM cancellation | 69 ms, abort at 63 ms | One key derivation                   | 894 ms             | 9                                 | 1,010 ms            |

All four return the expected safe deadline/cancellation error in phase connect with outcome not-attempted. Every case sends zero queries, observes zero unhandled rejections and eventually exits naturally with code 0 before parent fixture cleanup. DNS cases never reach server authentication; SCRAM cases start no DNS lookup. Every started lookup/derivation eventually settles.

These are **unfinished-work observations**, not API settlement overruns. Eventual child lifetime includes the unrelated fixture jobs and cannot be attributed wholly to recovery. The independently observed pending recovery operations and nine post-return crypto calls establish the mismatch. Socket/Client closure and eventual natural exit are insufficient evidence that all recovery-owned work settled inside the advertised allowance. The original [queued certificate-file probe](queued-tls-config.md) is separate historical deadline-overrun evidence.

Exact inputs:

```text
f58f2e90ba0e6f633654b3be245b568033fd9f4ca7967feb782113ef08f1435d  database/build/native input set
a1e33860485ef63ca3c3f81de202bc74385365633366256d1302a48ac6ebd894  queued-connection-probe.cjs
ae6441eeb4296a94d9fac6584b9ceb3e54a93880fb8e2232e2cff4ca606cc9a4  queued-connection-scenarios.json
```

The input-set digest hashes sorted tracked paths under src/database plus package.json, package-lock.json, tsconfig.json, tsconfig.build.json and .github/workflows/test.yml, each as filename/NUL/content/NUL. Source, dependency, compiler and native inputs are unchanged from the retained baseline. Reproduce after changes to recovery/configuration/session/auth paths, driver/runtime, protocol fixture/data or pool contention. This is failure evidence, never passing full-deadline acceptance.

## Audit and next decision

- TLS file acquisition: remove it from recovery using the selected PEM-only contract in design decision 1a. Preserve existing normal TLS URL behavior through a narrow configuration separation. Path refusal and valid PEM/mutual-TLS regressions remain Applier work after the connection prerequisite is resolved.
- Lazy initialization: the distributed build is CommonJS; TypeScript emits dynamic imports as deferred require calls. These fresh children exercise the actual public package without an explicit pg/helper preload. That observation does not establish arbitrary loader/I/O latency bounds or optional-driver compatibility for a revised boundary; retain those tests.
- Hostname lookup: Node documents that dns.lookup uses the shared worker pool. A caller-prepared numeric endpoint may avoid lookup, provided the independent URL identity still controls TLS DNS/IP verification and actual base/role checks. This addresses lookup only.
- Credential fallback: the current helper supplies an internal password callback even for an explicitly empty URL password, preventing pgpass/PGPASSWORD fallback. Preserve that behavior; caller callbacks, ambient credential/config files and server-auth changes are not authorized.
- SCRAM: the locked driver uses WebCrypto deriveBits/PBKDF2 followed by HMAC/digest operations. Neither the public Client cancellation/close interface nor these WebCrypto signatures expose cancellation/join for the internal authentication chain. Observed socket disposal settles the Client promise while key derivation continues. Waiting for its completion can exceed the accepted bound under unrelated pool work.
- TLS setup: retain pg SSLRequest, trusted CA and hostname/IP verification, owned-socket disposal and the existing 13-case transport proof within its recorded scope. In-memory material and numeric resolution do not prove SCRAM closure. Do not disable TLS or replace its validation as a workaround.

Founding Engineer owns choosing a supported connection-preparation/isolation boundary or an upstream driver capability. Preloaded numeric addresses alone do not resolve SCRAM. Any selected isolation must be owned, bounded and joined before return; detached work, caller process exit, synchronous crypto, pool resizing, auth downgrade or private driver access remain forbidden. The TLS schema is specified, but this proposal is not ready to return to Applier until that further mismatch is resolved.

References: [Node DNS implementation considerations](https://nodejs.org/docs/latest-v24.x/api/dns.html#implementation-considerations), [public pg Client configuration](https://node-postgres.com/apis/client), [pg SSL options](https://node-postgres.com/features/ssl), [locked SCRAM implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/crypto/sasl.js) and [locked crypto implementation](https://github.com/brianc/node-postgres/blob/pg%408.23.1/packages/pg/lib/crypto/utils.js). Runtime source was inspected read-only; the pass-through public-interface probe supplies the measured behavior.
