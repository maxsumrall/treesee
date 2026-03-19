# treesee

See the shape of a Pi session at a glance.

`treesee` turns a branched Pi conversation into a local HTML tree view, so you can quickly understand:

- what branches exist
- which branch is currently active
- what each branch was trying to do
- how big each branch got

![treesee example](./docs/treesee-example.png)

## Why it’s useful

Once a session has been forked a few times, the linear transcript stops being a good overview. `treesee` is for the moment when you want to zoom out and answer:

- Which path actually worked?
- What side quests happened?
- Where did the conversation split?
- Which branches are worth reopening?

## Install

```bash
pi install git:github.com/maxsumrall/treesee
/reload
```

## Usage

```text
/treesee                       # current session
/treesee open                  # choose from available sessions
/treesee /path/to/session.jsonl
```

## What you get

Each branch is shown as a card in a top-down tree.

You’ll see:

- active leaf and active path highlighting
- short branch titles
- turns, tool calls, word count, and duration
- hover details for deeper inspection

Branch titles use your current Pi model when available, and fall back to heuristics otherwise. Generated titles are cached locally.

## Notes

- Opens as a local HTML file.
- Requires interactive Pi mode.
- Works on the current session, a chosen session, or an explicit session file.

## License

MIT
