export class InvalidStorageKeyError extends Error {
  constructor(readonly key: unknown) {
    super(
      "Storage keys must be non-empty, must not start with / and must not contain . or .. segments",
    )
    this.name = new.target.name
  }
}
