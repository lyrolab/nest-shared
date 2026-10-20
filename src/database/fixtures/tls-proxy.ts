import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import * as tls from "node:tls"

export async function createTlsProxy(
  databaseUrl: string,
  scratch: string,
  mutual: boolean,
) {
  const directory = fs.mkdtempSync(path.join(scratch, "tls-"))
  const certPath = path.join(directory, "cert.pem")
  const keyPath = path.join(directory, "key.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  )
  const cert = fs.readFileSync(certPath, "utf8")
  const key = fs.readFileSync(keyPath, "utf8")
  const context = tls.createSecureContext({ cert, key, ca: cert })
  const upstream = new URL(databaseUrl)
  const peers = new Map<net.Socket, Promise<void>>()
  let verifiedClients = 0,
    secureConnections = 0
  const track = <T extends net.Socket>(socket: T): T => {
    peers.set(
      socket,
      new Promise<void>((resolve) => socket.once("close", () => resolve())),
    )
    socket.on("error", () => {})
    return socket
  }
  const server = net.createServer((raw) => {
    track(raw)
    raw.once("data", (request) => {
      if (request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        raw.destroy()
        return
      }
      raw.write("S")
      const encrypted = track(
        new tls.TLSSocket(raw, {
          isServer: true,
          secureContext: context,
          requestCert: mutual,
          rejectUnauthorized: mutual,
        }),
      )
      encrypted.once("secure", () => {
        secureConnections++
        if (mutual) {
          const peer = encrypted.getPeerCertificate()
          if (
            !peer.raw ||
            !new X509Certificate(peer.raw).verify(
              new X509Certificate(cert).publicKey,
            )
          )
            encrypted.destroy()
          else verifiedClients++
        }
      })
      const backend = track(
        net.connect({
          host: upstream.hostname,
          port: Number(upstream.port || 5432),
        }),
      )
      backend.on("error", () => encrypted.destroy())
      encrypted.once("close", () => backend.destroy())
      backend.once("close", () => encrypted.destroy())
      encrypted.pipe(backend).pipe(encrypted)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const explicit = new URL(databaseUrl)
  explicit.hostname = "localhost"
  explicit.port = String(server.address().port)
  explicit.search = "?sslmode=verify-full"
  const normal = new URL(explicit)
  normal.searchParams.set("sslrootcert", certPath)
  if (mutual) {
    normal.searchParams.set("sslcert", certPath)
    normal.searchParams.set("sslkey", keyPath)
  }
  return {
    normalUrl: normal.toString(),
    base: {
      databaseUrl: explicit.toString(),
      expectedRole: decodeURIComponent(explicit.username),
      tls: { caPem: cert, ...(mutual ? { certPem: cert, keyPem: key } : {}) },
    },
    report: () => ({ secureConnections, verifiedClients }),
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        for (const peer of peers.keys()) peer.destroy()
        await Promise.race([
          Promise.all([closed, ...peers.values()]),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("TLS fixture did not close")),
              2000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}
