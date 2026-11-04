import { Readable } from "stream"
import { InvalidStorageKeyError } from "../errors/storage.errors"

export type StorageBody = Uint8Array | string

export interface StoragePutOptions {
  contentType: string
}

export interface StoredObjectMetadata {
  contentType: string
  contentLength: number
  lastModified?: Date
  etag?: string
}

export interface StoredObject extends StoredObjectMetadata {
  /** Read it to the end or destroy it: an unread S3 body holds its connection. */
  body: Readable
}

/**
 * Object storage port. Inject it as `StorageService`; `SharedStorageModule`
 * provides the S3 implementation or, with `forTest()`, an in-memory one.
 */
export abstract class StorageService {
  /** Stores `body` under `key`, replacing any object already there. */
  abstract put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions,
  ): Promise<void>

  /** Opens the object under `key`, or returns `null` when there is none. */
  abstract get(key: string): Promise<StoredObject | null>

  /** Deletes the object under `key`; a missing object is not an error. */
  abstract delete(key: string): Promise<void>

  abstract exists(key: string): Promise<boolean>
}

export function assertStorageKey(key: string): void {
  if (typeof key !== "string" || key === "" || key.startsWith("/")) {
    throw new InvalidStorageKeyError(key)
  }
}
