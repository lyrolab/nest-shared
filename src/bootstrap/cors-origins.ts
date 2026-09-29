export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}
