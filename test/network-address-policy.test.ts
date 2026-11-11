import assert from "node:assert/strict";
import test from "node:test";

import {
  isBlockedAddress,
  isBlockedHostname,
} from "../src/security/network-address-policy.js";

test("blocks loopback, private, link-local, and unspecified addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "127.8.8.8",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.1.1",
    "0.0.0.0",
    "::",
    "::1",
    "fe80::1",
    "fd00::1",
    "fc00::1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `expected ${ip} to be blocked`);
  }
});

test("allows public addresses", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "172.15.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ]) {
    assert.equal(isBlockedAddress(ip), false, `expected ${ip} to be allowed`);
  }
});

test("blocks unknown/non-IP values", () => {
  assert.equal(isBlockedAddress("not-an-ip"), true);
  assert.equal(isBlockedAddress(""), true);
});

test("blocks IPv4-mapped IPv6 addresses by their IPv4 part", () => {
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:192.168.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

test("blocks localhost and .local hostnames", () => {
  for (const host of [
    "localhost",
    "sub.localhost",
    "example.local",
    "a.b.c.local",
    "",
  ]) {
    assert.equal(isBlockedHostname(host), true, `expected ${host} blocked`);
  }
});

test("blocks literal IP hostnames", () => {
  assert.equal(isBlockedHostname("127.0.0.1"), true);
  assert.equal(isBlockedHostname("10.0.0.1"), true);
  assert.equal(isBlockedHostname("::1"), true);
  assert.equal(isBlockedHostname("8.8.8.8"), false);
});

test("allows ordinary public hostnames", () => {
  assert.equal(isBlockedHostname("example.com"), false);
  assert.equal(isBlockedHostname("nodejs.org"), false);
});
