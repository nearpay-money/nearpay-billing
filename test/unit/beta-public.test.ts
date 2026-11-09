/** Public beta (Cloudflare → cloudflared → Traefik): hosted-invoice client network and server-stage origins. */
import { describe, expect, it } from "vitest";
import { clientNetwork } from "../../src/api/routes.js";
import { checkServerConfig } from "../../src/config.js";
import { clientIpRule } from "../../src/domain/client-ip.js";

describe("hosted-invoice client network", () => {
  const server = clientIpRule("server");
  const local = clientIpRule("local");
  it("server: CF-Connecting-IP from a trusted proxy peer; X-Forwarded-For never counts", () => {
    expect(clientNetwork(server, { peer: "172.18.0.4", cfConnectingIp: "203.0.113.7", xForwardedFor: "6.6.6.6" })).toBe(
      "203.0.113.0/24",
    );
    expect(clientNetwork(server, { peer: "172.18.0.4", xForwardedFor: "6.6.6.6" })).toBe("unknown");
    expect(clientNetwork(server, { peer: "172.18.0.4", cfConnectingIp: "2001:db8:1:2:3::9" })).toBe(
      "2001:db8:1:2::/64",
    );
  });
  it("a direct (untrusted) peer is the client, whatever it claims", () => {
    expect(clientNetwork(server, { peer: "198.51.100.9", cfConnectingIp: "203.0.113.7" })).toBe("198.51.100.0/24");
  });
  it("local: the rightmost untrusted hop (a forged leftmost hop cannot rotate the limiter key)", () => {
    expect(clientNetwork(local, { peer: "127.0.0.1", xForwardedFor: "1.1.1.1, 203.0.113.7, 172.18.0.3" })).toBe(
      "203.0.113.0/24",
    );
  });
});

describe("server-stage origins", () => {
  const ok = {
    env: "server" as const,
    payOrigin: "https://pay.nearpay.money",
    apiOrigin: "https://api.nearpay.money",
    clientIpHeader: undefined,
    trustedProxies: undefined,
  };
  it("accepts public https origins, and localhost defaults on local/test", () => {
    expect(checkServerConfig(ok)).toBe(ok);
    expect(() => checkServerConfig({ ...ok, env: "test", payOrigin: "https://pay.nearpay.localhost" })).not.toThrow();
  });
  it("refuses localhost or http origins and a bad proxy list", () => {
    expect(() => checkServerConfig({ ...ok, payOrigin: "https://pay.nearpay.localhost" })).toThrow(/NP_PAY_ORIGIN/);
    expect(() => checkServerConfig({ ...ok, apiOrigin: "http://api.nearpay.money" })).toThrow(/NP_API_ORIGIN/);
    expect(() => checkServerConfig({ ...ok, trustedProxies: ["nope"] })).toThrow(/NP_TRUSTED_PROXIES/);
  });
});
