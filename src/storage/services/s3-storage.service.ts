import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"
import { OnModuleDestroy } from "@nestjs/common"
import { Readable } from "stream"
import { StorageOptions } from "../interfaces/storage-options.interface"
import {
  assertStorageKey,
  StorageBody,
  StoragePutOptions,
  StoredObject,
  StorageService,
} from "./storage.service"

const DEFAULT_CONTENT_TYPE = "application/octet-stream"

export class S3StorageService
  extends StorageService
  implements OnModuleDestroy
{
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string

  constructor(options: StorageOptions) {
    super()
    const { accessKeyId, secretAccessKey } = options
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new Error(
        "SharedStorageModule: set both accessKeyId and secretAccessKey, or neither",
      )
    }
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials:
        accessKeyId && secretAccessKey
          ? { accessKeyId, secretAccessKey }
          : undefined,
      // The SDK's default flexible checksums are refused by several
      // S3-compatible servers; plain S3 does not need them either.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    })
    this.bucket = options.bucket
    const prefix = options.keyPrefix?.replace(/\/+$/, "") ?? ""
    this.prefix = prefix === "" ? "" : `${prefix}/`
  }

  async put(
    key: string,
    body: StorageBody,
    { contentType }: StoragePutOptions,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
        Body: body,
        ContentType: contentType,
      }),
    )
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      )
      if (!(response.Body instanceof Readable)) {
        throw new Error("S3 returned an object without a readable body")
      }
      return {
        body: response.Body,
        contentType: response.ContentType ?? DEFAULT_CONTENT_TYPE,
        contentLength: response.ContentLength ?? 0,
        lastModified: response.LastModified,
        etag: response.ETag,
      }
    } catch (error) {
      if (error instanceof S3ServiceException && error.name === "NoSuchKey") {
        return null
      }
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }),
    )
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      )
      return true
    } catch (error) {
      // HEAD answers have no body, so a missing bucket also reads as NotFound.
      if (error instanceof S3ServiceException && error.name === "NotFound") {
        return false
      }
      throw error
    }
  }

  onModuleDestroy(): void {
    this.client.destroy()
  }

  private objectKey(key: string): string {
    assertStorageKey(key)
    return `${this.prefix}${key}`
  }
}
