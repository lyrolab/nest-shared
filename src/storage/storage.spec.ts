import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3"
import { Test } from "@nestjs/testing"
import { Readable } from "stream"
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers"
import { InvalidStorageKeyError } from "./errors/storage.errors"
import { StorageOptions } from "./interfaces/storage-options.interface"
import { InMemoryStorageService } from "./services/in-memory-storage.service"
import { S3StorageService } from "./services/s3-storage.service"
import { StorageService } from "./services/storage.service"
import { SharedStorageModule } from "./shared-storage.module"

const S3_IMAGE = "chrislusf/seaweedfs:4.48"
const ACCESS_KEY_ID = "nest-shared"
const SECRET_ACCESS_KEY = "nest-shared-secret"
const BUCKET = "nest-shared-it"
const REGION = "us-east-1"

jest.setTimeout(240_000)

class S3Server {
  private container?: StartedTestContainer
  endpoint = ""

  async start(): Promise<void> {
    this.container = await new GenericContainer(S3_IMAGE)
      .withCommand(["mini", "-dir=/data"])
      .withEnvironment({
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      })
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(180_000)
      .start()
    this.endpoint = `http://${this.container.getHost()}:${this.container.getMappedPort(8333)}`
    await this.createBucket()
  }

  async stop(): Promise<void> {
    await this.container?.stop()
  }

  options(keyPrefix?: string): StorageOptions {
    return {
      endpoint: this.endpoint,
      region: REGION,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      forcePathStyle: true,
      keyPrefix,
    }
  }

  client(): S3Client {
    return new S3Client({
      endpoint: this.endpoint,
      region: REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      },
    })
  }

  async keys(): Promise<string[]> {
    const client = this.client()
    try {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET }),
      )
      return (listed.Contents ?? []).map((object) => object.Key ?? "")
    } finally {
      client.destroy()
    }
  }

  // The S3 port opens a moment after the container reports it listening.
  private async createBucket(): Promise<void> {
    const client = this.client()
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.send(new CreateBucketCommand({ Bucket: BUCKET }))
          return
        } catch (error) {
          if (attempt === 30) throw error
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    } finally {
      client.destroy()
    }
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

const server = new S3Server()
let s3Started = false

beforeAll(async () => {
  await server.start()
  s3Started = true
})

afterAll(() => server.stop())

const implementations: [string, () => StorageService][] = [
  ["forTest() in memory", () => new InMemoryStorageService()],
  [
    "S3 against an S3-compatible server",
    () => new S3StorageService(server.options(`contract-${Date.now()}`)),
  ],
]

describe.each(implementations)("StorageService (%s)", (_name, create) => {
  let storage: StorageService
  let key = 0
  const nextKey = () => `images/${++key}/full.webp`

  beforeEach(() => {
    expect(s3Started).toBe(true)
    storage = create()
  })

  it("stores bytes and streams them back with their metadata", async () => {
    const objectKey = nextKey()
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 255])

    await storage.put(objectKey, bytes, { contentType: "image/webp" })
    const object = await storage.get(objectKey)

    expect(object).toMatchObject({
      contentType: "image/webp",
      contentLength: bytes.length,
    })
    expect(object?.body).toBeInstanceOf(Readable)
    expect(object?.lastModified).toBeInstanceOf(Date)
    expect(typeof object?.etag).toBe("string")
    expect(await readAll(object!.body)).toEqual(bytes)
  })

  it("stores a string as UTF-8", async () => {
    const objectKey = nextKey()

    await storage.put(objectKey, "héllo", { contentType: "text/plain" })
    const object = await storage.get(objectKey)

    expect(object?.contentLength).toBe(6)
    expect((await readAll(object!.body)).toString("utf8")).toBe("héllo")
  })

  it("keeps what was stored when the caller reuses its buffer", async () => {
    const objectKey = nextKey()
    const bytes = Buffer.from("original")

    await storage.put(objectKey, bytes, { contentType: "text/plain" })
    bytes.write("mutated!")

    const object = await storage.get(objectKey)
    expect((await readAll(object!.body)).toString()).toBe("original")
  })

  it("replaces an object stored under the same key", async () => {
    const objectKey = nextKey()

    await storage.put(objectKey, "first", { contentType: "text/plain" })
    await storage.put(objectKey, "second version", {
      contentType: "application/json",
    })
    const object = await storage.get(objectKey)

    expect(object).toMatchObject({
      contentType: "application/json",
      contentLength: 14,
    })
    expect((await readAll(object!.body)).toString()).toBe("second version")
  })

  it("returns null for a missing object", async () => {
    expect(await storage.get(nextKey())).toBeNull()
  })

  it("tells whether an object exists", async () => {
    const objectKey = nextKey()

    expect(await storage.exists(objectKey)).toBe(false)
    await storage.put(objectKey, "x", { contentType: "text/plain" })
    expect(await storage.exists(objectKey)).toBe(true)
  })

  it("deletes an object, and deleting it again is fine", async () => {
    const objectKey = nextKey()
    await storage.put(objectKey, "x", { contentType: "text/plain" })

    await storage.delete(objectKey)
    await storage.delete(objectKey)

    expect(await storage.exists(objectKey)).toBe(false)
    expect(await storage.get(objectKey)).toBeNull()
  })

  it("deletes a key that never existed", async () => {
    await expect(storage.delete(nextKey())).resolves.toBeUndefined()
  })

  it.each(["", "/images/1"])("rejects the key %p", async (badKey) => {
    for (const run of [
      () => storage.put(badKey, "x", { contentType: "text/plain" }),
      () => storage.get(badKey),
      () => storage.delete(badKey),
      () => storage.exists(badKey),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(InvalidStorageKeyError)
    }
  })
})

describe("S3StorageService key prefix", () => {
  it("stores, reads, checks and deletes every key under its prefix", async () => {
    const storage = new S3StorageService(server.options("env-a/"))

    await storage.put("images/1/full.webp", "a", { contentType: "image/webp" })

    expect(await server.keys()).toContain("env-a/images/1/full.webp")
    expect(await storage.exists("images/1/full.webp")).toBe(true)
    expect(await storage.get("images/1/full.webp")).not.toBeNull()
    await storage.delete("images/1/full.webp")
    expect(await server.keys()).not.toContain("env-a/images/1/full.webp")
  })

  it("never sees another prefix's objects", async () => {
    const envA = new S3StorageService(server.options("env-b"))
    const envB = new S3StorageService(server.options("env-c"))
    const unprefixed = new S3StorageService(server.options())

    await envA.put("shared/key", "a", { contentType: "text/plain" })

    expect(await envB.exists("shared/key")).toBe(false)
    expect(await envB.get("shared/key")).toBeNull()
    expect(await unprefixed.exists("shared/key")).toBe(false)
    await envB.delete("shared/key")
    expect(await envA.exists("shared/key")).toBe(true)
    expect(await unprefixed.exists("env-b/shared/key")).toBe(true)
  })

  it("stores without a prefix when none is set", async () => {
    const storage = new S3StorageService(server.options(""))

    await storage.put("root-level", "x", { contentType: "text/plain" })

    expect(await server.keys()).toContain("root-level")
  })

  it("surfaces errors other than a missing key", async () => {
    const wrongSecret = new S3StorageService({
      ...server.options(),
      secretAccessKey: "wrong",
    })
    const missingBucket = new S3StorageService({
      ...server.options(),
      bucket: "missing-bucket",
    })

    await expect(wrongSecret.get("k")).rejects.toThrow()
    await expect(wrongSecret.exists("k")).rejects.toThrow()
    await expect(
      wrongSecret.put("k", "x", { contentType: "text/plain" }),
    ).rejects.toThrow()
    await expect(missingBucket.get("k")).rejects.toThrow()
  })

  it("streams the object S3 holds", async () => {
    const storage = new S3StorageService(server.options("raw"))
    await storage.put("k", "payload", { contentType: "text/plain" })
    const client = server.client()

    try {
      const raw = await client.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: "raw/k" }),
      )
      expect(raw.ContentType).toBe("text/plain")
      expect(await raw.Body?.transformToString()).toBe("payload")
    } finally {
      client.destroy()
    }
  })
})

describe("SharedStorageModule", () => {
  it("forRootAsync provides the S3 implementation built from the factory", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SharedStorageModule.forRootAsync({
          useFactory: () => server.options("module"),
        }),
      ],
    }).compile()

    const storage = moduleRef.get(StorageService)
    expect(storage).toBeInstanceOf(S3StorageService)
    await storage.put("k", "x", { contentType: "text/plain" })
    expect(await server.keys()).toContain("module/k")
    await moduleRef.close()
  })

  it("forTest provides an in-memory implementation to inspect", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SharedStorageModule.forTest()],
    }).compile()
    const storage = moduleRef.get(StorageService)
    const memory = moduleRef.get(InMemoryStorageService)

    await storage.put("images/1/thumb.webp", "x", { contentType: "image/webp" })

    expect(memory.objects.get("images/1/thumb.webp")).toMatchObject({
      contentType: "image/webp",
    })
  })

  it("refuses an access key without its secret", async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          SharedStorageModule.forRoot({
            region: REGION,
            bucket: BUCKET,
            accessKeyId: ACCESS_KEY_ID,
          }),
        ],
      }).compile(),
    ).rejects.toThrow("set both accessKeyId and secretAccessKey")
  })
})
