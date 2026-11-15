# Athens Light

<p align="center"><img src="docs/screenshot.png" alt="Athens Light editing a note with a heading, a task list, a table and a quote" width="760"></p>

A tiny WYSIWYG markdown editor for macOS. Open a `.md` file, edit it as rich text, and it saves back to the same file. No vaults, no sync, no toolbar.

Website and comparison of Mac markdown editors: **[athens-light.app](https://athens-light.app)**

Athens Light is the minimalist version of [Athens](https://tryathens.com), the AI writing editor I built earlier.

Built with [Tauri](https://tauri.app) (Rust) and [Tiptap](https://tiptap.dev). The app is about 3 MB.

## Features

- Double-click a `.md` file to edit it as rich text, with markdown shortcuts (`# `, `**bold**`, `- `, and so on)
- Native macOS tabs: every file opens as a tab
- Auto-saves to the file as you type
- Reloads a file when something else changes it
- Cmd+N creates a new markdown file, Cmd+O opens one, and clicking the title renames the file
- Cmd+K copies the active file's full path to the clipboard
- HTML comments appear as margin cards. Edit or delete a card, or select text and use “+ Comment” to add one. Comments stay in the Markdown file, with no separate database.
- Footnotes show numbered references and editable notes. Click a reference to jump to its note, or select text and use “+ Footnote” to add one. Named labels and multiline notes stay in standard Markdown.
- Click a link to open it. Hover for a small destination preview with Copy and Edit actions.
- Front matter, images, task lists and tables survive editing; files with other raw HTML open read-only
- Light and dark mode follow the system
- Remembers the last document window's position and size across launches
- Publishes the filename and file URL through macOS window metadata (`AXTitle` and `AXDocument`), so tools like Cronus can identify the active document, including after a rename

## Caveat

Your first edit to a file rewrites it in the editor's markdown style, which can change bullet characters or spacing. Opening a file without editing it never rewrites it. Files that contain raw HTML (other than comments) open read-only, because the editor cannot write it back faithfully. Comments refer to their paragraph, not a tracked text range; they do not include authors, replies or resolved states.

## Build

You need Rust, [Bun](https://bun.sh), and Xcode command line tools.

```sh
bun install
bunx tauri build --bundles app
```

The app ends up in `src-tauri/target/release/bundle/macos/Athens Light.app`. Copy it to `/Applications`.

To make it the default for `.md` files, use Finder (Get Info, Open with, Change All) or [`duti`](https://github.com/moretension/duti):

```sh
duti -s com.moritz.athenslight net.daringfireball.markdown all
```

## Develop

```sh
bunx tauri dev
```

## Tests

Run regression tests with `bun test`. The browser check, `bun run test:browser`, uses headless Chromium. Install it first with `bunx playwright install chromium`.

## License

MIT
