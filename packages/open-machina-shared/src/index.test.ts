import { test, expect } from "bun:test"
import { brand } from "./index"

test("brand() returns stable identifier", () => {
  expect(brand()).toBe("open-machina")
})
