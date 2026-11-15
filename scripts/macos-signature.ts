// TCC remembers consent against the designated requirement, not just the bundle
// identifier. An ad-hoc requirement pins a particular build's CodeDirectory hash.
export function verifySignatureIdentity(details: string, requirement: string, identifier: string) {
  if (!details.includes(`Identifier=${identifier}\n`)) throw new Error("Unexpected app identifier");
  if (/Signature=adhoc|TeamIdentifier=not set/.test(details)) throw new Error("Ad-hoc signing loses folder consent across rebuilds");
  if (!/^TeamIdentifier=[A-Z0-9]+$/m.test(details)) throw new Error("Missing Apple signing team");
  if (!requirement.includes(`identifier "${identifier}"`) || !requirement.includes("anchor apple")) {
    throw new Error("Missing stable Apple-signed designated requirement");
  }
  if (/\bcdhash\b/.test(requirement)) throw new Error("Designated requirement is pinned to one build");
}
