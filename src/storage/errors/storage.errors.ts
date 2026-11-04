export class InvalidStorageKeyError extends Error {
  constructor(readonly key: unknown) {
    super("Storage keys must be non-empty strings that do not start with /")
    this.name = new.target.name
  }
}
