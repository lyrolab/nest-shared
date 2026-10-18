import { normalizeIp } from "@nestjs/throttler"
import { Request } from "express"

export function clientIp(request: Request, header?: string): string {
  const fromHeader = header ? request.headers[header.toLowerCase()] : undefined
  const raw = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader
  const forwarded = raw?.split(",")[0]?.trim()
  const ip = forwarded || request.ip || request.socket?.remoteAddress || ""
  return ip ? normalizeIp(ip) : "unknown"
}
