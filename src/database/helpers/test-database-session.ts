import type { Client, ClientConfig, QueryResultRow } from "pg"
import type { Socket } from "node:net"
import { performance } from "node:perf_hooks"
import {
  TestDatabaseRecoveryError,
  TestDatabaseRecoveryPhase,
} from "../test-database-recovery-error"

const interruption = () => new Error("Database administration interrupted")

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(interruption()), Math.max(0, ms))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function connectionConfig(
  databaseUrl: string,
  signal?: AbortSignal,
): Promise<ClientConfig> {
  const url = new URL(databaseUrl)
  const { constants } = await import("node:fs")
  const { open } = await import("node:fs/promises")
  const readCertificate = async (key: string) => {
    signal?.throwIfAborted()
    // Nonblocking open lets us reject a FIFO without waiting for its writer.
    const file = await open(
      url.searchParams.get(key)!,
      constants.O_RDONLY | constants.O_NONBLOCK,
    )
    try {
      signal?.throwIfAborted()
      if (!(await file.stat()).isFile()) throw interruption()
      return await file.readFile({ signal })
    } finally {
      await file.close()
    }
  }
  const ssl =
    url.searchParams.get("sslmode") === "disable"
      ? false
      : [...url.searchParams.keys()].some((key) => key.startsWith("ssl"))
        ? {
            rejectUnauthorized: true,
            ...(url.searchParams.has("sslrootcert")
              ? { ca: await readCertificate("sslrootcert") }
              : {}),
            ...(url.searchParams.has("sslcert")
              ? { cert: await readCertificate("sslcert") }
              : {}),
            ...(url.searchParams.has("sslkey")
              ? { key: await readCertificate("sslkey") }
              : {}),
          }
        : false
  const password = decodeURIComponent(url.password)
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    // A callback also binds an empty password instead of falling back to PGPASSWORD.
    password: () => password,
    ssl,
    options: " ",
    application_name: "nest-shared-test-database",
    client_encoding: "UTF8",
  }
}

export class TestDatabaseSession {
  private readonly pending = new Set<Promise<unknown>>()
  private readonly closed: Promise<void>
  private readonly ended: Promise<void>
  private connected = false
  private stopping = false
  private lost = false
  private closing?: Promise<void>
  private confirmed = false

  private readonly onError = () => {
    this.lost = true
    if (!this.stopping) this.interrupt()
  }

  private constructor(
    private readonly client: Client,
    private readonly socket: Socket,
  ) {
    this.closed = new Promise((resolve) => socket.once("close", resolve))
    this.ended = new Promise((resolve) => client.once("end", resolve))
    socket.on("error", this.onError)
    socket.on("close", () => {
      if (!this.stopping) this.lost = true
    })
    client.on("error", this.onError)
  }

  static async create(
    databaseUrl: string,
    signal?: AbortSignal,
  ): Promise<TestDatabaseSession> {
    const [{ Client }, { Socket }, config] = await Promise.all([
      import("pg"),
      import("node:net"),
      connectionConfig(databaseUrl, signal),
    ])
    signal?.throwIfAborted()
    const socket = new Socket()
    const clientConfig: ClientConfig = {
      ...config,
      sslnegotiation: "postgres",
      connectionTimeoutMillis: 30_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      lock_timeout: 30_000,
      stream: () => socket,
    }
    return new TestDatabaseSession(new Client(clientConfig), socket)
  }

  get disposed(): boolean {
    return this.confirmed
  }

  get healthy(): boolean {
    return !this.stopping && !this.lost
  }

  interrupt(): void {
    this.stopping = true
    this.socket.destroy(interruption())
  }

  private observe<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    )
    return promise
  }

  private async operation<T>(
    phase: TestDatabaseRecoveryPhase,
    timeoutMs: number,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    if (!this.healthy)
      throw new TestDatabaseRecoveryError([{ code: "DATABASE_FAILURE", phase }])
    try {
      return await within(this.observe(dispatch()), timeoutMs)
    } catch {
      this.interrupt()
      throw new TestDatabaseRecoveryError([{ code: "DATABASE_FAILURE", phase }])
    }
  }

  async connect(timeoutMs: number): Promise<void> {
    this.connected = true
    await this.operation("connect", timeoutMs, () => this.client.connect())
  }

  async query<T extends QueryResultRow>(
    text: string,
    values: unknown[],
    phase: TestDatabaseRecoveryPhase,
    timeoutMs: number,
  ): Promise<T[]> {
    const config = { text, values, query_timeout: timeoutMs }
    const result = await this.operation(phase, timeoutMs, () =>
      this.client.query<T>(config),
    )
    return result.rows
  }

  close(timeoutMs: number): Promise<void> {
    this.closing ??= this.dispose(timeoutMs)
    return this.closing
  }

  private async dispose(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs
    const interrupted = this.stopping || this.lost
    this.stopping = true
    let failed = false
    if (interrupted) this.socket.destroy(interruption())
    const ending = this.observe(this.client.end()).catch(() => {
      failed = true
      this.socket.destroy(interruption())
    })
    const confirm = async () => {
      await Promise.all([
        this.closed,
        ...(this.connected ? [this.ended] : []),
        ending,
        ...[...this.pending].map((promise) => promise.catch(() => undefined)),
      ])
    }
    try {
      if (!interrupted) {
        try {
          await within(confirm(), Math.floor(timeoutMs / 2))
        } catch {
          failed = true
          this.socket.destroy(interruption())
        }
      }
      await within(confirm(), deadline - performance.now())
      this.confirmed = true
    } catch {
      failed = true
      this.socket.destroy(interruption())
    } finally {
      this.client.removeListener("error", this.onError)
      this.socket.removeListener("error", this.onError)
    }
    if (failed)
      throw new TestDatabaseRecoveryError([
        { code: "CLOSE_FAILED", phase: "close" },
      ])
  }
}
