export class RedisConfig {
  constructor(
    public readonly url: string,
    public readonly keyPrefix?: string,
  ) {}
}
