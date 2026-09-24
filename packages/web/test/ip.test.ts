// Covers how a caller's address becomes a rate-limit bucket; does not cover hashing or the rate limiter itself.
import { describe, expect, it } from "vitest";
import { clientIp } from "../lib/ip";

const from = (value: string) => clientIp(new Headers({ "x-real-ip": value }));

describe("clientIp buckets", () => {
  it("keeps an IPv4 address as is", () => {
    expect(from("203.0.113.9")).toBe("203.0.113.9");
  });

  it("puts every address in one IPv6 /64 into one bucket", () => {
    const a = from("2001:db8:1:2::1");
    const b = from("2001:0db8:0001:0002:ffff:ffff:ffff:ffff");
    const c = from("2001:DB8:1:2:aaaa::7");
    expect(a).toBe("2001:0db8:0001:0002::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("separates different /64 prefixes", () => {
    expect(from("2001:db8:1:3::1")).not.toBe(from("2001:db8:1:2::1"));
  });

  it("handles leading ::, a zone id and an embedded IPv4 tail", () => {
    expect(from("::1")).toBe("0000:0000:0000:0000::/64");
    expect(from("fe80::1%eth0")).toBe(from("fe80::2"));
    expect(from("64:ff9b::192.0.2.33")).toBe("0064:ff9b:0000:0000::/64");
  });

  it("buckets an IPv4-mapped address as its IPv4 form", () => {
    expect(from("::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  it("treats a malformed value as unknown", () => {
    expect(from("not-an-ip")).toBe("unknown");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
