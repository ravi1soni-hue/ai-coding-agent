
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../config/../../.env') });

// Type definitions
interface VercelFile {
  file: string;
  data: Buffer;
}
interface VercelFilePayload {
  file: string;
  data: string;
}
interface DeployToVercelOptions {
  buildDir?: string;
  projectName?: string;
}

type DeployToVercelResult = {
  url: string;
  inspectUrl: string | null;
  deploymentId: string;
  status: string;
  logUrl: string | null;
};

// Vercel config from environment variables
const VERCEL_ACCESS_TOKEN = process.env.VERCEL_ACCESS_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || '';
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID || '';
const CUSTOM_DOMAIN = process.env.VERCEL_CUSTOM_DOMAIN || '';

// Deploys the frontend build output to Vercel using the REST API
export async function deployToVercel({ buildDir = '../../frontend', projectName = 'ai-coding-agent-iota-ochre' }: DeployToVercelOptions = {}): Promise<DeployToVercelResult> {
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

  const files = getFiles(path.resolve(__dirname, buildDir));
  const fileList: VercelFilePayload[] = files.map((f: VercelFile): VercelFilePayload => ({ file: f.file, data: f.data.toString('base64') }));

  // Prepare the deployment payload
  const payload = {
    name: projectName,
    projectId: VERCEL_PROJECT_ID,
    files: fileList.map((f: VercelFilePayload): VercelFilePayload => ({ file: f.file, data: f.data })),
    target: 'production',
    teamId: VERCEL_TEAM_ID
  };

  // Call Vercel Deployments API
  const response = await axios.post(
    'https://api.vercel.com/v13/deployments',
    payload,
    {
      headers: {
        Authorization: `Bearer ${VERCEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Vercel deployment failed: ${response.status} ${JSON.stringify(response.data)}`);
  }

  // Return deployment URL
  return {
    url: response.data.url,
    inspectUrl: response.data.inspectorUrl || null,
    deploymentId: response.data.id,
    status: response.data.readyState || 'READY',
    logUrl: response.data.inspectorUrl || null,
  };
}
