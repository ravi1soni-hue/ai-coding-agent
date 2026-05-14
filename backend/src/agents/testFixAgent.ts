// Test & Fix Agent
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { debug, warn as logWarn, error as logError } from '../utils/logger';
import { config as envConfig } from '../config/env';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { parseJsonResponse } from './llmUtils';

// Known third-party library versions for auto-remediation
const KNOWN_LIBRARY_VERSIONS: Record<string, string> = {
  // Frontend — routing
  'react-router-dom': '^6.20.0',
  'react-router': '^6.20.0',
  // Frontend — state management
  'redux': '^4.2.1',
  'react-redux': '^8.1.3',
  '@reduxjs/toolkit': '^1.9.7',
  'zustand': '^4.4.0',
  'jotai': '^2.6.0',
  'recoil': '^0.7.7',
  'valtio': '^1.13.0',
  'immer': '^10.0.0',
  // Frontend — data fetching
  'axios': '^1.6.0',
  'swr': '^2.2.4',
  'react-query': '^3.39.3',
  '@tanstack/react-query': '^5.0.0',
  '@tanstack/react-table': '^8.11.0',
  '@tanstack/react-router': '^1.15.0',
  // Frontend — forms
  'react-hook-form': '^7.48.0',
  'formik': '^2.4.5',
  'yup': '^1.3.2',
  'zod': '^3.22.0',
  // Frontend — utilities
  'lodash': '^4.17.21',
  'lodash-es': '^4.17.21',
  'moment': '^2.29.4',
  'date-fns': '^2.30.0',
  'dayjs': '^1.11.10',
  'clsx': '^2.0.0',
  'classnames': '^2.3.2',
  'uuid': '^9.0.0',
  'nanoid': '^5.0.4',
  // Frontend — UI / styling
  'styled-components': '^6.1.0',
  '@emotion/react': '^11.11.1',
  '@emotion/styled': '^11.11.0',
  'tailwindcss': '^3.3.6',
  'autoprefixer': '^10.4.16',
  'postcss': '^8.4.32',
  'framer-motion': '^10.16.0',
  'react-spring': '^9.7.3',
  'react-icons': '^4.12.0',
  'lucide-react': '^0.294.0',
  '@heroicons/react': '^2.0.18',
  'react-feather': '^2.0.10',
  // Frontend — charts / data vis
  'recharts': '^2.10.0',
  'chart.js': '^4.4.0',
  'react-chartjs-2': '^5.2.0',
  'd3': '^7.8.5',
  // Frontend — maps
  'leaflet': '^1.9.4',
  'react-leaflet': '^4.2.1',
  // Frontend — notifications / UI utilities
  'react-toastify': '^10.0.4',
  'sonner': '^1.3.1',
  'react-hot-toast': '^2.4.1',
  'react-modal': '^3.16.1',
  '@radix-ui/react-dialog': '^1.0.5',
  '@radix-ui/react-dropdown-menu': '^2.0.6',
  '@radix-ui/react-tooltip': '^1.0.7',
  '@radix-ui/react-popover': '^1.0.7',
  '@radix-ui/react-tabs': '^1.0.4',
  '@radix-ui/react-select': '^2.0.0',
  '@radix-ui/react-checkbox': '^1.0.4',
  '@radix-ui/react-switch': '^1.0.3',
  'cmdk': '^0.2.1',
  // Frontend — component libraries
  '@mui/material': '^5.15.0',
  '@mui/icons-material': '^5.15.0',
  'antd': '^5.12.0',
  'primereact': '^10.2.0',
  'react-select': '^5.8.0',
  'react-datepicker': '^4.25.0',
  'react-dropzone': '^14.2.3',
  'react-table': '^7.8.0',
  'react-virtualized': '^9.22.5',
  'react-window': '^1.8.10',
  'react-markdown': '^9.0.1',
  // Backend — dev tooling
  'tsx': '^4.7.0',
  'ts-node': '^10.9.2',
  // Backend — safe, no external credentials needed
  'express': '^4.19.0',
  'cors': '^2.8.5',
  'pg': '^8.20.0',
  'dotenv': '^17.4.2',
  'jsonwebtoken': '^9.0.0',
  'bcryptjs': '^2.4.3',
  'bcrypt': '^5.1.1',
  'multer': '^1.4.5',
  'helmet': '^7.0.0',
  'morgan': '^1.10.0',
  'express-validator': '^7.0.1',
  'express-rate-limit': '^7.1.5',
  'compression': '^1.7.4',
  'cookie-parser': '^1.4.6',
  'express-session': '^1.17.3',
  'connect-pg-simple': '^9.0.1',
  // NOTE: @auth0/auth0-react, firebase, @supabase/supabase-js, stripe, nodemailer,
  // socket.io, ws are intentionally EXCLUDED — they require external credentials /
  // service accounts that cannot be supplied at generation time, so any generated
  // code using them would be broken stubs. Block them at the prompt level instead.
};

// Node.js built-in modules — never need to be in package.json
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'events',
  'stream', 'buffer', 'crypto', 'child_process', 'cluster', 'net',
  'dns', 'readline', 'zlib', 'assert', 'tty', 'vm', 'module',
  'process', 'timers', 'string_decoder', 'querystring', 'punycode',
  'worker_threads', 'perf_hooks', 'v8', 'inspector',
]);

type GeneratedFile = { path: string; content: string };

// react-icons uses a per-library prefix (Si = Simple Icons, Fa = Font Awesome, etc.).
// The LLM frequently invents icon names that don't exist in the installed version.

// Known-bad icon names → correct replacement (or null to remove the import entirely).
// Covers Si (Simple Icons) and Fa (Font Awesome) prefixes; add others as they surface.
const REACT_ICONS_REPLACEMENTS: Record<string, string | null> = {
  // Si replacements
  SiHuggingface: 'SiHuggingFace',      // correct capitalisation (v5+)
  SiHuggingFace: 'SiHuggingFace',      // keep as-is
  SiOpenai: 'SiOpenai',                // valid in v5+
  SiAmazonwebservices: 'SiAmazon',     // renamed in react-icons v5
  SiAws: 'SiAmazon',                   // non-existent alias
  SiAwsamplify: null,                  // doesn't exist — remove
  SiGooglecloud: 'SiGooglecloud',      // valid
  SiVercel: 'SiVercel',                // valid
  SiNetlify: 'SiNetlify',              // valid
  SiLangchain: null,                   // doesn't exist — remove
  SiLangChain: null,
  SiAnthropic: null,                   // doesn't exist — remove
  SiChatgpt: null,                     // doesn't exist — remove
  SiMeta: 'SiMeta',                    // valid in v5
  SiMicrosoft: 'SiMicrosoft',          // valid
  SiMicrosoftazure: 'SiMicrosoftazure', // valid
  // Fa replacements — icons that were removed or renamed between FA4/FA5/FA6
  FaScaleBalanced: 'FaBalanceScale',   // renamed; FaScaleBalanced doesn't exist in fa v4
  FaScaleUnbalanced: 'FaBalanceScaleLeft', // same family
  FaScaleUnbalancedFlip: 'FaBalanceScaleRight',
  FaGavel: 'FaGavel',                  // valid, just confirm
  FaPersonWalking: 'FaWalking',        // fa5 name
  FaPersonRunning: 'FaRunning',
  FaPersonBiking: 'FaBiking',
  FaPersonSwimming: 'FaSwimmer',
  FaPersonSkiing: 'FaSkiing',
  FaFaceSmile: 'FaSmile',
  FaFaceFrown: 'FaFrown',
  FaFaceMeh: 'FaMeh',
  FaFaceGrin: 'FaGrin',
  FaFaceLaugh: 'FaLaugh',
  FaCircleCheck: 'FaCheckCircle',
  FaCircleXmark: 'FaTimesCircle',
  FaCircleExclamation: 'FaExclamationCircle',
  FaCircleInfo: 'FaInfoCircle',
  FaCircleQuestion: 'FaQuestionCircle',
  FaTriangleExclamation: 'FaExclamationTriangle',
  FaSquareCheck: 'FaCheckSquare',
  FaFileLines: 'FaFileAlt',
  FaFilePen: 'FaFileEdit',
  FaSquarePlus: 'FaPlusSquare',
  FaSquareMinus: 'FaMinusSquare',
  FaPenToSquare: 'FaEdit',
  FaRightFromBracket: 'FaSignOutAlt',
  FaRightToBracket: 'FaSignInAlt',
  FaArrowRightFromBracket: 'FaSignOutAlt',
  FaArrowRightToBracket: 'FaSignInAlt',
  FaBarsStaggered: 'FaBars',
  FaEllipsis: 'FaEllipsisH',
  FaEllipsisVertical: 'FaEllipsisV',
  FaMagnifyingGlass: 'FaSearch',
  FaMagnifyingGlassPlus: 'FaSearchPlus',
  FaMagnifyingGlassMinus: 'FaSearchMinus',
  FaGear: 'FaCog',
  FaGears: 'FaCogs',
  FaXmark: 'FaTimes',
  FaX: 'FaTimes',
  FaCheck: 'FaCheck',
  FaPlus: 'FaPlus',
  FaMinus: 'FaMinus',
  FaUpload: 'FaUpload',
  FaDownload: 'FaDownload',
  FaShare: 'FaShare',
  FaShareNodes: 'FaShareAlt',
  FaArrowUp: 'FaArrowUp',
  FaArrowDown: 'FaArrowDown',
  FaArrowLeft: 'FaArrowLeft',
  FaArrowRight: 'FaArrowRight',
  FaChevronUp: 'FaChevronUp',
  FaChevronDown: 'FaChevronDown',
  FaChevronLeft: 'FaChevronLeft',
  FaChevronRight: 'FaChevronRight',
  FaBell: 'FaBell',
  FaBellSlash: 'FaBellSlash',
  FaTrashCan: 'FaTrash',
  FaFloppyDisk: 'FaSave',
  FaPaperclip: 'FaPaperclip',
  FaPaperPlane: 'FaPaperPlane',
  FaEnvelopeOpen: 'FaEnvelopeOpen',
  FaAddressCard: 'FaAddressCard',
  FaIdCard: 'FaIdCard',
  FaBuildingColumns: 'FaUniversity',
  FaHouseChimney: 'FaHome',
  FaHouse: 'FaHome',
  FaRectangleList: 'FaListAlt',
  FaTableList: 'FaList',
  FaTableCells: 'FaTable',
  FaTableCellsLarge: 'FaTh',
  FaChartSimple: 'FaChartBar',
  FaChartColumn: 'FaChartBar',
  FaMaximize: 'FaExpand',
  FaMinimize: 'FaCompress',
  FaLock: 'FaLock',
  FaLockOpen: 'FaLockOpen',
  FaShield: 'FaShield',
  FaShieldHalved: 'FaShieldAlt',
  FaUserShield: 'FaUserShield',
  FaUserLock: 'FaUserLock',
  FaUserGroup: 'FaUsers',
  FaUserPlus: 'FaUserPlus',
  FaUserMinus: 'FaUserMinus',
  FaUserPen: 'FaUserEdit',
  FaUserCheck: 'FaUserCheck',
  FaUserClock: 'FaUserClock',
  FaUserTag: 'FaUserTag',
  FaUserTie: 'FaUserTie',
  FaHandshake: 'FaHandshake',
  FaClipboardList: 'FaClipboardList',
  FaClipboardCheck: 'FaClipboardCheck',
  FaListCheck: 'FaTasks',
  FaCirclePlay: 'FaPlayCircle',
  FaCirclePause: 'FaPauseCircle',
  FaCircleStop: 'FaStopCircle',
  FaBolt: 'FaBolt',
  FaBoltLightning: 'FaBolt',
  FaFlag: 'FaFlag',
  FaFlagCheckered: 'FaFlagCheckered',
  FaRocket: 'FaRocket',
  FaBug: 'FaBug',
  FaCode: 'FaCode',
  FaTerminal: 'FaTerminal',
  FaDatabase: 'FaDatabase',
  FaServer: 'FaServer',
  FaNetworkWired: 'FaNetworkWired',
  FaCloud: 'FaCloud',
  FaCloudArrowUp: 'FaCloudUploadAlt',
  FaCloudArrowDown: 'FaCloudDownloadAlt',
  FaMobileScreen: 'FaMobileAlt',
  FaMobileScreenButton: 'FaMobileAlt',
  FaDesktop: 'FaDesktop',
  FaLaptop: 'FaLaptop',
  FaKeyboard: 'FaKeyboard',
  FaPrint: 'FaPrint',
  FaPlugCirclePlus: null,
  FaPlugCircleMinus: null,
  FaPlugCircleCheck: null,
  FaPlugCircleXmark: null,
};

// Extracts icon names reported as missing by Rollup/Vite build errors.
// Example line: "FaScaleBalanced" is not exported by "node_modules/react-icons/fa/..."
// Covers all react-icons library prefixes: Fa, Si, Bs, Ai, Bi, Ci, Di, Fi, Gi, Gr, Hi, Im,
// Io, Lu, Md, Pi, Ri, Rx, Sl, Tb, Ti, Vsc, Wi, Fc, Cg, Go, Lia, Tb, Tfi.
function parseMissingIconsFromLogs(logs: string): Set<string> {
  const missing = new Set<string>();
  const re = /"((?:Fa|Si|Bs|Ai|Bi|Ci|Di|Fi|Gi|Gr|Hi|Im|Io|Lu|Md|Pi|Ri|Rx|Sl|Tb|Ti|Vsc|Wi|Fc|Cg|Go|Lia|Tfi)[A-Za-z0-9]+)"\s+is not exported by/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(logs)) !== null) missing.add(m[1]);
  return missing;
}

// Rewrite any react-icons named imports that are known bad → known good (or remove nulls).
// Also strips any icons surfaced as missing in the provided build log.
// Returns updated file content or null if no change was needed.
function fixReactIconsImports(content: string, missingFromLogs?: Set<string>): string | null {
  const iconImportRe = /import\s+\{([^}]+)\}\s+from\s+['"]react-icons\/([a-z]+)['"]/g;
  let changed = false;
  const result = content.replace(iconImportRe, (_match, names: string, lib: string) => {
    const fixedNames = names.split(',').map((raw) => {
      const name = raw.trim();
      if (!name) return raw;

      // Check static replacement map
      if (Object.prototype.hasOwnProperty.call(REACT_ICONS_REPLACEMENTS, name)) {
        const replacement = REACT_ICONS_REPLACEMENTS[name];
        changed = true;
        if (replacement === null) return ''; // will be filtered out
        return replacement === name ? raw : raw.replace(name, replacement);
      }

      // Dynamically strip icons the build reported as missing
      if (missingFromLogs?.has(name)) {
        changed = true;
        return '';
      }

      return raw;
    }).filter(s => s.trim()).join(', ');

    if (!fixedNames.trim()) {
      changed = true;
      return ''; // entire import line removed
    }
    return `import { ${fixedNames} } from 'react-icons/${lib}'`;
  });
  // Clean up blank lines left by removed imports
  const cleaned = result.replace(/^\s*\n/gm, '');
  return changed ? cleaned : null;
}

/**
 * Fixes JSX elements that have the same attribute declared twice.
 * esbuild rejects these at build time: `Duplicate "style" attribute in JSX element`.
 * The LLM occasionally writes: style={styles.foo} aria-hidden="true" style={{ ...styles.foo, color: 'red' }}
 * We remove the first occurrence so only the more-specific (usually inline) one survives.
 * Mutates files in-place and writes corrected content to disk when workspaceDir is provided.
 */
async function fixDuplicateJsxAttributes(files: GeneratedFile[], workspaceDir?: string): Promise<void> {
  // Matches an opening JSX tag spanning multiple tokens (no nested < or >).
  // We look for any tag that contains the same attribute name twice.
  const jsxTagRe = /<([A-Za-z][A-Za-z0-9.]*)\s([^<>]*?)>/g;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;

    let changed = false;
    const result = file.content.replace(jsxTagRe, (fullTag, _tagName, attrs) => {
      // Extract individual attribute names from the attr string.
      // Match: name= or name (boolean) patterns.
      const attrNameRe = /([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}))?/g;
      const seen = new Map<string, number>(); // name → count
      let m: RegExpExecArray | null;
      while ((m = attrNameRe.exec(attrs)) !== null) {
        const name = m[1];
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
      const dupes = new Set([...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n));
      if (dupes.size === 0) return fullTag;

      // For each duplicated attribute, remove all but the LAST occurrence.
      let fixedAttrs = attrs;
      for (const attrName of dupes) {
        // Remove all occurrences of `attrName=...` except the last.
        // Three forms: attrName={expr}, attrName="str", attrName='str', bare attrName.
        const singleAttrRe = new RegExp(
          `\\b${attrName}\\s*=\\s*(?:"[^"]*"|'[^']*'|\\{(?:[^{}]|\\{[^{}]*\\})*\\})|\\b${attrName}\\b(?!\\s*=)`,
          'g'
        );
        const allMatches: Array<{ index: number; length: number }> = [];
        let am: RegExpExecArray | null;
        singleAttrRe.lastIndex = 0;
        while ((am = singleAttrRe.exec(fixedAttrs)) !== null) {
          allMatches.push({ index: am.index, length: am[0].length });
        }
        // Remove all but the last match (keep highest-index one = most-specific inline style).
        const toRemove = allMatches.slice(0, -1);
        // Apply removals in reverse order to preserve indices.
        for (const rem of toRemove.reverse()) {
          fixedAttrs = fixedAttrs.slice(0, rem.index) + fixedAttrs.slice(rem.index + rem.length);
          changed = true;
        }
      }
      if (!changed) return fullTag;
      return fullTag.replace(attrs, fixedAttrs);
    });

    if (changed) {
      file.content = result;
      debug('testFixAgent:duplicate-jsx-attr-fix', { path: file.path });
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try { await fs.writeFile(abs, result, 'utf8'); } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Repairs CSS string literals that the LLM split across multiple lines.
 * JavaScript string literals cannot span lines — a newline inside a string is a syntax error.
 * Pattern: a line has an odd number of unescaped quote chars of one kind (string still open),
 * so we join it with the next line (repeat until closed).
 * Only touches JS/JSX/TS/TSX files. Mutates files in-place.
 */
async function fixBrokenCssStrings(files: GeneratedFile[], workspaceDir?: string): Promise<void> {
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;

    const lines = file.content.split('\n');
    let changed = false;
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
      let line = lines[i];
      // Count unescaped single and double quotes to detect unclosed string.
      // Template literals (backtick) are intentionally excluded — they ARE allowed to span lines.
      let inDouble = false;
      let inSingle = false;
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (ch === '\\') { ci++; continue; } // skip escaped char
        if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "'" && !inDouble) inSingle = !inSingle;
      }

      // If we ended the line still inside a string, join with the next line.
      while ((inDouble || inSingle) && i + 1 < lines.length) {
        i++;
        const nextLine = lines[i].replace(/^\s+/, ' '); // collapse leading whitespace to single space
        line = line + nextLine;
        changed = true;
        // Re-scan the joined line to see if string is now closed.
        inDouble = false;
        inSingle = false;
        for (let ci = 0; ci < line.length; ci++) {
          const ch = line[ci];
          if (ch === '\\') { ci++; continue; }
          if (ch === '"' && !inSingle) inDouble = !inDouble;
          else if (ch === "'" && !inDouble) inSingle = !inSingle;
        }
      }

      out.push(line);
      i++;
    }

    if (changed) {
      file.content = out.join('\n');
      debug('testFixAgent:broken-css-strings-fix', { path: file.path });
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try { await fs.writeFile(abs, file.content, 'utf8'); } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Fixes JS object literals that have duplicate keys.
 * esbuild treats these as errors: `Duplicate key "padding" in object literal`.
 * Strategy: for each duplicate key in a const styles = { ... } or similar block,
 * keep only the first definition (later ones usually have the same value).
 * Mutates files in-place and writes corrected content to disk when workspaceDir is provided.
 */
async function fixDuplicateObjectKeys(files: GeneratedFile[], workspaceDir?: string): Promise<void> {
  // Match top-level object literals: const/let/var X = { ... } or export const X = { ... }
  // Also handles inline style objects: style={{ key: val, key: val }}
  // Uses a brace-depth counter to find the matching closing brace rather than a greedy regex,
  // so nested objects don't confuse the scan.
  function dedupeObjectBody(body: string): { body: string; changed: boolean } {
    const keyRe = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;
    const seen = new Set<string>();
    const dupeKeys = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body)) !== null) {
      const key = m[1];
      if (seen.has(key)) dupeKeys.add(key);
      else seen.add(key);
    }
    if (dupeKeys.size === 0) return { body, changed: false };

    let fixedBody = body;
    for (const key of dupeKeys) {
      const firstOccRe = new RegExp(`(^|\\n)([ \\t]*)${key}\\s*:[^,\\n}]+(?:,)?`, '');
      fixedBody = fixedBody.replace(firstOccRe, '$1');
    }
    return { body: fixedBody, changed: fixedBody !== body };
  }

  // Finds object literal body (between { and matching }) starting at `start` in `src`.
  function extractObjectBody(src: string, start: number): { body: string; end: number } | null {
    if (src[start] !== '{') return null;
    let depth = 0;
    let i = start;
    while (i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return { body: src.slice(start + 1, i), end: i }; }
      i++;
    }
    return null;
  }

  // Pattern: (export )?(const|let|var) <name> = {
  const varDeclRe = /\b(?:export\s+)?(?:const|let|var)\s+\w[\w$]*\s*=\s*\{/g;

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;

    let src = file.content;
    let changed = false;

    let match: RegExpExecArray | null;
    varDeclRe.lastIndex = 0;
    // Collect matches in reverse order so we can splice without shifting indices.
    const matches: Array<{ blockStart: number }> = [];
    while ((match = varDeclRe.exec(src)) !== null) {
      matches.push({ blockStart: match.index + match[0].length - 1 });
    }

    for (let mi = matches.length - 1; mi >= 0; mi--) {
      const { blockStart } = matches[mi];
      const extracted = extractObjectBody(src, blockStart);
      if (!extracted) continue;
      const { body, end } = extracted;
      const result = dedupeObjectBody(body);
      if (!result.changed) continue;
      src = src.slice(0, blockStart + 1) + result.body + src.slice(end);
      changed = true;
    }

    if (changed) {
      file.content = src;
      debug('testFixAgent:duplicate-object-keys-fix', { path: file.path });
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try { await fs.writeFile(abs, src, 'utf8'); } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Detects the pattern where a component is declared as `const X = ...` (or `function X`)
 * and then re-declared as `export default function X`, which causes esbuild to crash with
 * "symbol already declared". Rewrites the redundant export default to `export { X as default }`.
 * Mutates files in-place and writes corrected content to disk when workspaceDir is provided.
 */
async function fixDuplicateExportDefaultInFiles(files: GeneratedFile[], workspaceDir?: string): Promise<void> {
  // Matches: export default function Name(...) { ... }
  // where Name was already declared in the same file.
  const exportDefaultFnRe = /^export\s+default\s+function\s+(\w+)\s*[(<]/m;
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;
    const m = exportDefaultFnRe.exec(file.content);
    if (!m) continue;
    const name = m[1];
    // Check if the same name is declared earlier (const X, function X, class X, let X, var X)
    const priorDeclRe = new RegExp(`(?:const|let|var|function|class)\\s+${name}\\b`);
    if (!priorDeclRe.test(file.content)) continue;

    // Rename `export default function Name` → `function _NameDefaultExport` and add re-export.
    const simpleFix = file.content.replace(
      exportDefaultFnRe,
      (match) => match.replace(`export default function ${name}`, `function _${name}DefaultExport`)
    ).replace(/\n?$/, `\nexport default _${name}DefaultExport;\n`);

    file.content = simpleFix;
    debug('testFixAgent:duplicate-export-default-fix', { path: file.path, name });
    if (workspaceDir) {
      const abs = path.join(workspaceDir, 'frontend', file.path);
      try { await fs.writeFile(abs, simpleFix, 'utf8'); } catch { /* best-effort */ }
    }
  }
}

/**
 * Rewrites react-icons named imports in generated files to fix known bad export names.
 * Mutates files in-place and writes corrected content to disk when workspaceDir is provided.
 */
async function fixReactIconsInFiles(files: GeneratedFile[], workspaceDir?: string, buildLogs?: string): Promise<void> {
  const missingFromLogs = buildLogs ? parseMissingIconsFromLogs(buildLogs) : undefined;
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;
    if (!file.content.includes('react-icons')) continue;
    const fixed = fixReactIconsImports(file.content, missingFromLogs);
    if (fixed) {
      file.content = fixed;
      debug('testFixAgent:react-icons-fix', { path: file.path });
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try {
          await fs.writeFile(abs, fixed, 'utf8');
        } catch { /* best-effort */ }
      }
    }
  }
}

/**
 * Scans all JS/TS files for imports, adds any missing packages to package.json.
 * Returns updated package.json content or null if nothing changed.
 */
function validateAndFixPackageJson(files: GeneratedFile[], pkgPath: 'package.json' | 'backend/package.json'): string | null {
  const packageJsonFile = files.find(f => f.path === pkgPath);
  if (!packageJsonFile) return null;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; [k: string]: unknown };
  try { pkg = JSON.parse(packageJsonFile.content); }
  catch { logWarn('testFixAgent:validateAndFixPackageJson', 'failed to parse ' + pkgPath); return null; }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};
  const allDeclared = new Set([...Object.keys(deps), ...Object.keys(devDeps)]);

  const importedModules = new Set<string>();
  const es6Re = /import\s+(?:{[^}]*}|[^from'"]*)\s+from\s+['"]([^'"]+)['"]/g;
  const requireRe = /require\(['"]([^'"]+)['"]\)/g;

  const prefix = pkgPath === 'backend/package.json' ? 'backend/' : '';
  for (const file of files) {
    // Only scan files in the right scope
    if (prefix && !file.path.startsWith(prefix)) continue;
    if (!prefix && file.path.startsWith('backend/')) continue;

    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) continue;

    for (const re of [es6Re, requireRe]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(file.content)) !== null) {
        const mod = match[1];
        if (mod.startsWith('.') || mod.startsWith('/')) continue;
        const rootPkg = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
        if (NODE_BUILTINS.has(rootPkg)) continue;
        importedModules.add(rootPkg);
      }
    }
  }

  const missing: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const mod of importedModules) {
    if (!allDeclared.has(mod)) {
      missing[mod] = KNOWN_LIBRARY_VERSIONS[mod] ?? 'latest';
    } else {
      // Check for version conflicts
      const existingVersion = deps[mod] || devDeps[mod];
      const expectedVersion = KNOWN_LIBRARY_VERSIONS[mod];
      if (expectedVersion && existingVersion !== expectedVersion && !existingVersion.includes('^') && !existingVersion.includes('~')) {
        conflicts.push(`${mod}: existing ${existingVersion}, expected ${expectedVersion}`);
      }
    }
  }

  if (conflicts.length > 0) {
    logWarn('testFixAgent:dependencyConflicts', { pkgPath, conflicts });
  }

  if (Object.keys(missing).length === 0) return null;
  debug('testFixAgent:missingDeps', { pkgPath, missing });
  pkg.dependencies = { ...deps, ...missing };
  return JSON.stringify(pkg, null, 2);
}

async function fingerprintWorkspace(workspaceDir: string): Promise<string> {
  const entries: Array<{ path: string; hash: string }> = [];

  async function walk(dir: string) {
    const children = await fs.readdir(dir, { withFileTypes: true });
    for (const child of children) {
      const childPath = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (child.name === 'node_modules' || child.name === '.git' || child.name === 'dist') continue;
        await walk(childPath);
      } else if (child.isFile()) {
        const content = await fs.readFile(childPath);
        const hash = crypto.createHash('sha256').update(childPath).update(content).digest('hex');
        entries.push({ path: path.relative(workspaceDir, childPath), hash });
      }
    }
  }

  await walk(workspaceDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return crypto.createHash('sha256').update(entries.map((entry) => `${entry.path}:${entry.hash}`).join('|')).digest('hex');
}

/**
 * Ensures Vite's root index.html exists (NOT public/index.html — that's CRA).
 * Vite requires index.html at the workspace root with a module script entry.
 */
async function ensureViteIndexHtml(files: GeneratedFile[], workspaceDir: string): Promise<void> {
  const packageJsonFile = files.find(f => f.path === 'package.json');
  if (!packageJsonFile) return;

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try { pkg = JSON.parse(packageJsonFile.content); }
  catch { return; }

  // Detect Vite projects by devDependencies or build script
  const isVite = Boolean(
    pkg.devDependencies?.['vite'] ||
    pkg.dependencies?.['vite'] ||
    pkg.scripts?.['build']?.includes('vite')
  );
  if (!isVite) return;

  // For Vite: index.html goes at ROOT, not public/
  const normalise = (p: string) => p.replace(/^\/+/, '');
  const hasRootIndexHtml = files.some(f => normalise(f.path) === 'index.html');

  if (!hasRootIndexHtml) {
    debug('testFixAgent:ensureViteIndexHtml', 'Vite project missing root index.html — injecting default');
    const entryFile = files.find(f =>
      normalise(f.path) === 'src/main.jsx' ||
      normalise(f.path) === 'src/main.tsx' ||
      normalise(f.path) === 'src/index.jsx' ||
      normalise(f.path) === 'src/index.tsx'
    );
    const entryPath = entryFile ? `/${entryFile.path.replace(/^\/+/, '')}` : '/src/main.jsx';

    const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entryPath}"></script>
  </body>
</html>
`;
    await fs.mkdir(path.join(workspaceDir, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'frontend', 'index.html'), html, 'utf8');
  }

  // Remove public/index.html if it exists (Vite doesn't need it and it can cause confusion)
  try {
    await fs.rm(path.join(workspaceDir, 'frontend', 'public', 'index.html'), { force: true });
  } catch {}
}

/**
 * Writes .env and .env.production with VITE_API_BASE_URL so the frontend
 * build can resolve the Railway backend URL at build time.
 */
async function writeViteEnvFile(workspaceDir: string): Promise<void> {
  const rawUrl = envConfig.RAILWAY_PUBLIC_URL || '';
  if (!rawUrl) return;
  const backendUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
  const envContent = `VITE_API_BASE_URL=${backendUrl}\n`;
  try {
    const frontendDir = path.join(workspaceDir, 'frontend');
    await fs.mkdir(frontendDir, { recursive: true });
    await fs.writeFile(path.join(frontendDir, '.env'), envContent, 'utf8');
    await fs.writeFile(path.join(frontendDir, '.env.production'), envContent, 'utf8');
    debug('testFixAgent:writeViteEnvFile', { backendUrl });
  } catch (err) {
    logWarn('testFixAgent:writeViteEnvFile', err);
  }
}

/**
 * Ensures backend/db/init.sql exists if backend has a database section.
 */
async function ensureDbInitSql(files: GeneratedFile[], workspaceDir: string): Promise<void> {
  const backendPkg = files.find(f => f.path === 'backend/package.json');
  if (!backendPkg) return;

  const hasInitSql = files.some(f => f.path === 'backend/db/init.sql' || f.path === 'backend/db/schema.sql');
  if (!hasInitSql) {
    debug('testFixAgent:ensureDbInitSql', 'backend missing db/init.sql — injecting empty placeholder');
    const dbDir = path.join(workspaceDir, 'backend', 'db');
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(
      path.join(dbDir, 'init.sql'),
      '-- Database initialization SQL\n-- Tables are created by the backend on startup\n',
      'utf8'
    );
  }
}

/**
 * Extracts the most actionable error lines from build logs.
 * Returns at most ~3000 chars so it fits in the LLM prompt budget.
 */
function extractBuildErrors(logs: string): string {
  const lines = logs.split('\n');
  const errorLines = lines.filter((l) =>
    /error|failed|cannot find|is not exported|unexpected token|does not exist/i.test(l)
  );
  const relevant = errorLines.length > 0 ? errorLines : lines.filter((l) => l.trim());
  return relevant.slice(0, 60).join('\n').slice(0, 3000);
}

/**
 * Identifies which generated file paths are referenced in the build errors.
 */
function findErrorFiles(errors: string, files: GeneratedFile[]): GeneratedFile[] {
  return files.filter((f) => {
    const base = path.basename(f.path);
    return errors.includes(f.path) || errors.includes(base);
  }).slice(0, 6); // cap to avoid oversized prompts
}

/**
 * Uses the test_generation model chain (GPT5_MINI > DEEPSEEK_R1) to analyse
 * build errors and return targeted file patches. Cheaper and faster than a full
 * code-generation regen — only fixes the files that are actually broken.
 *
 * Returns true if at least one file was patched.
 */
async function llmFixBuildErrors(
  files: GeneratedFile[],
  buildLogs: string,
  workspaceDir?: string,
  projectId?: string
): Promise<boolean> {
  const errors = extractBuildErrors(buildLogs);
  if (!errors.trim()) return false;

  const errorFiles = findErrorFiles(errors, files);
  if (errorFiles.length === 0) {
    debug('llmFixBuildErrors:no-error-files', { errors: errors.slice(0, 200) });
    return false;
  }

  try {
    const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('test_generation');
    const llmProxy = new LLMProxyClient({ apiKey, projectId, fallbacks });

    const systemPrompt = `You are a build-error repair specialist for React/Vite/TypeScript projects.
You are given build error logs and the source files that caused them.
Return ONLY valid JSON — no markdown, no prose — in this exact shape:
{
  "patches": [
    { "path": "relative/file/path", "content": "complete fixed file content" }
  ]
}
Rules:
- Only include files you actually changed.
- Return the COMPLETE file content, not a diff.
- Fix ALL errors you can identify in the file; do not introduce new ones.
- Do not add packages that are not in package.json.
- If you cannot fix a file confidently, omit it from patches.`;

    const userPrompt = JSON.stringify({
      errors,
      files: errorFiles.map((f) => ({ path: f.path, content: f.content.slice(0, 6000) })),
    });

    const completion = await llmProxy.chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      model,
      0.2,
      0.9,
      4096
    );

    const raw = completion.choices?.[0]?.message?.content || '{}';
    debug('llmFixBuildErrors:raw', { snippet: raw.slice(0, 300) });

    const parsed = parseJsonResponse(raw);
    const patches: Array<{ path: string; content: string }> = Array.isArray(parsed?.patches)
      ? parsed.patches.filter(
          (p: unknown): p is { path: string; content: string } =>
            typeof (p as any)?.path === 'string' && typeof (p as any)?.content === 'string'
        )
      : [];

    if (patches.length === 0) return false;

    let changed = false;
    for (const patch of patches) {
      const target = files.find((f) => f.path === patch.path);
      if (!target) continue;
      target.content = patch.content;
      changed = true;
      debug('llmFixBuildErrors:patched', { path: patch.path });
      if (workspaceDir) {
        const subdir = patch.path.startsWith('backend/') ? 'backend' : 'frontend';
        const relPath = patch.path.startsWith('backend/')
          ? patch.path.slice('backend/'.length)
          : patch.path;
        const abs = path.join(workspaceDir, subdir, relPath);
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, patch.content, 'utf8');
        } catch { /* best-effort */ }
      }
    }

    return changed;
  } catch (err) {
    logWarn('llmFixBuildErrors:error', err);
    return false;
  }
}

export async function testFixAgent(input: {
  buildFn: () => Promise<{ success: boolean; logs: string }>;
  /** Return the updated file set so testFixAgent can re-scan imports after healing. */
  fixFn?: (logs: string) => Promise<GeneratedFile[] | void>;
  files?: GeneratedFile[];
  workspaceDir?: string;
  projectId?: string;
  emitInfo?: (message: string) => void;
  /** Epoch ms deadline. Attempts are skipped when < 60 s remain. */
  deadlineAt?: number;
}) {
  debug('testFixAgent:start', { workspaceDir: input.workspaceDir, projectId: input.projectId });
  const info = (msg: string) => { try { input.emitInfo?.(msg); } catch { /* best-effort */ } };
  info('Preparing build workspace...');

  // ── Pre-build: write VITE_API_BASE_URL to .env / .env.production ──────────
  if (input.workspaceDir) {
    try {
      await writeViteEnvFile(input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:vite-env-write', err);
    }
  }

  // ── Pre-build: ensure Vite index.html at root (not public/) ──────────────
  if (input.files && input.workspaceDir) {
    try {
      await ensureViteIndexHtml(input.files, input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:vite-index-check', err);
    }
  }

  // ── Pre-build: ensure backend db/init.sql exists ─────────────────────────
  if (input.files && input.workspaceDir) {
    try {
      await ensureDbInitSql(input.files, input.workspaceDir);
    } catch (err) {
      logWarn('testFixAgent:db-init-sql-check', err);
    }
  }

  // Helper: runs all deterministic pre-build fixes on the current in-memory files and
  // writes the results to disk. Called before the first attempt AND after each self-heal
  // so that package.json always reflects the healed file set.
  async function applyPreBuildFixes(buildLogs?: string): Promise<void> {
    if (!input.files) return;
    // Join CSS string literals that were split across lines by the LLM (syntax error).
    try { await fixBrokenCssStrings(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:broken-css-strings-fix', err); }
    // Fix duplicate `export default function X` where X was already declared.
    try { await fixDuplicateExportDefaultInFiles(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:duplicate-export-fix', err); }
    // Fix duplicate JSX attributes (e.g. style={A} ... style={B} on same element).
    try { await fixDuplicateJsxAttributes(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:duplicate-jsx-attr-fix', err); }
    // Fix duplicate keys in JS object literals (e.g. const styles = { padding:12, ..., padding:8 }).
    try { await fixDuplicateObjectKeys(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:duplicate-object-keys-fix', err); }
    // Rewrite known-bad react-icons named imports.
    try { await fixReactIconsInFiles(input.files, input.workspaceDir, buildLogs); } catch (err) { logWarn('testFixAgent:react-icons-fix', err); }
    // Add missing frontend dependencies.
    if (input.workspaceDir) {
      try {
        const updatedPkg = validateAndFixPackageJson(input.files, 'package.json');
        if (updatedPkg) {
          await fs.mkdir(path.join(input.workspaceDir, 'frontend'), { recursive: true });
          await fs.writeFile(path.join(input.workspaceDir, 'frontend', 'package.json'), updatedPkg, 'utf8');
          const inMem = input.files.find(f => f.path === 'package.json');
          if (inMem) inMem.content = updatedPkg;
        }
      } catch (err) { logWarn('testFixAgent:frontend-pkg-fix', err); }
      // Add missing backend dependencies.
      if (input.files.some(f => f.path === 'backend/package.json')) {
        try {
          const updatedPkg = validateAndFixPackageJson(input.files, 'backend/package.json');
          if (updatedPkg) {
            await fs.writeFile(path.join(input.workspaceDir, 'backend', 'package.json'), updatedPkg, 'utf8');
            const inMem = input.files.find(f => f.path === 'backend/package.json');
            if (inMem) inMem.content = updatedPkg;
          }
        } catch (err) { logWarn('testFixAgent:backend-pkg-fix', err); }
      }
    }
  }

  await applyPreBuildFixes();

  // ── Build loop: up to 3 attempts with AI fix between each ─────────────────
  const MIN_ATTEMPT_BUDGET_MS = 60_000;
  let retries = 0;
  let lastResult: { success: boolean; logs: string } | undefined;

  try {
    do {
      if (input.deadlineAt && input.deadlineAt - Date.now() < MIN_ATTEMPT_BUDGET_MS) {
        const remaining = Math.max(0, input.deadlineAt - Date.now());
        throw new Error(`Orchestration timeout — only ${remaining}ms remaining before build attempt ${retries + 1}`);
      }
      info(`Build attempt ${retries + 1} of 3 — running npm install and build (this can take a few minutes)...`);
      debug('testFixAgent:attempt', { attempt: retries + 1 });
      const currentResult = await input.buildFn();
      debug('testFixAgent:buildResult', { success: currentResult.success });

      if (currentResult.success) {
        info(retries > 0 ? `Build succeeded after ${retries + 1} attempt(s).` : 'Build succeeded.');
        debug('testFixAgent:success', { fixed: retries > 0 });
        return { ...currentResult, fixed: retries > 0 };
      }

      lastResult = currentResult;

      // Lightweight LLM patch pass before the expensive full-regen fixFn.
      if (input.files && retries < 2) {
        try {
          const patched = await llmFixBuildErrors(input.files, lastResult.logs, input.workspaceDir, input.projectId);
          if (patched) {
            info(`LLM targeted patch applied (attempt ${retries + 1}) — retrying build...`);
            debug('testFixAgent:llm-patch-applied', { retry: retries + 1 });
            retries++;
            continue;
          }
        } catch (llmErr) {
          logWarn('testFixAgent:llm-patch-error', llmErr);
        }
      }

      if (input.fixFn && retries < 2) {
        info(`Build failed — invoking AI self-heal (attempt ${retries + 1})...`);
        debug('testFixAgent:invoking-fixFn', { retry: retries + 1 });
        try {
          const preSnapshot = input.workspaceDir ? await fingerprintWorkspace(input.workspaceDir) : undefined;
          const healedFiles = await input.fixFn(lastResult.logs);
          // Sync input.files to the healed set so applyPreBuildFixes scans the right imports.
          // Without this, package.json is updated against stale imports and new deps (e.g.
          // react-router-dom) added by the healed code are silently missing from the build.
          if (healedFiles && healedFiles.length > 0) {
            input.files = healedFiles;
          }
          if (input.workspaceDir && preSnapshot) {
            const postSnapshot = await fingerprintWorkspace(input.workspaceDir);
            if (preSnapshot === postSnapshot) {
              logWarn('testFixAgent:fixFn-noop', { retry: retries + 1, workspaceDir: input.workspaceDir });
              break;
            }
          }
        } catch (fixErr) {
          logError('testFixAgent:fixFn-error', { error: fixErr instanceof Error ? fixErr.message : String(fixErr), stage: 'fixFn', retries });
        }
        // Re-apply deterministic fixes on the (possibly healed) files so package.json stays in sync.
        await applyPreBuildFixes(lastResult.logs);
      }
      retries++;
    } while (retries < 3);

    const lastLogs = lastResult?.logs || 'No build output.';
    throw new Error(`Build failed after 3 attempts.\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    logError('testFixAgent', { error: err instanceof Error ? err.message : String(err), stage: 'testFixAgent', stack: err instanceof Error ? err.stack?.slice(0, 400) : undefined });
    throw err;
  }
}
