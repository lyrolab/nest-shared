# Driver close prerequisite

Implementation is blocked on design decision 5: an idle `pg.Client.end()` can
leave a connection open beyond the close budget. A timeout around that promise
reports failure but does not close the connection or let the caller exit naturally.
The design requires returning this mismatch to Founding Engineer before implementing
an alternative transport or weakening the guarantee. No implementation task is
complete.

Run the injected transport probe with the repository's locked dependencies:

```sh
node openspec/changes/recover-retained-test-databases/verification/pg-close-probe.cjs
```

The runner starts two ordinary Node children against its own loopback protocol
fixture. It sends only AuthenticationOk and ReadyForQuery, then withholds the
peer's final close. It uses public Client configuration, connect, query, end and
error events. It never accesses a client socket or private driver state. The
parent observes child exits, then destroys only its own server-side sockets to
clean up. It does not force a successful child exit.

Observed with locked pg 8.23.1 and Node 24.13.0:

| Injected scenario                           | First end within 100 ms | Repeated end within 100 ms | Natural exit before fixture cleanup |
| ------------------------------------------- | ----------------------- | -------------------------- | ----------------------------------- |
| Active query with no response               | Yes                     | Yes                        | Yes                                 |
| Idle connection, peer withholds final close | No                      | No                         | No                                  |

Both children exit with code 0 after fixture cleanup. The idle child remains alive
for the additional 200 ms exit-observation window before cleanup. The test asserts
these outcomes and returns nonzero if they differ. It sets connection, query,
statement and lock timeouts to 100 ms; these do not bound idle shutdown.

In the installed driver, `Client.end` destroys the transport for an active query,
but calls graceful `Connection.end` for an idle connection. That path sends
Terminate and ends the writable side; the Client promise waits for the transport
close event. The connection timeout is cleared when connection setup completes.
Calling end again repeats graceful shutdown. Source locations are
`node_modules/pg/lib/client.js` (`end`) and
`node_modules/pg/lib/connection.js` (`end` and the stream close listener).

This is injected protocol/transport evidence, not native PostgreSQL recovery
acceptance. No disposable database, role, recovery API or public package declaration
has been created or verified. Production code, existing lifecycle behavior and the
release workflow are untouched.

Founding Engineer must route a concrete design correction for bounded idle
transport disposal through supported public interfaces, including TLS and natural
failure exits. A promise timeout or client unref alone cannot establish closure.
Keep the required exact ownership, uncertainty, close-failure reporting and ordinary
fresh-process behavior. Then return this same issue, branch and PR to Applier.
