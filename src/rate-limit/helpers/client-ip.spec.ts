import { Request } from "express"
import { clientIp } from "./client-ip"

const makeRequest = (
  headers: Record<string, string | string[]> = {},
  ip?: string,
) =>
  ({ headers, ip, socket: { remoteAddress: "10.0.0.9" } }) as unknown as Request

describe("clientIp", () => {
  it("uses request.ip without a configured header", () => {
    expect(
      clientIp(makeRequest({ "cf-connecting-ip": "1.1.1.1" }, "2.2.2.2")),
    ).toBe("2.2.2.2")
  })

  it("reads the configured header, case-insensitively", () => {
    expect(
      clientIp(
        makeRequest({ "cf-connecting-ip": "1.1.1.1" }, "2.2.2.2"),
        "CF-Connecting-IP",
      ),
    ).toBe("1.1.1.1")
  })

  it("takes the first address of a list-valued header", () => {
    expect(
      clientIp(makeRequest({ "x-real-ip": "1.1.1.1, 3.3.3.3" }), "x-real-ip"),
    ).toBe("1.1.1.1")
  })

  it("falls back to request.ip when the header is missing", () => {
    expect(clientIp(makeRequest({}, "2.2.2.2"), "cf-connecting-ip")).toBe(
      "2.2.2.2",
    )
  })

  it("falls back to the socket address without request.ip", () => {
    expect(clientIp(makeRequest())).toBe("10.0.0.9")
  })

  it("groups IPv6 addresses by /64 subnet", () => {
    expect(clientIp(makeRequest({}, "2001:db8:1:2:aaaa::1"))).toBe(
      clientIp(makeRequest({}, "2001:db8:1:2:bbbb::2")),
    )
  })
})
