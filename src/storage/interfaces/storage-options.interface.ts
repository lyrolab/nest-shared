import { ModuleMetadata } from "@nestjs/common"

export interface StorageOptions {
  /** URL of an S3-compatible server. Omit for AWS S3. */
  endpoint?: string
  region: string
  bucket: string
  /** Static credentials; omit both to use the AWS SDK's default provider chain. */
  accessKeyId?: string
  secretAccessKey?: string
  /** Addresses objects as `endpoint/bucket/key`, which most S3-compatible servers need. */
  forcePathStyle?: boolean
  /** Prepended to every key as `<keyPrefix>/<key>`, to share one bucket between apps or environments. */
  keyPrefix?: string
}

export interface StorageAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  useFactory: (...args: any[]) => Promise<StorageOptions> | StorageOptions
  inject?: any[]
}
