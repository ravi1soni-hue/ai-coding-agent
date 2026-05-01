
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { config as env } from '../config/env';

// Type definitions
interface VercelFile {
  file: string;
  data: Buffer;
}
interface VercelFilePayload {
  file: string;
  data: string;
  encoding: 'base64';
}
interface DeployToVercelOptions {
  buildDir?: string;
  projectName?: string;
  meta?: Record<string, string>;
}

type DeployToVercelResult = {
  url: string;
  inspectUrl: string | null;
  deploymentId: string;
  status: string;
  logUrl: string | null;
};

// Vercel config from central env — never hardcode project IDs here
const VERCEL_ACCESS_TOKEN = env.VERCEL_ACCESS_TOKEN;
const VERCEL_TEAM_ID = env.VERCEL_TEAM_ID;

// Deploys the frontend build output to Vercel using the REST API.
// projectName is always dynamic (per-user-project); Vercel creates or reuses the project by name.
export async function deployToVercel({ buildDir = '../../frontend/dist', projectName, meta }: DeployToVercelOptions = {}): Promise<DeployToVercelResult> {
  if (!projectName) throw new Error('projectName is required for Vercel deployment — must be derived from projectId');
  if (!VERCEL_ACCESS_TOKEN) throw new Error('VERCEL_ACCESS_TOKEN is not set. Configure it in Railway environment variables.');
  // Read all files in the build directory recursively
  function getFiles(dir: string, base: string = dir): VercelFile[] {
    let files: VercelFile[] = [];
    for (const file of fs.readdirSync(dir)) {
      const fullPath: string = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        files = files.concat(getFiles(fullPath, base));
      } else {
        files.push({
          file: path.relative(base, fullPath),
          data: fs.readFileSync(fullPath)
        });
      }
    }
    return files;
  }

  const resolvedBuildDir = path.isAbsolute(buildDir) ? buildDir : path.resolve(__dirname, buildDir);
  const files = getFiles(resolvedBuildDir);
  const fileList: VercelFilePayload[] = files.map((f: VercelFile): VercelFilePayload => ({ file: f.file, data: f.data.toString('base64'), encoding: 'base64' }));

  // Vercel requires lowercase project names (alphanumeric + hyphens only)
  const sanitizedProjectName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

  // Prepare the deployment payload.
  // Do NOT pass a fixed projectId — let Vercel find or create a project by name.
  // This ensures each user project gets its own isolated Vercel project.
  const payload: Record<string, unknown> = {
    name: sanitizedProjectName,
    files: fileList,
    target: 'production',
    meta: (meta && Object.keys(meta).length > 0) ? meta : undefined,
    // Required by Vercel v13 API for new projects
    projectSettings: {
      framework: null,
      buildCommand: null,
      devCommand: null,
      installCommand: null,
      outputDirectory: null
    }
  };

  // Build query params — skipAutoDetectionConfirmation avoids the missing_project_settings error
  const queryParams: Record<string, string> = { skipAutoDetectionConfirmation: '1' };
  if (VERCEL_TEAM_ID) queryParams.teamId = VERCEL_TEAM_ID;

  // Call Vercel Deployments API
  let response;
  try {
    response = await axios.post(
      'https://api.vercel.com/v13/deployments',
      payload,
      {
        params: queryParams,
        headers: {
          Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const details = typeof err.response?.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response?.data || {});
      throw new Error(`Vercel deployment failed: ${status} ${details}`);
    }
    throw err;
  }

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Vercel deployment failed: ${response.status} ${JSON.stringify(response.data)}`);
  }

  // Return deployment URL
  return {
    url: response.data.url,
    inspectUrl: response.data.inspectorUrl || null,
    deploymentId: response.data.id,
    status: response.data.readyState || response.data.status || 'READY',
    logUrl: response.data.inspectorUrl || null,
  };
}
