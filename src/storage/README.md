# Storage Module — `@lyrolab/nest-shared/storage`

Object storage behind a small port, with an S3 implementation for AWS S3 and S3-compatible servers, and an in-memory one for tests.

## What Is This?

A dynamic NestJS module providing `StorageService`:

- `put(key, body, { contentType })` stores bytes or a string under a key, replacing any object already there
- `get(key)` opens an object as a stream with its content type, length, last modification and ETag, or returns `null` when there is none
- `delete(key)` deletes an object; deleting a missing one is fine
- `exists(key)` tells whether an object exists
- An optional key prefix keeps apps or environments apart in one bucket
- `forTest()` swaps in an in-memory implementation and needs no S3 package

There are no public or presigned links: the app reads objects and serves them itself, behind its own access checks.

## How Do I Use It?

### 1. Install the S3 Client

The S3 implementation needs the optional peer dependency `@aws-sdk/client-s3` (3.729 or later). An app that only uses `forTest()` does not need it.

```bash
npm install @aws-sdk/client-s3
```

### 2. Register the Module

```typescript
import { Module } from "@nestjs/common"
import { ConfigModule, ConfigService } from "@nestjs/config"
import { SharedStorageModule } from "@lyrolab/nest-shared/storage"

@Module({
  imports: [
    SharedStorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        endpoint: config.get<string>("STORAGE_ENDPOINT"),
        region: config.getOrThrow<string>("STORAGE_REGION"),
        bucket: config.getOrThrow<string>("STORAGE_BUCKET"),
        accessKeyId: config.get<string>("STORAGE_ACCESS_KEY_ID"),
        secretAccessKey: config.get<string>("STORAGE_SECRET_ACCESS_KEY"),
        forcePathStyle: true,
        keyPrefix: config.get<string>("STORAGE_KEY_PREFIX"),
      }),
    }),
  ],
})
export class FilesModule {}
```

`SharedStorageModule.forRoot(options)` takes the same options directly. The module creates no bucket: create it beforehand.

### 3. Store and Serve Objects

```typescript
import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common"
import { StorageService } from "@lyrolab/nest-shared/storage"
import { Response } from "express"
import { pipeline } from "stream/promises"

@Controller("files")
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  async save(id: string, bytes: Buffer) {
    await this.storage.put(`files/${id}`, bytes, { contentType: "image/webp" })
  }

  @Get(":id")
  async read(@Param("id") id: string, @Res() res: Response) {
    const object = await this.storage.get(`files/${id}`)
    if (!object) throw new NotFoundException()
    res.set({
      "Content-Type": object.contentType,
      "Content-Length": String(object.contentLength),
    })
    await pipeline(object.body, res)
  }
}
```

Read a returned `body` to the end or destroy it: an S3 body left unread keeps its connection open.

### 4. Test with the In-Memory Implementation

```typescript
import { Test } from "@nestjs/testing"
import {
  InMemoryStorageService,
  SharedStorageModule,
} from "@lyrolab/nest-shared/storage"

const moduleRef = await Test.createTestingModule({
  imports: [FilesModule],
})
  .overrideModule(SharedStorageModule)
  .useModule(SharedStorageModule.forTest())
  .compile()

const memory = moduleRef.get(InMemoryStorageService)
// ... exercise the code under test
expect(memory.objects.get("files/1")?.contentType).toBe("image/webp")
```

`forTest()` provides `InMemoryStorageService` under the `StorageService` token. It follows the S3 implementation's behaviour: the same key rules, a copy of the stored bytes, `null` for a missing object and an idempotent delete. `objects` maps each key to its bytes, content type, last modification and ETag. It ignores `keyPrefix`.

## Configuration

| Option            | Type      | Required | Description                                                                         |
| ----------------- | --------- | :------: | ----------------------------------------------------------------------------------- |
| `endpoint`        | `string`  |    —     | URL of an S3-compatible server; omit for AWS S3                                     |
| `region`          | `string`  |    ✅    | Region of the bucket (any value an S3-compatible server accepts, e.g. `us-east-1`)  |
| `bucket`          | `string`  |    ✅    | Bucket holding the objects                                                          |
| `accessKeyId`     | `string`  |    —     | Static access key; set it with `secretAccessKey`, or neither to use the SDK's chain |
| `secretAccessKey` | `string`  |    —     | Static secret key                                                                   |
| `forcePathStyle`  | `boolean` |    —     | Addresses objects as `endpoint/bucket/key`, which most S3-compatible servers need   |
| `keyPrefix`       | `string`  |    —     | Every key is stored as `<keyPrefix>/<key>`; a trailing `/` is ignored               |

Keys are non-empty strings that do not start with `/` and have no `.` or `..` segment; any other key throws `InvalidStorageKeyError`.

On AWS S3, grant the credentials `s3:ListBucket` on the bucket besides `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject`: without it S3 answers a missing key with 403 instead of 404, and `get` and `exists` throw instead of reporting it missing.

## Key Exports

| Export                   | Type           | Description                                                                       |
| ------------------------ | -------------- | --------------------------------------------------------------------------------- |
| `SharedStorageModule`    | class          | Dynamic module with `forRoot()` / `forRootAsync()` / `forTest()`                  |
| `StorageService`         | abstract class | The port and its injection token: `put`, `get`, `delete`, `exists`                |
| `InMemoryStorageService` | class          | In-memory implementation provided by `forTest()`                                  |
| `StoredObject`           | interface      | `{ body; contentType; contentLength; lastModified?; etag? }`                      |
| `StorageOptions`         | interface      | Module options                                                                    |
| `InvalidStorageKeyError` | class          | Thrown for an empty key, one starting with `/`, or one with a `.` or `..` segment |
| `STORAGE_OPTIONS`        | token          | Injection token for the options                                                   |

## Development

`storage.spec.ts` runs the same suite against `forTest()` and against an S3-compatible server (SeaweedFS) started with Testcontainers, as part of `npm test`, so the suite needs a running Docker daemon.
