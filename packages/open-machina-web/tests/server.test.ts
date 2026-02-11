import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import server from "../src/server";

const BASE_URL = `http://localhost:${server.port}`;

describe("Machina Web Server", () => {
  test("GET /health returns status ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ status: "ok" });
  });

  test("GET / returns index.html", async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<title>Machina Local Web UI</title>");
  });

  test("GET /style.css returns css", async () => {
    const res = await fetch(`${BASE_URL}/style.css`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("--machina-accent");
  });
});
