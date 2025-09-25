# cczip - Claude Context Compressor

Intelligently compress Claude conversation history to manage context limits.

## Installation

```bash
npm install -g cczip
```

## Usage

```bash
# Auto-detect file and compress to 50% (default)
cczip

# Specify target percentage
cczip 60%

# Specify absolute token target
cczip 80000

# Specify file and target
cczip conversation.jsonl 70%

# Show current context usage
cczip --context

# Preview changes without modifying
cczip --preview 50%

# Restore from backup
cczip --restore
```

## Features

- **Smart compression**: Removes low-relevancy conversation ranges while preserving context
- **Automatic backup**: Creates backup before any modifications
- **Token adjustment**: Properly updates cache_read_input_tokens after removal
- **UUID chain maintenance**: Preserves parentUuid relationships
- **Visual feedback**: Shows context usage with visual blocks

## Options

- `--context` - Display current token usage visualization
- `--preview` - Show optimization plan without making changes
- `--restore` - Restore from most recent backup
- `--ctx-limit N` - Set context limit (default: 200000)
- `--protect-start N` - Number of initial ranges to protect (default: 2)
- `--protect-end N` - Number of final ranges to protect (default: 3)
- `--help` - Show help message

## How it works

1. Analyzes your Claude conversation JSONL file
2. Identifies conversation ranges based on user messages
3. Calculates relevancy using lexical similarity to recent messages
4. Removes low-relevancy ranges to reach target token count
5. Preserves initial context and recent conversation
6. Updates all token counts and UUID references

## License

MIT