import { parseCorsOrigins } from "./cors-origins"

describe("parseCorsOrigins", () => {
  it("returns a single-element array for one origin", () => {
    expect(parseCorsOrigins("http://localhost:4781")).toEqual([
      "http://localhost:4781",
    ])
  })

  it("splits a comma list and trims surrounding whitespace", () => {
    expect(
      parseCorsOrigins(" http://localhost:4781 , http://127.0.0.1:4781 "),
    ).toEqual(["http://localhost:4781", "http://127.0.0.1:4781"])
  })

  it("returns an empty array for an empty string", () => {
    expect(parseCorsOrigins("")).toEqual([])
  })

  it("returns an empty array for undefined", () => {
    expect(parseCorsOrigins(undefined)).toEqual([])
  })

  it("drops trailing commas and blank segments", () => {
    expect(
      parseCorsOrigins("http://localhost:4781,,http://127.0.0.1:4781,"),
    ).toEqual(["http://localhost:4781", "http://127.0.0.1:4781"])
  })
})
