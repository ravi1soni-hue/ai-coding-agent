// Test & Fix Agent
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import ts from 'typescript';
import { debug, warn as logWarn, error as logError } from '../utils/logger';
import { config as envConfig } from '../config/env';
import { getModelPriorityChain } from './modelRouter';
import { LLMProxyClient } from './llmProxyClient';
import { parseJsonResponse } from './llmUtils';

/**
 * Runs ts.transpileModule on a JS/TS/JSX file and returns any syntax errors.
 * Used to validate patched files before writing them — avoids burning a retry
 * cycle on a fix that the LLM got wrong again.
 */
function transpileCheck(filePath: string, content: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) return null;
  const jsx = ['.jsx', '.tsx'].includes(ext) ? ts.JsxEmit.Preserve : undefined;
  const result = ts.transpileModule(content, {
    compilerOptions: { jsx, target: ts.ScriptTarget.ES2020 },
    fileName: filePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return null;
  return errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ');
}

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
  // Frontend — drag & drop
  'react-beautiful-dnd': '^13.1.1',
  '@dnd-kit/core': '^6.1.0',
  '@dnd-kit/sortable': '^7.0.0',
  '@dnd-kit/utilities': '^3.2.2',
  'react-dnd': '^16.0.1',
  'react-dnd-html5-backend': '^16.0.1',
  // Frontend — file / media
  'react-dropzone': '^14.2.3',
  'react-image-crop': '^11.0.5',
  'react-colorful': '^5.6.1',
  // Frontend — forms / selects
  'react-select': '^5.8.0',
  'react-datepicker': '^6.1.0',
  // Frontend — markdown / code
  'react-markdown': '^9.0.1',
  'remark-gfm': '^4.0.0',
  'prismjs': '^1.29.0',
  'highlight.js': '^11.9.0',
  // Frontend — UI component libraries
  '@mui/material': '^5.15.0',
  '@mui/icons-material': '^5.15.0',
  'antd': '^5.12.0',
  'primereact': '^10.2.0',
  'prop-types': '^15.8.1',
  // Frontend — virtualization / tables
  'react-virtualized': '^9.22.5',
  'react-window': '^1.8.10',
  'react-table': '^7.8.0',
  // Frontend — misc utilities
  'react-copy-to-clipboard': '^5.1.0',
  'react-use': '^17.5.0',
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
        try { await fs.writeFile(abs, result, 'utf8'); } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
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
/**
 * Detects files where real code was accidentally placed inside `//` comment lines
 * (a known LLM truncation artifact). When a `//` comment line contains both a
 * closing `}` that would end a function/component AND an `export default`, the
 * entire comment content is uncommented so the build can parse it correctly.
 */
async function fixCodeInComments(files: GeneratedFile[], workspaceDir?: string): Promise<void> {
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;

    const lines = file.content.split('\n');
    let changed = false;

    // Detect runs of consecutive `//` comment lines that form a real code block.
    // A run qualifies if: it contains a function/class/const declaration AND balances
    // braces net-zero (complete block) or the run contains `export default`.
    // We scan all runs, collect qualifying ones, then uncomment them.
    const commentRunRe = /^(\s*)\/\/\s?(.*)$/;
    let i = 0;
    const out: string[] = [];
    while (i < lines.length) {
      // Collect a run of consecutive comment lines
      if (!commentRunRe.test(lines[i])) {
        out.push(lines[i++]);
        continue;
      }
      const runStart = i;
      const runLines: string[] = [];
      while (i < lines.length && commentRunRe.test(lines[i])) {
        runLines.push(lines[i++]);
      }
      // Extract indentation and body for each line in the run
      const bodies = runLines.map(l => {
        const m = l.match(commentRunRe)!;
        return { indent: m[1], body: m[2] };
      });
      const runBody = bodies.map(b => b.body).join('\n');

      const hasCodeKeyword = /\b(function|const|let|var|class|return|export default|=>)\b/.test(runBody);
      const openBraces = (runBody.match(/[{(]/g) || []).length;
      const closeBraces = (runBody.match(/[})]/g) || []).length;
      const balanced = Math.abs(openBraces - closeBraces) <= 1; // allow 1 off for arrow fns
      const hasExportDefault = runBody.includes('export default');

      if (hasCodeKeyword && (balanced || hasExportDefault) && runLines.length >= 2) {
        // Uncomment the entire run
        for (const b of bodies) out.push(b.indent + b.body);
        changed = true;
        debug('testFixAgent:code-in-comment-fix', { path: file.path, runStart, runLength: runLines.length });
      } else {
        // Not a code block — keep as comments
        for (const l of runLines) out.push(l);
      }
    }

    if (changed) {
      file.content = out.join('\n');
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try {
          await fs.writeFile(abs, file.content, 'utf8');
        } catch (writeErr) {
          logWarn('testFixAgent:code-in-comment-disk-write', { path: abs, err: String(writeErr) });
        }
      }
    }
  }
}

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
    }

    // Second pass: regex-based fix for gradient/rgba continuation lines that the
    // string-scanner misses (e.g. template literals or partial-line joins).
    // Pattern: a line that starts with a hex color (#rrggbb) or bare numeric continuation
    // that can only appear as the continuation of a CSS value string.
    const gradientContRe = /^(\s*)(#[0-9a-fA-F]{3,8}[^'"\n]*['"),])/;
    const cssLines = file.content.split('\n');
    let cssChanged = false;
    for (let li = 1; li < cssLines.length; li++) {
      if (gradientContRe.test(cssLines[li])) {
        cssLines[li - 1] = cssLines[li - 1].trimEnd() + ' ' + cssLines[li].trimStart();
        cssLines.splice(li, 1);
        li--;
        cssChanged = true;
      }
    }
    if (cssChanged) {
      file.content = cssLines.join('\n');
      debug('testFixAgent:gradient-continuation-fix', { path: file.path });
    }

    if (changed || cssChanged) {
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        try { await fs.writeFile(abs, file.content, 'utf8'); } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
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
        try { await fs.writeFile(abs, src, 'utf8'); } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
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
      try { await fs.writeFile(abs, simpleFix, 'utf8'); } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
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
        } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
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
      if (KNOWN_LIBRARY_VERSIONS[mod]) {
        missing[mod] = KNOWN_LIBRARY_VERSIONS[mod];
      }
      // else: skip unknown packages — adding them as 'latest' can crash npm install
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
 * Fixes bare (non-relative) import paths that should be relative.
 * e.g. `from 'components/Button'` → `from './components/Button'`
 * Vite treats these as node_modules, causing module-not-found errors.
 */
function fixBareImportPaths(files: GeneratedFile[], workspaceDir?: string): void {
  const SRC_PREFIXES = ['components/', 'pages/', 'hooks/', 'utils/', 'services/', 'lib/', 'context/', 'store/', 'types/'];
  for (const file of files) {
    if (!/\.(jsx?|tsx?)$/.test(file.path)) continue;
    let changed = false;
    const result = file.content.replace(/from\s+(['"])([^'"]+)\1/g, (match, q, imp) => {
      if (imp.startsWith('.') || imp.startsWith('/')) return match;
      if (SRC_PREFIXES.some(p => imp.startsWith(p))) {
        changed = true;
        return `from ${q}./${imp}${q}`;
      }
      return match;
    });
    if (changed) {
      file.content = result;
      if (workspaceDir) {
        const abs = path.join(workspaceDir, 'frontend', file.path);
        fs.writeFile(abs, result, 'utf8').catch((writeErr) => { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); });
      }
    }
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
  }).slice(0, 24); // raised from 6: large projects can have 30+ broken files
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
You are given build error logs and ONE source file that caused errors.
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

    let changed = false;

    // Send one LLM call per file to avoid context overflow when many files are broken.
    // 3 concurrent calls keeps throughput high without hammering rate limits.
    const FILE_BATCH = 3;
    for (let i = 0; i < errorFiles.length; i += FILE_BATCH) {
      const batch = errorFiles.slice(i, i + FILE_BATCH);
      const results = await Promise.allSettled(batch.map(async (errorFile) => {
        // Filter log lines that mention this specific file to reduce prompt size
        const fileErrors = errors.split('\n')
          .filter(l => l.includes(errorFile.path) || l.includes(path.basename(errorFile.path)) || /error/i.test(l))
          .slice(0, 40).join('\n');

        const completion = await llmProxy.chatCompletion(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({
              errors: fileErrors,
              file: { path: errorFile.path, content: errorFile.content },
            })},
          ],
          model,
          0.0,  // temperature 0 for deterministic repair
          0.9,
          12000
        );

        const raw = completion.choices?.[0]?.message?.content || '{}';
        debug('llmFixBuildErrors:raw', { path: errorFile.path, snippet: raw.slice(0, 200) });

        const parsed = parseJsonResponse(raw);
        const patches: Array<{ path: string; content: string }> = Array.isArray(parsed?.patches)
          ? parsed.patches.filter(
              (p: unknown): p is { path: string; content: string } =>
                typeof (p as any)?.path === 'string' && typeof (p as any)?.content === 'string'
            )
          : [];

        for (const patch of patches) {
          const target = files.find((f) => f.path === patch.path);
          if (!target) continue;
          // Reject the patch if it still has syntax errors — don't burn a retry on a broken fix.
          const syntaxErr = transpileCheck(patch.path, patch.content);
          if (syntaxErr) {
            logWarn('llmFixBuildErrors:patch-still-broken', { path: patch.path, error: syntaxErr });
            continue;
          }
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
            } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
          }
        }
      }));

      for (const r of results) {
        if (r.status === 'rejected') logWarn('llmFixBuildErrors:file-error', r.reason);
      }
    }

    return changed;
  } catch (err) {
    logWarn('llmFixBuildErrors:error', err);
    return false;
  }
}

/**
 * Spec-based file regeneration: when a file fails to build, extract its
 * component spec from the blueprint and regenerate it from spec + error
 * rather than patching from truncated content.
 * Returns true if at least one file was regenerated.
 */
async function specBasedFileRegeneration(
  files: GeneratedFile[],
  buildLogs: string,
  blueprint?: any,
  workspaceDir?: string,
  projectId?: string
): Promise<boolean> {
  const errors = extractBuildErrors(buildLogs);
  if (!errors.trim()) return false;

  const errorFiles = findErrorFiles(errors, files);
  if (errorFiles.length === 0) return false;

  const componentSpecs: any[] = blueprint?.strict?.structure?.frontend?.components || [];

  try {
    const [{ model, apiKey }, ...fallbacks] = getModelPriorityChain('test_generation');
    const llmProxy = new LLMProxyClient({ apiKey, projectId, fallbacks });

    let changed = false;

    // Process in parallel batches of 8 — serial was ~10s/file causing deadline bleed
    const PARALLEL_BATCH = 8;
    for (let batchStart = 0; batchStart < errorFiles.length; batchStart += PARALLEL_BATCH) {
      const batch = errorFiles.slice(batchStart, batchStart + PARALLEL_BATCH);
      const results = await Promise.allSettled(batch.map(async (errorFile) => {
        const componentName = path.basename(errorFile.path, path.extname(errorFile.path));
        const spec = componentSpecs.find((c: any) =>
          c.name === componentName ||
          c.filePath === errorFile.path ||
          String(c.filePath || '').endsWith('/' + path.basename(errorFile.path))
        );

        const blueprintFileEntry = Array.isArray(blueprint?.files)
          ? blueprint.files.find((f: any) => f.path === errorFile.path)
          : null;

        const systemPrompt = `You are a React component repair specialist for Vite/React projects.
${spec ? `Component spec:
- Name: ${spec.name}
- Purpose: ${spec.purpose}
- Props: ${JSON.stringify(spec.props || [])}
- Render logic: ${spec.renderLogic || ''}
${spec.contentData ? `- Exact content values (use verbatim): ${JSON.stringify(spec.contentData)}` : ''}` : `Component: ${componentName}`}
${blueprintFileEntry ? `Blueprint purpose: ${blueprintFileEntry.purpose}` : ''}

You are given the current broken file and the build errors it caused.
Regenerate the file COMPLETELY from scratch using the spec above — fix all errors.

RULES:
- Export: export default function ${componentName}(props) { ... }
- No routing primitives (BrowserRouter, Routes, Route, Link) in this file.
- No TODO comments, no placeholder text, no stub implementations.
- All CSS string values on ONE line — never split rgba() or gradient() across lines.
- Never duplicate JSX attributes or object keys.
- Only import packages that are available in a standard React+Vite project.

Return ONLY a delimited file block:
<<<FILE:${errorFile.path}>>>
...complete fixed file content...
<<<END>>>`;

        const completion = await llmProxy.chatCompletion(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({
              path: errorFile.path,
              currentContent: errorFile.content,
              buildErrors: errors,
            })},
          ],
          model,
          0.0,  // temperature 0 for deterministic repair
          0.9,
          16000
        );

        const raw = completion.choices?.[0]?.message?.content || '';
        const FILE_BLOCK_RE = /<<<FILE:([^\n>]+?)>{2,3}\s*\n([\s\S]*?)\n?<<<END>>>/;
        const m = raw.match(FILE_BLOCK_RE);
        if (m) {
          const newContent = m[2];
          if (newContent && newContent.trim().length > 50) {
            // Reject if the LLM's regenerated file still has syntax errors
            const syntaxErr = transpileCheck(errorFile.path, newContent);
            if (syntaxErr) {
              logWarn('specBasedFileRegeneration:regen-still-broken', { path: errorFile.path, error: syntaxErr });
            } else {
              const target = files.find((f) => f.path === errorFile.path);
              if (target) {
                target.content = newContent;
                changed = true;
                debug('specBasedFileRegeneration:regenerated', { path: errorFile.path });
                if (workspaceDir) {
                  const subdir = errorFile.path.startsWith('backend/') ? 'backend' : 'frontend';
                  const relPath = errorFile.path.startsWith('backend/')
                    ? errorFile.path.slice('backend/'.length)
                    : errorFile.path;
                  const abs = path.join(workspaceDir, subdir, relPath);
                  try {
                    await fs.mkdir(path.dirname(abs), { recursive: true });
                    await fs.writeFile(abs, newContent, 'utf8');
                  } catch (writeErr) { logWarn('testFixAgent:disk-write', { path: abs, err: String(writeErr) }); }
                }
              }
            }
          }
        }
      }));

      for (const result of results) {
        if (result.status === 'rejected') {
          logWarn('specBasedFileRegeneration:batch-file-error', result.reason);
        }
      }
    }

    return changed;
  } catch (err) {
    logWarn('specBasedFileRegeneration:error', err);
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
  /** Project blueprint — used by specBasedFileRegeneration for per-file spec context. */
  blueprint?: any;
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
    // Fix bare import paths: `from 'components/Foo'` → `from './components/Foo'`
    try { fixBareImportPaths(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:bare-import-paths-fix', err); }
    // Uncomment real code accidentally placed inside `//` comment lines by the LLM.
    try { await fixCodeInComments(input.files, input.workspaceDir); } catch (err) { logWarn('testFixAgent:code-in-comment-fix', err); }
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

  // ── Pre-build: regenerate stub components before first build ─────────────
  // Stubs compile successfully (no build error) but render as blank <div>s.
  // Detect them by marker comment and regenerate from spec before the first attempt.
  if (input.files && input.blueprint) {
    try {
      const stubFiles = input.files.filter(f => f.content.includes('STUB_COMPONENT'));
      if (stubFiles.length > 0) {
        info(`Detected ${stubFiles.length} stub component(s) — regenerating before build...`);
        const fakeLogs = stubFiles.map(f => `error: ${f.path}: STUB_COMPONENT placeholder must be replaced`).join('\n');
        await specBasedFileRegeneration(input.files, fakeLogs, input.blueprint, input.workspaceDir, input.projectId);
        // Re-scan imports after stub regeneration — new files may introduce new dependencies.
        await applyPreBuildFixes();
      }
    } catch (err) {
      logWarn('testFixAgent:stub-regen', err);
    }
  }

  // ── Failure classifier ───────────────────────────────────────────────────
  // Maps build log text → a typed failure class so the loop can route to the
  // right handler instead of blindly cycling through all fixers every attempt.
  type FailureClass =
    | 'missing_dependency'
    | 'missing_file'
    | 'syntax_error'
    | 'bad_export'
    | 'duplicate_key'
    | 'bad_icon_import'
    | 'type_error'
    | 'runtime_blank'
    | 'unknown';

  function classifyBuildFailure(logs: string): FailureClass {
    if (/Cannot find module|Module not found|Failed to resolve import/i.test(logs)) {
      // Distinguish missing npm package vs missing local file
      if (/Failed to resolve import ['"]\./.test(logs)) return 'missing_file';
      return 'missing_dependency';
    }
    if (/Unterminated string constant|Unexpected token|Unexpected end of (input|file)|Expected.*but found/i.test(logs)) return 'syntax_error';
    if (/Duplicate export|export default.*already (declared|defined)|Multiple exports named 'default'/i.test(logs)) return 'bad_export';
    if (/Duplicate key|duplicate property/i.test(logs)) return 'duplicate_key';
    if (/react-icons|FaIcon|is not exported from 'react-icons/i.test(logs)) return 'bad_icon_import';
    if (/TS\d{4}|Type '.*' is not assignable|Property '.*' does not exist/i.test(logs)) return 'type_error';
    return 'unknown';
  }

  // ── Unknown-failure diagnostic handler ──────────────────────────────────
  // Last resort: ask the LLM to diagnose which file is broken and emit a
  // repaired version as JSON. Validates the repair with transpileCheck before
  // applying it so a bad LLM fix doesn't burn another retry cycle.
  async function unknownDiagnosticHandler(logs: string): Promise<boolean> {
    if (!input.files) return false;
    try {
      const errors = extractBuildErrors(logs);
      const fileSummary = (input.files || [])
        .filter(f => ['.js', '.jsx', '.ts', '.tsx'].includes(path.extname(f.path)))
        .map(f => `${f.path} (${f.content.split('\n').length} lines)`)
        .join('\n');

      // Include content of files mentioned in the error log for context
      const errorFiles = findErrorFiles(errors, input.files || []);
      const fileContents = errorFiles.slice(0, 3).map(f =>
        `=== ${f.path} ===\n${f.content.slice(0, 2000)}`
      ).join('\n\n');

      const prompt = `You are a build error diagnostic agent for a React + Vite project.

BUILD ERRORS:
${errors}

PROJECT FILES:
${fileSummary}

BROKEN FILE CONTENT:
${fileContents}

Task: Identify exactly which file is broken, the root cause, and output a complete repaired version.

Respond with ONLY this JSON (no markdown fences):
{
  "brokenFile": "src/components/Foo.jsx",
  "rootCause": "one sentence description",
  "repairedContent": "...complete fixed file content as a JSON string..."
}

Rules:
- repairedContent must be the ENTIRE file, not a diff or partial snippet
- Validate that braces, parentheses, and JSX tags are balanced before outputting
- Use only React 18 + plain JSX — no TypeScript types in .jsx files
- If you cannot determine a fix with high confidence, set repairedContent to null`;

      const [{ model: primaryModel, apiKey }, ...fallbacks] = getModelPriorityChain('test_generation');
      const client = new LLMProxyClient({ apiKey, projectId: input.projectId, fallbacks });
      let rawResponse = '';
      try {
        const completion = await client.chatCompletion(
          [{ role: 'user', content: prompt }],
          primaryModel,
          0,    // temperature=0 for deterministic repair
          0.9,
          4096
        );
        rawResponse = completion.choices?.[0]?.message?.content || '';
      } catch (llmErr) {
        logWarn('testFixAgent:unknown-handler-llm', llmErr);
      }

      const parsed = parseJsonResponse(rawResponse) as { brokenFile?: string; rootCause?: string; repairedContent?: string | null } | null;
      if (!parsed || !parsed.brokenFile || !parsed.repairedContent) {
        debug('testFixAgent:unknown-handler-null', { rootCause: parsed?.rootCause });
        return false;
      }

      // Validate the repair before applying — don't accept a fix that introduces new syntax errors
      const transpileErr = transpileCheck(parsed.brokenFile, parsed.repairedContent);
      if (transpileErr) {
        logWarn('testFixAgent:unknown-handler-bad-repair', { file: parsed.brokenFile, transpileErr });
        return false;
      }

      // Apply the repair to in-memory files and disk
      const target = (input.files || []).find(f => f.path === parsed.brokenFile || f.path.endsWith('/' + parsed.brokenFile!.split('/').pop()));
      if (target) {
        target.content = parsed.repairedContent;
      } else {
        // File wasn't in input.files — add it
        (input.files || []).push({ path: parsed.brokenFile, content: parsed.repairedContent });
      }

      if (input.workspaceDir) {
        const subdir = parsed.brokenFile.startsWith('backend/') ? '' : 'frontend';
        const relPath = parsed.brokenFile.startsWith('backend/') ? parsed.brokenFile.slice('backend/'.length) : parsed.brokenFile;
        const abs = path.join(input.workspaceDir, subdir, relPath);
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, parsed.repairedContent, 'utf8');
        } catch (writeErr) { logWarn('testFixAgent:unknown-handler-write', { path: abs, err: String(writeErr) }); }
      }

      info(`Diagnostic repair applied to ${parsed.brokenFile}: ${parsed.rootCause}`);
      debug('testFixAgent:unknown-handler-applied', { file: parsed.brokenFile, rootCause: parsed.rootCause });
      return true;
    } catch (err) {
      logWarn('testFixAgent:unknown-handler-error', err);
      return false;
    }
  }

  // ── Handler dispatch table ───────────────────────────────────────────────
  // Each failure class maps to an ordered list of handlers. Handlers are tried
  // in order; the first one that returns true short-circuits the rest.
  // All handlers return true = "something changed, retry the build".
  type Handler = (logs: string) => Promise<boolean>;

  const HANDLER_MAP: Record<FailureClass, Handler[]> = {
    missing_dependency: [
      // Deterministic: re-run package.json fixer (scans imports, adds known deps)
      async (logs) => { await applyPreBuildFixes(logs); return true; },
    ],
    missing_file: [
      // Spec-based regen: regenerate the missing file from blueprint spec
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
      // Fallback: LLM patch to fix the import path
      async (logs) => input.files
        ? llmFixBuildErrors(input.files, logs, input.workspaceDir, input.projectId)
        : false,
    ],
    syntax_error: [
      // Deterministic: CSS string joiner + comment-code fixer
      async (logs) => { await applyPreBuildFixes(logs); return true; },
      // Spec regen: regenerate broken file from original spec
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
      // LLM patch: targeted fix of the broken lines
      async (logs) => input.files
        ? llmFixBuildErrors(input.files, logs, input.workspaceDir, input.projectId)
        : false,
    ],
    bad_export: [
      // Deterministic: fixDuplicateExportDefaultInFiles is inside applyPreBuildFixes
      async (logs) => { await applyPreBuildFixes(logs); return true; },
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
    ],
    duplicate_key: [
      // Deterministic: fixDuplicateObjectKeys is inside applyPreBuildFixes
      async (logs) => { await applyPreBuildFixes(logs); return true; },
    ],
    bad_icon_import: [
      // Deterministic: fixReactIconsInFiles is inside applyPreBuildFixes
      async (logs) => { await applyPreBuildFixes(logs); return true; },
      async (logs) => input.files
        ? llmFixBuildErrors(input.files, logs, input.workspaceDir, input.projectId)
        : false,
    ],
    type_error: [
      // LLM patch first — type errors need semantic understanding
      async (logs) => input.files
        ? llmFixBuildErrors(input.files, logs, input.workspaceDir, input.projectId)
        : false,
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
    ],
    runtime_blank: [
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
    ],
    unknown: [
      // Full LLM diagnosis: identify the broken file and emit a complete repair
      async (logs) => unknownDiagnosticHandler(logs),
      // Last resort: spec regen of any file mentioned in the logs
      async (logs) => input.files && input.blueprint
        ? specBasedFileRegeneration(input.files, logs, input.blueprint, input.workspaceDir, input.projectId)
        : false,
      // Final fallback: legacy fixFn (full-project heal)
      async (logs) => {
        if (!input.fixFn) return false;
        const preSnapshot = input.workspaceDir ? await fingerprintWorkspace(input.workspaceDir) : undefined;
        const healedFiles = await input.fixFn(logs);
        if (healedFiles && healedFiles.length > 0) input.files = healedFiles;
        if (input.workspaceDir && preSnapshot) {
          const postSnapshot = await fingerprintWorkspace(input.workspaceDir);
          if (preSnapshot === postSnapshot) return false;
        }
        return true;
      },
    ],
  };

  // ── Build loop: wall-clock budget, classify → dispatch → retry ──────────
  const WALL_CLOCK_BUDGET_MS = 8 * 60 * 1000; // 8 min hard cap
  const MIN_ATTEMPT_BUDGET_MS = 60_000;
  const loopStart = Date.now();
  let attempt = 0;
  let lastResult: { success: boolean; logs: string } | undefined;
  // Track which (failureClass, handlerIndex) pairs have been tried to avoid infinite loops
  const triedHandlers = new Set<string>();

  try {
    while (Date.now() - loopStart < WALL_CLOCK_BUDGET_MS) {
      if (input.deadlineAt && input.deadlineAt - Date.now() < MIN_ATTEMPT_BUDGET_MS) {
        const remaining = Math.max(0, input.deadlineAt - Date.now());
        throw new Error(`Orchestration timeout — only ${remaining}ms remaining before build attempt ${attempt + 1}`);
      }

      attempt++;
      info(`Build attempt ${attempt} — running npm install and build...`);
      debug('testFixAgent:attempt', { attempt });
      const currentResult = await input.buildFn();
      debug('testFixAgent:buildResult', { success: currentResult.success });

      if (currentResult.success) {
        info(attempt > 1 ? `Build succeeded after ${attempt} attempt(s).` : 'Build succeeded.');
        debug('testFixAgent:success', { fixed: attempt > 1 });

        // Smoke test: verify the built app renders non-blank content in a headless browser.
        if (input.workspaceDir && input.files && input.blueprint) {
          try {
            const { runSmokeTest } = await import('./smokeTest');
            const smoke = await runSmokeTest(input.workspaceDir);
            if (!smoke.hasContent && smoke.syntheticBuildLog) {
              info('Smoke test detected blank render — running runtime_blank handler...');
              debug('testFixAgent:smoke-failed', { consoleErrors: smoke.consoleErrors });
              const handlers = HANDLER_MAP['runtime_blank'];
              for (const handler of handlers) {
                const fixed = await handler(smoke.syntheticBuildLog).catch(e => { logWarn('testFixAgent:smoke-handler', e); return false; });
                if (fixed) { await applyPreBuildFixes(smoke.syntheticBuildLog); break; }
              }
              continue; // One more build attempt after smoke fix
            }
          } catch (smokeErr) {
            logWarn('testFixAgent:smoke-test-error', smokeErr);
          }
        }

        return { ...currentResult, fixed: attempt > 1 };
      }

      lastResult = currentResult;
      const failureClass = classifyBuildFailure(lastResult.logs);
      info(`Build failed — classified as: ${failureClass}`);
      debug('testFixAgent:classified', { attempt, failureClass });

      const handlers = HANDLER_MAP[failureClass];
      let anyHandlerApplied = false;

      for (let hi = 0; hi < handlers.length; hi++) {
        const handlerKey = `${failureClass}:${hi}`;
        if (triedHandlers.has(handlerKey)) continue; // Skip handlers already tried for this class

        let fixed = false;
        try {
          fixed = await handlers[hi](lastResult.logs);
        } catch (handlerErr) {
          logWarn('testFixAgent:handler-error', { failureClass, handlerIndex: hi, err: String(handlerErr) });
        }

        if (fixed) {
          triedHandlers.add(handlerKey);
          await applyPreBuildFixes(lastResult.logs);
          anyHandlerApplied = true;
          info(`Handler ${hi + 1}/${handlers.length} for '${failureClass}' applied — retrying build...`);
          break; // One handler per cycle — rebuild immediately, re-classify after
        }
      }

      if (!anyHandlerApplied) {
        // All handlers for this class are exhausted — try unknown as final escalation
        if (failureClass !== 'unknown') {
          info(`All '${failureClass}' handlers exhausted — escalating to diagnostic agent...`);
          const unknownKey = `unknown:0:escalated-from:${failureClass}`;
          if (!triedHandlers.has(unknownKey)) {
            triedHandlers.add(unknownKey);
            const fixed = await unknownDiagnosticHandler(lastResult.logs).catch(e => { logWarn('testFixAgent:escalation', e); return false; });
            if (fixed) {
              await applyPreBuildFixes(lastResult.logs);
              continue;
            }
          }
        }
        // Nothing worked — exit the loop
        info('All handlers exhausted — build cannot be auto-fixed.');
        break;
      }
    }

    const elapsed = Math.round((Date.now() - loopStart) / 1000);
    const lastLogs = lastResult?.logs || 'No build output.';
    const failureClass = lastResult ? classifyBuildFailure(lastResult.logs) : 'unknown';
    throw new Error(`Build failed after ${attempt} attempt(s) (${elapsed}s). Failure class: ${failureClass}.\n${lastLogs.slice(-2000)}`);
  } catch (err) {
    logError('testFixAgent', { error: err instanceof Error ? err.message : String(err), stage: 'testFixAgent', stack: err instanceof Error ? err.stack?.slice(0, 400) : undefined });
    throw err;
  }
}
