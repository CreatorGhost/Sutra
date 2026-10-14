import { describe, expect, it } from "vitest";
import { isValidHostId, parseRelayPath, routeRequest } from "../src/routing.ts";

const ws = { method: "GET", upgrade: "websocket", hostAuthorized: false };

describe("isValidHostId", () => {
  it("accepts 1–64 characters of base64url", () => {
    for (const id of ["a", "Z9", "abc-DEF_123", "x".repeat(64), "-_-"]) expect(isValidHostId(id)).toBe(true);
  });
  it("rejects empty, too long and anything outside [A-Za-z0-9_-]", () => {
    for (const id of ["", "x".repeat(65), "a.b", "a b", "a/b", "a%20b", "é", "a+b", "a=", "a\n"]) expect(isValidHostId(id)).toBe(false);
  });
});

describe("parseRelayPath", () => {
  it("splits role and host id", () => {
    expect(parseRelayPath("/host/mac_1")).toEqual({ role: "host", hostId: "mac_1" });
    expect(parseRelayPath("/phone/mac_1")).toEqual({ role: "phone", hostId: "mac_1" });
  });
  it("rejects other shapes", () => {
    for (const p of ["/", "/host", "/host/", "/host/a/b", "/phones/a", "/host/a.b", "//host/a"]) expect(parseRelayPath(p)).toBeNull();
  });
});

describe("routeRequest", () => {
  it("serves health on GET / (and HEAD), 405 for other methods", () => {
    expect(routeRequest({ ...ws, pathname: "/", upgrade: null })).toEqual({ kind: "health" });
    expect(routeRequest({ ...ws, method: "HEAD", pathname: "/", upgrade: null })).toEqual({ kind: "health" });
    expect(routeRequest({ ...ws, method: "POST", pathname: "/", upgrade: null })).toEqual({ kind: "reject", status: 405 });
  });

  it("connects an authorized host upgrade", () => {
    expect(routeRequest({ ...ws, pathname: "/host/m1", hostAuthorized: true })).toEqual({ kind: "connect", role: "host", hostId: "m1" });
    expect(routeRequest({ ...ws, pathname: "/host/m1", upgrade: "WebSocket", hostAuthorized: true })).toEqual({ kind: "connect", role: "host", hostId: "m1" });
  });

  it("401s a host without the secret, before checking the upgrade", () => {
    expect(routeRequest({ ...ws, pathname: "/host/m1" })).toEqual({ kind: "reject", status: 401 });
    expect(routeRequest({ ...ws, pathname: "/host/m1", upgrade: null })).toEqual({ kind: "reject", status: 401 });
  });

  it("426s an authorized host or a phone that isn't a WebSocket upgrade", () => {
    expect(routeRequest({ ...ws, pathname: "/host/m1", upgrade: null, hostAuthorized: true })).toEqual({ kind: "reject", status: 426 });
    expect(routeRequest({ ...ws, pathname: "/phone/m1", upgrade: null })).toEqual({ kind: "reject", status: 426 });
    expect(routeRequest({ ...ws, pathname: "/phone/m1", upgrade: "h2c" })).toEqual({ kind: "reject", status: 426 });
  });

  it("connects a phone without any secret", () => {
    expect(routeRequest({ ...ws, pathname: "/phone/m1" })).toEqual({ kind: "connect", role: "phone", hostId: "m1" });
  });

  it("400s a bad host id and 404s unknown paths", () => {
    expect(routeRequest({ ...ws, pathname: "/phone/a.b" })).toEqual({ kind: "reject", status: 400 });
    expect(routeRequest({ ...ws, pathname: "/host/" + "x".repeat(65), hostAuthorized: true })).toEqual({ kind: "reject", status: 400 });
    expect(routeRequest({ ...ws, pathname: "/phone/" })).toEqual({ kind: "reject", status: 400 });
    for (const pathname of ["/nope", "/host", "/host/a/b", "/favicon.ico", "/phone/a/"]) {
      expect(routeRequest({ ...ws, pathname })).toEqual({ kind: "reject", status: 404 });
    }
  });

  it("405s a non-GET connect", () => {
    expect(routeRequest({ ...ws, method: "POST", pathname: "/phone/m1" })).toEqual({ kind: "reject", status: 405 });
  });
});
