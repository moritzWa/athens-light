import { resolve } from "node:path";
import { verifySignatureIdentity } from "./macos-signature";
import config from "../src-tauri/tauri.conf.json";

const bundle = resolve(import.meta.dir, "../src-tauri/target/release/bundle/macos/Athens Light.app");
function codesign(args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/codesign", ...args, bundle]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString() + result.stderr.toString();
}
codesign(["--verify", "--deep", "--strict"]);
verifySignatureIdentity(codesign(["--display", "--verbose=4"]), codesign(["--display", "--requirements", "-"]), config.identifier);
console.log("Verified stable macOS signing identity. Folder consent can survive app updates.");
