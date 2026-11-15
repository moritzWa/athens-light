# Remembering macOS folder consent

## Finding

The installed app was ad-hoc signed. `codesign -dvvv -r- '/Applications/Athens Light.app'` reported `Signature=adhoc`, no team identifier, and a designated requirement consisting only of `cdhash H"…"`. Each changed build has a new hash, so macOS cannot associate it with the previous app's privacy consent. Images can trigger the Documents-folder prompt because opening a Markdown file does not necessarily authorize reading adjacent files.

This explains repeated consent after local rebuilds, not necessarily repeated launches of an identical binary. Do not reset TCC or broaden access to diagnose it. If an unchanged, correctly signed build still prompts, inspect TCC attribution before adding a workaround.

The host's TCC log confirms the diagnosis. On 2026-11-15 at 02:32:37 it recorded `Failed to match existing code requirement for subject com.moritz.athenslight and service kTCCServiceSystemPolicyDocumentsFolder`, compared two different `cdhash` requirements, then recorded `AUTHREQ_PROMPTING` for Documents. This is not a missing bookmark or a WebKit process losing its own grant.

## Other editors

| Editor | Document / image model | Implication for Athens Light |
| --- | --- | --- |
| VS Code | Opens ordinary files and workspace folders. Its installed Mac app is Developer ID signed by Microsoft; its designated requirement uses the bundle identifier and signing team, not the executable hash. | Keep a stable app identity so macOS can remember consent. A workspace is not required for a single-file editor. |
| Obsidian | Users explicitly choose a folder as a vault. Notes and attachments live in that filesystem tree. | Folder selection is natural for a vault, but requiring one changes Athens Light's double-click-to-edit workflow. |
| Typora | Resolves local images relative to the Markdown document and can copy inserted images to a chosen folder. | Keep relative image references and adjacent assets rather than importing the whole document into private storage. |
| Bear | Stores notes in a SQLite database in its app group container, with managed attachments. | Private storage avoids repeatedly reading arbitrary external folders, but importing notes would abandon Athens Light's plain-file model. |

These are documented storage/workflow comparisons, not claims about undocumented bookmark implementations in closed-source apps.

## Decision

Use the existing Developer ID Application certificate for every installable macOS build. The Tauri configuration pins the signing identity, and `bun run build:mac` rejects unsigned, ad-hoc or hash-pinned signatures. A missing certificate is an error, not a silent downgrade. The app's identifier, filesystem behavior and document-relative asset scope stay unchanged.

- **Full Disk Access:** excessive for editing user-selected Markdown and its images. It also depends on a stable signing identity, so it would not address the underlying update problem.
- **Security-scoped bookmarks:** appropriate for retaining explicit file/folder grants in a sandboxed app. Athens Light is not App Sandbox enabled. Bookmarking the selected Markdown file does not authorize sibling images; obtaining a folder grant requires another picker. Bookmarks do not repair a changing TCC code identity.
- **Image cache:** adds invalidation and stale-image problems and still needs permission for first reads and changed images.
- **Stable signing:** fixes the observed identity problem without a new dialog, database, permission UI or broader filesystem entitlement. Existing users may need to approve Documents once after the identity migration. Deliberately revoked consent stays revoked.

## Sources

- [Apple TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements), especially designated requirements and ad-hoc rebuilds.
- [Apple TN2206: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html), identity tracking through designated requirements.
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), `signingIdentity` and `APPLE_SIGNING_IDENTITY`.
- [VS Code on macOS](https://code.visualstudio.com/docs/setup/mac). Signature comparison was also checked against the installed app with `codesign`.
- [Obsidian: Manage vaults](https://help.obsidian.md/manage-vaults) and [How Obsidian stores data](https://help.obsidian.md/data-storage).
- [Typora: Images](https://support.typora.io/Images/).
- [Bear: Where notes are located](https://bear.app/faq/where-are-bears-notes-located/).

## Verification

- All 32 Bun regression tests and the native image-import test passed. TypeScript checking passed.
- The macOS bundle built with Developer ID team `74NH893Z4B` and passed strict signature validation.
- `test:mac-signing` changed the version of a temporary bundle copy, re-signed it, confirmed its code hash changed, and verified that it still satisfied the original build's designated requirement. No user files or app launches are involved in that regression test.
- Installed the signed bundle and reopened the previously open document after a graceful save and close. The running executable's inode and installed/build hashes were checked. TCC logged the expected one-time migration from the old hash-only identity to the Developer ID requirement.
- A separate VM launch test was not run. The signature-continuity test checks the identity mismatch that the host TCC log identified as the cause.
