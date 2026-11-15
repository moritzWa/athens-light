// Native, data-level regression: no app windows, privacy prompts or user files.
// Change a bundle, sign it again, and ask Security.framework (via codesign) if
// it still satisfies the identity against which the original consent was saved.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import config from "../src-tauri/tauri.conf.json";
import { verifySignatureIdentity } from "./macos-signature";

function run(command: string[]) {
  const result = Bun.spawnSync(command);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString() + result.stderr.toString();
}
const source = resolve(import.meta.dir, "../src-tauri/target/release/bundle/macos/Athens Light.app");
const originalRequirement = run(["codesign", "-d", "-r-", source]);
verifySignatureIdentity(run(["codesign", "-dvv", source]), originalRequirement, config.identifier);
const requirement = originalRequirement.match(/^designated => (.+)$/m)?.[1];
if (!requirement) throw new Error("No designated requirement");
const originalHash = run(["codesign", "-dvvv", source]).match(/^CDHash=(.+)$/m)?.[1];
const temp = mkdtempSync(join(tmpdir(), "athens-signing-test-"));
try {
  const updated = join(temp, "Athens Light.app");
  cpSync(source, updated, { recursive: true });
  run(["/usr/libexec/PlistBuddy", "-c", "Set :CFBundleVersion 999.0.0", join(updated, "Contents/Info.plist")]);
  run(["codesign", "--force", "--timestamp=none", "--sign", process.env.APPLE_SIGNING_IDENTITY || config.bundle.macOS.signingIdentity, updated]);
  const updatedDetails = run(["codesign", "-dvvv", updated]);
  const updatedHash = updatedDetails.match(/^CDHash=(.+)$/m)?.[1];
  if (!originalHash || !updatedHash || originalHash === updatedHash) throw new Error("Test did not change the build hash");
  run(["codesign", "--verify", "--deep", "--strict", `-R=${requirement}`, updated]);
  console.log("PASS: a changed, re-signed bundle satisfies the original consent identity.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
