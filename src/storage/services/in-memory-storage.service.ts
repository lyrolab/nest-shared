import { Injectable } from "@nestjs/common"
import { createHash } from "crypto"
import { Readable } from "stream"
import {
  assertStorageKey,
  StorageBody,
  StoragePutOptions,
  StoredObject,
  StorageService,
} from "./storage.service"

export interface InMemoryStoredObject {
  body: Buffer
  contentType: string
  lastModified: Date
  etag: string
}

/**
 * In-memory {@link StorageService}, provided by `SharedStorageModule.forTest()`.
 * `objects` holds what was stored, by key.
 */
@Injectable()
export class InMemoryStorageService extends StorageService {
  readonly objects = new Map<string, InMemoryStoredObject>()

  put(
    key: string,
    body: StorageBody,
    { contentType }: StoragePutOptions,
  ): Promise<void> {
    return settle(() => {
      assertStorageKey(key)
      const bytes =
        typeof body === "string" ? Buffer.from(body) : Buffer.from(body)
      this.objects.set(key, {
        body: bytes,
        contentType,
        lastModified: new Date(),
        etag: `"${createHash("md5").update(bytes).digest("hex")}"`,
      })
    })
  }

  get(key: string): Promise<StoredObject | null> {
    return settle(() => {
      assertStorageKey(key)
      const object = this.objects.get(key)
      if (!object) return null
      return {
        body: Readable.from([Buffer.from(object.body)]),
        contentType: object.contentType,
        contentLength: object.body.length,
        lastModified: object.lastModified,
        etag: object.etag,
      }
    })
  }

  delete(key: string): Promise<void> {
    return settle(() => {
      assertStorageKey(key)
      this.objects.delete(key)
    })
  }

  exists(key: string): Promise<boolean> {
    return settle(() => {
      assertStorageKey(key)
      return this.objects.has(key)
    })
  }
}

function settle<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation())
  } catch (error) {
    return Promise.reject(error as Error)
  }
}
