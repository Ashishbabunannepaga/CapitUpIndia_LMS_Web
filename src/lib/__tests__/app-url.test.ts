import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicUrl, workersDevRedirect } from "../app-url";

const WORKER = "https://capitup-lms-web.example.workers.dev";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.BETTER_AUTH_URL;
  process.env.BETTER_AUTH_URL = "https://lms.capitupindia.com";
});
afterEach(() => {
  if (saved === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = saved;
});

describe("publicUrl", () => {
  it("builds redirects on the public address, not the Host the Worker saw", () => {
    expect(publicUrl("/login?next=%2Fleads", `${WORKER}/leads`).href).toBe("https://lms.capitupindia.com/login?next=%2Fleads");
  });

  it("falls back to the request's own address when none is set", () => {
    delete process.env.BETTER_AUTH_URL;
    expect(publicUrl("/login", "http://localhost:3000/leads").href).toBe("http://localhost:3000/login");
  });
});

describe("workersDevRedirect", () => {
  it("moves a direct workers.dev visit to the same page on the public address", () => {
    expect(workersDevRedirect("GET", `${WORKER}/leads/1?tab=notes`, new Headers())?.href).toBe(
      "https://lms.capitupindia.com/leads/1?tab=notes",
    );
  });

  it("leaves requests that came through CloudFront alone", () => {
    expect(workersDevRedirect("GET", `${WORKER}/login`, new Headers({ "x-amz-cf-id": "abc" }))).toBeNull();
  });

  it("lets form posts and other hosts through", () => {
    expect(workersDevRedirect("POST", `${WORKER}/login`, new Headers())).toBeNull();
    expect(workersDevRedirect("GET", "http://localhost:3000/login", new Headers())).toBeNull();
    delete process.env.BETTER_AUTH_URL;
    expect(workersDevRedirect("GET", `${WORKER}/login`, new Headers())).toBeNull();
  });
});
