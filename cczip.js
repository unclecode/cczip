#!/usr/bin/env node

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

let CTX_LIMIT = 200000;
const DEFAULT_TARGET_RATIO = 0.5;

// Protected ranges (don't remove first 2 and last 3 ranges)
let PROTECTED_START = 2;
let PROTECTED_END = 3;

const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

function findMostRecentJSONL() {
  const cwd = process.cwd();
  const projectFolderName = cwd.replace(/\//g, '-');
  const projectDir = path.join(claudeProjectsDir, projectFolderName);

  if (!fs.existsSync(projectDir)) {
    throw new Error(`Claude project directory not found: ${projectDir}`);
  }

  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(projectDir, f),
      mtime: fs.statSync(path.join(projectDir, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(`No JSONL files found in: ${projectDir}`);
  }

  console.log(`Found ${files.length} JSONL files, using most recent: ${files[0].name}`);
  return files[0].path;
}

function getFilePath() {
  // Check for file path or session ID in arguments
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (!arg.startsWith('--') && !arg.endsWith('%') && isNaN(arg)) {
      // Check if it's a full file path
      if (fs.existsSync(arg)) {
        console.log(`Using specified file: ${path.basename(arg)}`);
        return arg;
      }

      // Check if it's a session ID (UUID format)
      if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(arg)) {
        const cwd = process.cwd();
        const projectFolderName = cwd.replace(/\//g, '-');
        const projectDir = path.join(claudeProjectsDir, projectFolderName);
        const sessionFile = path.join(projectDir, `${arg}.jsonl`);

        if (fs.existsSync(sessionFile)) {
          console.log(`Using session: ${arg}`);
          return sessionFile;
        } else {
          console.log(`[ERROR] Session not found: ${arg}`);
          process.exit(1);
        }
      }
    }
  }

  // Auto-detect most recent JSONL
  return findMostRecentJSONL();
}

function getTargetTokens() {
  // Check for target in arguments
  const args = process.argv.slice(2);
  for (const arg of args) {
    // Check for percentage (e.g., "40%") - now means compress BY this amount
    if (arg.endsWith('%')) {
      const compressPercent = parseFloat(arg.slice(0, -1));
      if (!isNaN(compressPercent) && compressPercent > 0 && compressPercent < 100) {
        const keepPercent = 100 - compressPercent;
        const target = Math.floor(CTX_LIMIT * (keepPercent / 100));
        console.log(`Compress by ${compressPercent}% → Keep ${keepPercent}% (${target.toLocaleString()} tokens)`);
        return target;
      }
    }
    // Check for absolute number (e.g., "120000")
    else if (!arg.startsWith('--') && !isNaN(arg)) {
      const target = parseInt(arg);
      if (target > 0) {
        const percent = ((target / CTX_LIMIT) * 100).toFixed(1);
        const compressPercent = (100 - parseFloat(percent)).toFixed(1);
        console.log(`Target: ${target.toLocaleString()} tokens (compress by ${compressPercent}%)`);
        return target;
      }
    }
  }

  // Use default - 50% compression (keep 50%)
  const target = Math.floor(CTX_LIMIT * 0.5);
  console.log(`Compress by 50% → Keep 50% (${target.toLocaleString()} tokens) [default]`);
  return target;
}

async function readJSONLFile(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines;
}

async function extractUserMessagesAndTokens(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let prevLineWasUser = false;
  let userLineNumber = 0;
  const data = [];
  const userContents = new Map(); // Store user message contents

  for await (const line of rl) {
    lineNumber++;

    if (line.includes('"type":"user","message":{"role":"user","content":"')) {
      prevLineWasUser = true;
      userLineNumber = lineNumber;

      // Extract user content
      try {
        const parsed = JSON.parse(line);
        if (parsed.message && parsed.message.content) {
          userContents.set(lineNumber, parsed.message.content);
        }
      } catch (e) {}
    } else if (prevLineWasUser) {
      const cacheReadMatch = line.match(/"cache_read_input_tokens":(\d+)/);
      const cacheCreationMatch = line.match(/"cache_creation_input_tokens":(\d+)/);

      const cacheRead = cacheReadMatch ? parseInt(cacheReadMatch[1]) : 0;
      const cacheCreation = cacheCreationMatch ? parseInt(cacheCreationMatch[1]) : 0;
      const tokens = cacheRead + cacheCreation;

      data.push({ line: userLineNumber, tokens });
      prevLineWasUser = false;
    }
  }

  return { data, userContents };
}

function applyBackwardElimination(data) {
  // Filter out entries where tokens equals 0
  const filteredData = data.filter(item => item.tokens !== 0);

  // Calculate differences
  const allResults = filteredData.map((item, index) => {
    const diff = index === 0 ? item.tokens : item.tokens - filteredData[index - 1].tokens;
    return { line: item.line, tokens: item.tokens, diff };
  });

  // Backward elimination algorithm
  const toRemove = new Set();

  for (let i = allResults.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) continue;

    if (allResults[i].diff < 0) {
      const bTokens = allResults[i].tokens;
      let a = i - 1;
      while (a >= 0 && bTokens <= allResults[a].tokens) {
        a--;
      }

      if (a >= 0) {
        for (let k = a + 1; k < i; k++) {
          toRemove.add(k);
        }
      }
      i = a + 1;
    }
  }

  // Filter and recalculate
  const filtered = allResults.filter((_, index) => !toRemove.has(index));
  return filtered.map((item, index) => {
    const diff = index === 0 ? item.tokens : item.tokens - filtered[index - 1].tokens;
    return { line: item.line, tokens: item.tokens, diff };
  });
}

function calculateLexicalRelevancy(content1, content2) {
  if (!content1 || !content2) return 0;

  // Simple word-based relevancy score
  const words1 = content1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const words2 = content2.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);

  // Jaccard similarity
  return union.size > 0 ? intersection.size / union.size : 0;
}

function createRanges(filteredResults) {
  const ranges = [];
  for (let i = 0; i < filteredResults.length - 1; i++) {
    // Token savings for removing range (i, i+1) is b_(i+1) - b_i
    const tokenSavings = filteredResults[i + 1].tokens - filteredResults[i].tokens;
    ranges.push({
      startLine: filteredResults[i].line + 1, // Start after the user message
      endLine: filteredResults[i + 1].line, // End at the next user message
      startIdx: i,
      endIdx: i + 1,
      tokens: tokenSavings, // This is what we save by removing this range
      fromTuple: filteredResults[i],
      toTuple: filteredResults[i + 1],
      relevancy: 0
    });
  }
  // Don't add a last range - we can't remove beyond the last user message
  return ranges;
}

async function optimizeRanges(ranges, userContents, targetTokens, currentTotal, filteredResults) {
  // Protect first and last ranges
  const protectedStart = Math.min(PROTECTED_START, ranges.length);
  const protectedEnd = Math.min(PROTECTED_END, ranges.length);

  // Get last user messages for relevancy comparison
  const lastMessages = Array.from(userContents.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([_, content]) => content)
    .join(' ');

  // Calculate relevancy for removable ranges
  for (let i = protectedStart; i < ranges.length - protectedEnd; i++) {
    const rangeContent = Array.from(userContents.entries())
      .filter(([line, _]) => line >= ranges[i].startLine && line <= ranges[i].endLine)
      .map(([_, content]) => content)
      .join(' ');

    ranges[i].relevancy = calculateLexicalRelevancy(rangeContent, lastMessages);
  }

  // Sort removable ranges by relevancy (least relevant first) and token savings (larger first)
  const removableCandidates = ranges
    .slice(protectedStart, Math.max(0, ranges.length - protectedEnd))
    .map((range, idx) => ({ ...range, originalIdx: idx + protectedStart }))
    .filter(r => r.tokens > 0) // Only consider ranges that actually save tokens
    .sort((a, b) => {
      // Prioritize removing less relevant, larger savings
      const scoreA = a.relevancy - (a.tokens / currentTotal);
      const scoreB = b.relevancy - (b.tokens / currentTotal);
      return scoreA - scoreB;
    });

  // Greedily remove ranges until we reach target
  const toRemove = new Set();
  let totalSavings = 0;
  const targetReduction = currentTotal - targetTokens;

  for (const candidate of removableCandidates) {
    if (totalSavings >= targetReduction) break;

    toRemove.add(candidate.originalIdx);
    totalSavings += candidate.tokens;
  }

  return {
    keptRanges: ranges.filter((_, idx) => !toRemove.has(idx)),
    removedRanges: ranges.filter((_, idx) => toRemove.has(idx)),
    finalTokens: currentTotal - totalSavings
  };
}

async function backupFile(filePath) {
  const backupPath = filePath + '.backup.' + Date.now();
  fs.copyFileSync(filePath, backupPath);
  console.log(`[BACKUP] Created: ${path.basename(backupPath)}`);
  return backupPath;
}

async function writeOptimizedJSONL(filePath, lines, keptRanges, removedRanges) {
  // Build a map of what to keep and what to remove
  // For removed ranges, we keep the user message at endLine but remove everything from startLine to endLine-1
  const linesToKeep = new Set();
  const userMessageLines = new Set();

  // First, identify all user message lines
  lines.forEach((line, idx) => {
    if (line.includes('"type":"user"')) {
      userMessageLines.add(idx + 1); // Convert to 1-based line numbers
    }
  });

  // Add kept ranges
  for (const range of keptRanges) {
    for (let i = range.startLine; i <= Math.min(range.endLine, lines.length); i++) {
      linesToKeep.add(i);
      // Also keep the line after user messages (contains token info)
      if (userMessageLines.has(i)) {
        linesToKeep.add(i + 1);
      }
    }
  }

  // For removed ranges, still keep the end user message
  for (const range of removedRanges) {
    // Keep the user message at the end of the range
    if (userMessageLines.has(range.endLine)) {
      linesToKeep.add(range.endLine);
      linesToKeep.add(range.endLine + 1); // Keep the assistant response too
    }
  }

  // Parse all lines
  const parsedLines = lines.map((line, idx) => {
    try {
      return { index: idx + 1, data: JSON.parse(line), raw: line };
    } catch {
      return { index: idx + 1, data: null, raw: line };
    }
  });

  // Sort removed ranges by line number (descending) for backward processing
  const sortedRemovedRanges = [...removedRanges].sort((a, b) => b.endLine - a.endLine);

  // Process removals backward and adjust cache tokens
  for (const range of sortedRemovedRanges) {
    const tokensRemoved = range.tokens; // This is b_(i+1) - b_i

    // Adjust cache_read_input_tokens for all messages after this range
    for (let i = 0; i < parsedLines.length; i++) {
      const line = parsedLines[i];

      // Only adjust lines after the removed range that are being kept
      if (line.index > range.endLine && linesToKeep.has(line.index)) {
        if (line.data && line.data.message && line.data.message.usage) {
          // Adjust cache_read_input_tokens
          if (line.data.message.usage.cache_read_input_tokens) {
            line.data.message.usage.cache_read_input_tokens -= tokensRemoved;
            // Ensure it doesn't go negative
            if (line.data.message.usage.cache_read_input_tokens < 0) {
              line.data.message.usage.cache_read_input_tokens = 0;
            }
          }
        }
      }
    }
  }

  // Filter lines to keep
  const keptParsedLines = parsedLines.filter(item => linesToKeep.has(item.index));

  // Update parentUuid chain
  let previousUuid = null;
  for (let i = 0; i < keptParsedLines.length; i++) {
    const current = keptParsedLines[i];
    if (current.data && current.data.uuid) {
      if (previousUuid && current.data.parentUuid) {
        current.data.parentUuid = previousUuid;
      }
      previousUuid = current.data.uuid;
    }
  }

  // Write filtered and updated lines
  const optimizedLines = keptParsedLines.map(item => {
    if (item.data) {
      return JSON.stringify(item.data);
    }
    return item.raw;
  });

  fs.writeFileSync(filePath, optimizedLines.join('\n') + '\n');

  return {
    originalLines: lines.length,
    optimizedLines: optimizedLines.length,
    removedLines: lines.length - optimizedLines.length
  };
}

async function restoreFromBackup(filePath) {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);

  // Find backup files
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith(basename + '.backup.'))
    .map(f => ({
      name: f,
      path: path.join(dir, f),
      timestamp: parseInt(f.split('.backup.')[1])
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  if (backups.length === 0) {
    console.log('[ERROR] No backup files found');
    return false;
  }

  // Use most recent backup
  const backup = backups[0];
  console.log(`Found ${backups.length} backup(s), using most recent: ${backup.name}`);

  // Restore
  fs.copyFileSync(backup.path, filePath);
  console.log(`[SUCCESS] Restored from backup`);
  return true;
}

function showContextVisualization(tokens, limit = CTX_LIMIT, label = 'Context Usage') {
  const percentage = Math.round((tokens / limit) * 100);
  const filled = Math.round((tokens / limit) * 10);
  const empty = 10 - filled;

  // Purple color for filled blocks
  const purple = '\x1b[38;5;99m';
  const gray = '\x1b[90m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  console.log('');

  // Create the visualization grid
  const filledBlock = `${purple}⛁${reset}`;
  const emptyBlock = `${gray}⛶${reset}`;

  // Create 5 rows of 10 blocks each
  for (let row = 0; row < 5; row++) {
    let line = '  ';
    for (let col = 0; col < 10; col++) {
      const index = row * 10 + col;
      const percentIndex = (index + 1) * 2; // Each block represents 2%
      if (percentIndex <= percentage) {
        line += filledBlock + ' ';
      } else {
        line += emptyBlock + ' ';
      }
    }

    // Add label on the second row
    if (row === 1) {
      line += `  ${bold}${label}${reset}`;
    } else if (row === 2) {
      line += `  ${tokens.toLocaleString()}/${limit.toLocaleString()} tokens (${percentage}%)`;
    }

    console.log(line);
  }

  console.log('');
}

function showHelp() {
  console.log('CCZip - Claude Context Compressor v1.0');
  console.log('');
  console.log('USAGE:');
  console.log('  cczip [options] [file] [target]');
  console.log('');
  console.log('PARAMETERS:');
  console.log('  file/session    Path to JSONL file or session ID (auto-detects if omitted)');
  console.log('  compression     Compression amount as % (40%) or target tokens (100000)');
  console.log('                  Default: 50% compression');
  console.log('');
  console.log('OPTIONS:');
  console.log('  --list          List all available chat sessions');
  console.log('  --context       Show current token usage visualization');
  console.log('  --preview       Show optimization plan without making changes');
  console.log('  --restore       Restore from most recent backup');
  console.log('  --ctx-limit N   Set context limit (default: 200000)');
  console.log('  --protect-start N  Number of initial ranges to protect (default: 2)');
  console.log('  --protect-end N    Number of final ranges to protect (default: 3)');
  console.log('  --help          Show this help message');
  console.log('');
  console.log('EXAMPLES:');
  console.log('  cczip --list                   # List all sessions');
  console.log('  cczip --context                # Show current token usage');
  console.log('  cczip                          # Compress by 50% (default)');
  console.log('  cczip 30%                      # Light compression (remove 30%)');
  console.log('  cczip 70%                      # Heavy compression (remove 70%)');
  console.log('  cczip 100000                   # Compress to 100k tokens');
  console.log('  cczip SESSION_ID 40%           # Compress session by 40%');
  console.log('  cczip file.jsonl 40%           # Compress file by 40%');
  console.log('  cczip --preview 60%            # Preview 60% compression');
  console.log('  cczip --restore                # Restore from backup');
  process.exit(0);
}

function getConfigValue(flag, defaultValue) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length) {
    const value = parseInt(args[index + 1]);
    if (!isNaN(value)) return value;
  }
  return defaultValue;
}

async function listSessions() {
  const cwd = process.cwd();
  const projectFolderName = cwd.replace(/\//g, '-');
  const projectDir = path.join(claudeProjectsDir, projectFolderName);

  if (!fs.existsSync(projectDir)) {
    console.log('[ERROR] No Claude sessions found in current directory');
    return;
  }

  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fullPath = path.join(projectDir, f);
      const stats = fs.statSync(fullPath);
      const sessionId = f.replace('.jsonl', '');

      // Quick token count - read file and get last user message's cache_read_input_tokens
      let tokens = 0;
      let messageCount = 0;
      try {
        const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          if (line.includes('"type":"user"')) {
            messageCount++;
          }
        }
        // Get last message with cache_read_input_tokens
        for (let i = lines.length - 1; i >= 0; i--) {
          const match = lines[i].match(/"cache_read_input_tokens":(\d+)/);
          if (match) {
            tokens = parseInt(match[1]);
            break;
          }
        }
      } catch (e) {}

      return {
        id: sessionId,
        path: fullPath,
        mtime: stats.mtime,
        tokens,
        messages: messageCount,
        percent: Math.round((tokens / CTX_LIMIT) * 100)
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  console.log('[SESSIONS] Available chat sessions:\n');
  console.log('ID                                     TOKENS    MSGS  USAGE  MODIFIED');
  console.log('────────────────────────────────────────────────────────────────────────');

  files.forEach((f, idx) => {
    const modified = new Date(f.mtime).toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });

    const usage = f.percent >= 80 ? `[31m${f.percent}%[0m` :
                  f.percent >= 60 ? `[33m${f.percent}%[0m` :
                  `${f.percent}%`;

    console.log(
      `${f.id}  ${f.tokens.toString().padStart(6)}  ${f.messages.toString().padStart(4)}  ${usage.padStart(4)}  ${modified}`
    );
  });

  console.log('\nUsage: cczip [SESSION_ID] or cczip [SESSION_ID] [compression]');
}

async function main() {
  // Parse command line arguments
  if (process.argv.includes('--help')) {
    showHelp();
  }

  const isList = process.argv.includes('--list');
  const isContext = process.argv.includes('--context');
  const isPreview = process.argv.includes('--preview');
  const isRestore = process.argv.includes('--restore');

  // Get configuration
  CTX_LIMIT = getConfigValue('--ctx-limit', CTX_LIMIT);
  PROTECTED_START = getConfigValue('--protect-start', PROTECTED_START);
  PROTECTED_END = getConfigValue('--protect-end', PROTECTED_END);

  // Handle --list command
  if (isList) {
    await listSessions();
    return;
  }

  // Get file path
  const filePath = getFilePath();

  if (isContext) {
    // Show current context usage
    console.log(`File: ${filePath}`);
    const { data } = await extractUserMessagesAndTokens(filePath);
    const filteredResults = applyBackwardElimination(data);
    const currentTotal = filteredResults.reduce((sum, item) => sum + item.diff, 0);
    const messageCount = filteredResults.length;
    showContextVisualization(currentTotal, CTX_LIMIT, 'Current Context Usage');
    console.log(`  Total messages: ${messageCount}`);
    console.log('');
    return;
  }

  if (isRestore) {
    console.log(`Restoring: ${filePath}\n`);
    const success = await restoreFromBackup(filePath);
    return;
  }

  console.log(`File: ${filePath}`);

  // Get target tokens
  const targetTokens = getTargetTokens();
  console.log('');

  // Step 1: Extract data
  const { data, userContents } = await extractUserMessagesAndTokens(filePath);
  const lines = await readJSONLFile(filePath);

  // Step 2: Apply backward elimination
  const filteredResults = applyBackwardElimination(data);

  // Step 3: Calculate current total
  const currentTotal = filteredResults.reduce((sum, item) => sum + item.diff, 0);
  console.log(`Current: ${currentTotal.toLocaleString()} tokens\n`);

  if (currentTotal <= targetTokens) {
    console.log('[INFO] File already within target size. No optimization needed.');
    return;
  }

  // Step 4: Create ranges and optimize
  const ranges = createRanges(filteredResults);

  const optimization = await optimizeRanges(ranges, userContents, targetTokens, currentTotal, filteredResults);

  if (isPreview) {
    // Preview mode - show what would happen without making changes
    console.log('[PREVIEW] Optimization Plan:');
    console.log('========================');
    console.log(`Original tokens: ${currentTotal.toLocaleString()}`);
    console.log(`Target tokens: ${targetTokens.toLocaleString()}`);
    console.log(`Final tokens (projected): ${optimization.finalTokens.toLocaleString()}`);
    console.log(`Reduction: ${(currentTotal - optimization.finalTokens).toLocaleString()} tokens (${((1 - optimization.finalTokens / currentTotal) * 100).toFixed(1)}%)`);

    console.log(`\n[REMOVE] ${optimization.removedRanges.length} ranges:`);
    optimization.removedRanges.forEach((range, idx) => {
      console.log(`  ${idx + 1}. Lines ${range.startLine}-${range.endLine}: ${range.tokens.toLocaleString()} tokens (relevancy: ${(range.relevancy * 100).toFixed(1)}%)`);
    });

    console.log(`\n[KEEP] ${optimization.keptRanges.length} ranges`);

    // Calculate line statistics
    const linesToRemove = new Set();
    for (const range of optimization.removedRanges) {
      for (let i = range.startLine; i <= Math.min(range.endLine, lines.length); i++) {
        linesToRemove.add(i);
      }
    }

    console.log(`\nLines to be removed: ${linesToRemove.size}`);
    console.log(`Lines to be kept: ${lines.length - linesToRemove.size}`);

    console.log(`\n[WARNING] Preview mode - no changes made`);
    console.log(`To apply these changes, run without --preview flag.`);
  } else {
    // Step 5: Backup original file
    const backupPath = await backupFile(filePath);

    // Step 6: Write optimized file
    const writeStats = await writeOptimizedJSONL(filePath, lines, optimization.keptRanges, optimization.removedRanges);

    // Step 7: Display statistics
    console.log('\n[COMPLETE] Optimization Results:');
    console.log('========================');
    console.log(`Original tokens: ${currentTotal.toLocaleString()}`);
    console.log(`Final tokens: ${optimization.finalTokens.toLocaleString()}`);
    console.log(`Reduction: ${(currentTotal - optimization.finalTokens).toLocaleString()} tokens (${((1 - optimization.finalTokens / currentTotal) * 100).toFixed(1)}%)`);

    console.log(`\n[REMOVED] ${optimization.removedRanges.length} ranges:`);
    optimization.removedRanges.forEach((range, idx) => {
      console.log(`  ${idx + 1}. Lines ${range.startLine}-${range.endLine}: ${range.tokens.toLocaleString()} tokens (relevancy: ${(range.relevancy * 100).toFixed(1)}%)`);
    });

    console.log(`\n[KEPT] ${optimization.keptRanges.length} ranges`);
    console.log(`\nLines removed: ${writeStats.removedLines}`);
    console.log(`Lines kept: ${writeStats.optimizedLines}`);
    console.log(`\n[DONE] Optimization complete`);
  }
}

main().catch(console.error);