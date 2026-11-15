import { expect, test } from "bun:test";
import { verifySignatureIdentity } from "./macos-signature";
import config from "../src-tauri/tauri.conf.json";

const id = config.identifier;
const signed = `Identifier=${id}\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABC1234567\n`;
const stable = `designated => identifier "${id}" and anchor apple generic and certificate leaf[subject.OU] = ABC1234567`;

test("macOS bundles default to a persistent Developer ID, not ad-hoc signing", () => {
  expect(config.bundle.macOS.signingIdentity).toStartWith("Developer ID Application:");
});
test("accepts a stable identity across different binary hashes", () => {
  for (const hash of ["aaaa", "bbbb"]) {
    expect(() => verifySignatureIdentity(`${signed}CDHash=${hash}\n`, stable, id)).not.toThrow();
  }
});
test("rejects ad-hoc signing even with the correct bundle ID", () => {
  expect(() => verifySignatureIdentity(`Identifier=${id}\nSignature=adhoc\nTeamIdentifier=not set\n`, 'designated => cdhash H"aaaa"', id)).toThrow("Ad-hoc");
});
test("rejects missing team, wrong identifier and build-pinned requirements", () => {
  expect(() => verifySignatureIdentity(`Identifier=${id}\n`, stable, id)).toThrow("team");
  expect(() => verifySignatureIdentity(signed, stable, "another.app")).toThrow("identifier");
  expect(() => verifySignatureIdentity(signed, `${stable} and cdhash H"aaaa"`, id)).toThrow("one build");
  expect(() => verifySignatureIdentity(signed, `identifier "${id}"`, id)).toThrow("stable");
});
