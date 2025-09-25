# cczip - Claude Context Compressor

Never hit Claude's context limit again. Intelligently compress conversation history with one command.

## Installation

```bash
npm install -g cczip
```

## Quick Start

```bash
# Check your current usage
cczip --context

# Compress by 50% (default)
cczip

# That's it! Your conversation is optimized.
```

## Common Usage Patterns

### Managing Multiple Sessions

```bash
# List all available chat sessions
cczip --list

# Output:
# ID                                     TOKENS    MSGS  USAGE  MODIFIED
# ────────────────────────────────────────────────────────────────────────
# e93f6920-62eb-446f-92f1-69b30e387ec5  170006   254   85%  Sep 25, 08:57 PM
# 66b1d662-42b8-40f7-bf98-150eaaa08c13   45320    89   23%  Sep 25, 08:49 PM

# Compress a specific session
cczip e93f6920-62eb-446f-92f1-69b30e387ec5

# Compress session with specific amount
cczip e93f6920-62eb-446f-92f1-69b30e387ec5 40%
```

### Compression Options

```bash
# Light compression (remove 30%)
cczip 30%
# → Keeps 70% of content, good for when you're at ~70% capacity

# Medium compression (remove 50%) - DEFAULT
cczip
# → Balanced approach, doubles your remaining space

# Heavy compression (remove 70%)
cczip 70%
# → Aggressive cleanup, keeps only 30% most relevant content

# Target specific token count
cczip 100000
# → Compress to exactly 100k tokens
```

### Safety Features

```bash
# Preview changes without modifying anything
cczip --preview 40%
# Shows what would be removed, no changes made

# Every compression creates automatic backup
cczip 50%
# → Creates: session-id.jsonl.backup.1234567890

# Restore from backup if needed
cczip --restore
# → Restores most recent backup
```

### Working with Files

```bash
# Auto-detect (uses most recent session in current directory)
cczip

# Specific session by ID
cczip e93f6920-62eb-446f-92f1-69b30e387ec5

# Specific file path
cczip /path/to/conversation.jsonl

# With compression amount
cczip conversation.jsonl 40%
```

## Understanding Compression

### What Gets Removed?
- Messages with low relevancy to recent conversation
- Old technical discussions unrelated to current topic
- Redundant explanations that have been superseded

### What Gets Protected?
- **First 2 ranges**: Initial setup and context
- **Last 3 ranges**: Most recent conversation
- **User messages**: Preserved at range boundaries
- **Message threading**: parentUuid chains maintained

### Visual Context Display

```bash
cczip --context

# Output:
#   ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁
#   ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   Current Context Usage
#   ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   170,006/200,000 tokens (85%)
#   ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁
#   ⛁ ⛁ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
#
#   Total messages: 254
```

## Advanced Options

### Custom Context Limits

```bash
# For different models with different limits
cczip --ctx-limit 150000 50%
```

### Protection Zones

```bash
# Protect more initial context (first 5 ranges)
cczip --protect-start 5

# Protect more recent context (last 5 ranges)
cczip --protect-end 5
```

## How It Works

1. **Analyzes** your conversation to identify message ranges
2. **Calculates** relevancy using lexical similarity to recent messages
3. **Removes** low-relevancy ranges intelligently
4. **Preserves** conversation flow and context
5. **Updates** all token counts and message references
6. **Creates** automatic backup before changes

## Real-World Example

```bash
# Monday: Deep into a complex feature implementation
cczip --context
# → 168k/200k tokens (84%) ⚠️ Getting close!

# Compress to continue working
cczip 40%
# → Compress by 40% → Keep 60% (120,000 tokens)
# → [DONE] 168k → 120k tokens

# Continue coding without interruption!
```

## Tips

- **At 80% capacity?** Run `cczip 30%` for light cleanup
- **Hit the limit?** Run `cczip 70%` for aggressive compression
- **Not sure?** Use `cczip --preview 50%` to see what would be removed
- **Working on multiple projects?** Use `cczip --list` to manage all sessions
- **Made a mistake?** Use `cczip --restore` immediately

## Troubleshooting

### No sessions found
```bash
cczip --list
# [ERROR] No Claude sessions found in current directory
```
**Solution**: Run from a directory where you've used Claude

### Session not found
```bash
cczip abc-def-ghi
# [ERROR] Session not found: abc-def-ghi
```
**Solution**: Check session ID with `cczip --list`

### Already optimized
```bash
cczip
# ✓ File is already within target size. No optimization needed.
```
**Solution**: Your conversation is already compact!

## License

MIT

## Contributing

Found a bug or have a feature request? Open an issue at:
https://github.com/unclecode/cczip/issues