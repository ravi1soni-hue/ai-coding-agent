"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const jobQueue_1 = require("../jobs/jobQueue");
const env_1 = require("../config/env");
const authService_1 = require("../auth/authService");
const projectStore_1 = require("../db/projectStore");
const buildWorker_1 = require("../workers/buildWorker");
const deploymentAgent_1 = require("../agents/deploymentAgent");
const redis_1 = require("../cache/redis");
const jobQueue = new jobQueue_1.JobQueue(async (job) => {
    console.log('[jobQueue] processed', job.id, job.payload);
});
function deploymentStatusKey(sessionId) {
    return `session:${sessionId}:status`;
}
async function registerRoutes(fastify) {
    async function requireUser(req, reply) {
        const cookies = (0, authService_1.parseCookie)(req.headers.cookie);
        if (!cookies.sid) {
            reply.status(401).send({ error: 'Unauthorized' });
            return null;
        }
        const user = await (0, authService_1.getUserFromSessionToken)(cookies.sid);
        if (!user) {
            reply.status(401).send({ error: 'Unauthorized' });
            return null;
        }
        return user;
    }
    fastify.get('/health', async () => ({ status: 'ok' }));
    fastify.post('/api/auth/signup', async (req, reply) => {
        const body = (req.body ?? {});
        const name = body.name?.trim() ?? '';
        const email = body.email?.trim() ?? '';
        const password = body.password ?? '';
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!name || !emailRegex.test(email) || password.length < 8) {
            return reply.status(400).send({ error: 'Name, valid email, and password (min 8 chars) are required.' });
        }
        try {
            const user = await (0, authService_1.createUser)({ name, email, password });
            const token = await (0, authService_1.createSession)({
                userId: user.id,
                ip: req.ip,
                userAgent: req.headers['user-agent'] ?? '',
            });
            const cookie = (0, authService_1.buildSessionCookie)(token, env_1.config.NODE_ENV === 'production');
            reply.header('Set-Cookie', cookie);
            return { user };
        }
        catch (err) {
            const msg = String(err?.message ?? '');
            if (msg.includes('duplicate key') || msg.includes('users_email_key')) {
                return reply.status(409).send({ error: 'Email is already registered.' });
            }
            return reply.status(500).send({ error: 'Failed to create account.' });
        }
    });
    fastify.post('/api/auth/login', async (req, reply) => {
        const body = (req.body ?? {});
        const email = body.email?.trim() ?? '';
        const password = body.password ?? '';
        if (!email || !password) {
            return reply.status(400).send({ error: 'Email and password are required.' });
        }
        const user = await (0, authService_1.authenticateUser)(email, password);
        if (!user) {
            return reply.status(401).send({ error: 'Invalid email or password.' });
        }
        const token = await (0, authService_1.createSession)({
            userId: user.id,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? '',
        });
        const cookie = (0, authService_1.buildSessionCookie)(token, env_1.config.NODE_ENV === 'production');
        reply.header('Set-Cookie', cookie);
        return { user };
    });
    fastify.post('/api/auth/logout', async (req, reply) => {
        const cookies = (0, authService_1.parseCookie)(req.headers.cookie);
        if (cookies.sid) {
            await (0, authService_1.revokeSession)(cookies.sid);
        }
        reply.header('Set-Cookie', (0, authService_1.buildClearedSessionCookie)(env_1.config.NODE_ENV === 'production'));
        return { ok: true };
    });
    fastify.get('/api/auth/me', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        return { user };
    });
    fastify.get('/api/projects/current', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const projectId = await (0, authService_1.getOrCreateActiveProjectSession)(user.id);
        return { projectId };
    });
    fastify.post('/api/projects/new', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const projectId = await (0, authService_1.createProjectSession)(user.id);
        return { projectId };
    });
    fastify.get('/api/projects/history', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const projects = await (0, projectStore_1.listUserProjects)(user.id);
        return { projects };
    });
    fastify.post('/api/projects/:projectId/redeploy', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const params = req.params;
        const projectId = params.projectId;
        const projects = await (0, projectStore_1.listUserProjects)(user.id);
        const projectExists = projects.some((project) => project.id === projectId);
        if (!projectExists) {
            return reply.status(404).send({ error: 'Project not found.' });
        }
        const revision = await (0, projectStore_1.getLatestProjectCodeRevision)({ projectId, userId: user.id });
        if (!revision) {
            return reply.status(404).send({ error: 'No saved code revision found for this project.' });
        }
        try {
            const buildResult = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: revision.workspace_path });
            if (!buildResult.success || !buildResult.buildDir) {
                return reply.status(500).send({ error: 'Build failed during redeploy.', logs: buildResult.logs });
            }
            const deployment = await (0, deploymentAgent_1.deploymentAgent)({
                projectId,
                revisionId: revision.id,
                buildDir: buildResult.buildDir,
                backendDir: buildResult.backendDir,
                frontendProjectName: `proj-${projectId.slice(0, 10)}`,
                backendService: `backend-${projectId.slice(0, 10)}`,
                hasBackend: Boolean(buildResult.backendDir),
            });
            await (0, projectStore_1.saveProjectDeployment)({
                projectId,
                userId: user.id,
                frontendUrl: deployment.frontend_url,
                backendUrl: deployment.backend_url,
                vercelDeploymentId: deployment.vercel_deployment_id,
                vercelInspectUrl: deployment.vercel_inspect_url,
                vercelStatus: deployment.vercel_status,
                vercelLogUrl: deployment.vercel_log_url,
                railwayDeploymentId: deployment.railway_deployment_id,
                railwayStatus: deployment.railway_status,
                railwayLogUrl: deployment.railway_log_url,
                railwayDashboardUrl: deployment.railway_dashboard_url,
                codeRevisionId: revision.id,
                sourceArchivePath: revision.source_archive_path,
                sourceHash: revision.source_hash,
                raw: deployment,
            });
            if (revision.workspace_path) {
                void (0, buildWorker_1.cleanupWorkspace)(revision.workspace_path);
            }
            return { deployment };
        }
        catch (err) {
            const message = err?.message || 'Redeploy failed.';
            return reply.status(500).send({ error: message });
        }
    });
    fastify.post('/api/projects/select', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const body = (req.body ?? {});
        const projectId = (body.projectId ?? '').trim();
        if (!projectId) {
            return reply.status(400).send({ error: 'projectId is required.' });
        }
        const projects = await (0, projectStore_1.listUserProjects)(user.id);
        const exists = projects.some((p) => p.id === projectId);
        if (!exists) {
            return reply.status(404).send({ error: 'Project not found.' });
        }
        await (0, authService_1.touchProjectSession)(user.id, projectId);
        return { projectId };
    });
    fastify.get('/api/projects/:projectId/events', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const params = req.params;
        const projectId = params.projectId;
        const projects = await (0, projectStore_1.listUserProjects)(user.id);
        const exists = projects.some((p) => p.id === projectId);
        if (!exists) {
            return reply.status(404).send({ error: 'Project not found.' });
        }
        const events = await (0, projectStore_1.getProjectEvents)({ userId: user.id, projectId, limit: 1000 });
        return { events };
    });
    fastify.post('/job', async (req, reply) => {
        const job = req.body;
        await jobQueue.addJob(job);
        return { status: 'job_queued' };
    });
    fastify.post('/confirm-project', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const body = (req.body ?? {});
        const sessionId = (body.sessionId || body.projectId || '').trim();
        if (!sessionId) {
            return reply.status(400).send({ error: 'sessionId is required.' });
        }
        await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
            sessionId,
            status: 'queued',
            stage: 'queued',
            updatedAt: new Date().toISOString(),
        }, 60 * 60 * 24);
        await jobQueue.addJob({
            type: 'confirm-project',
            userId: user.id,
            sessionId,
            run: async () => {
                await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                    sessionId,
                    status: 'running',
                    stage: 'build',
                    updatedAt: new Date().toISOString(),
                }, 60 * 60 * 24);
                const revision = await (0, projectStore_1.getLatestProjectCodeRevision)({ projectId: sessionId, userId: user.id });
                if (!revision) {
                    await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                        sessionId,
                        status: 'failed',
                        stage: 'build',
                        error: 'No saved code revision found for this project.',
                        updatedAt: new Date().toISOString(),
                    }, 60 * 60 * 24);
                    return;
                }
                const buildResult = await (0, buildWorker_1.runBuildWorker)({ workspaceDir: revision.workspace_path });
                if (!buildResult.success || !buildResult.buildDir) {
                    await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                        sessionId,
                        status: 'failed',
                        stage: 'build',
                        error: 'Build failed during confirm-project.',
                        logs: buildResult.logs,
                        updatedAt: new Date().toISOString(),
                    }, 60 * 60 * 24);
                    return;
                }
                await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                    sessionId,
                    status: 'running',
                    stage: 'deploy',
                    updatedAt: new Date().toISOString(),
                }, 60 * 60 * 24);
                const deployment = await (0, deploymentAgent_1.deploymentAgent)({
                    projectId: sessionId,
                    revisionId: revision.id,
                    buildDir: buildResult.buildDir,
                    backendDir: buildResult.backendDir,
                    frontendProjectName: `proj-${sessionId.slice(0, 10)}`,
                    backendService: `backend-${sessionId.slice(0, 10)}`,
                    hasBackend: Boolean(buildResult.backendDir),
                });
                await (0, projectStore_1.saveProjectDeployment)({
                    projectId: sessionId,
                    userId: user.id,
                    frontendUrl: deployment.frontend_url,
                    backendUrl: deployment.backend_url,
                    vercelDeploymentId: deployment.vercel_deployment_id,
                    vercelInspectUrl: deployment.vercel_inspect_url,
                    vercelStatus: deployment.vercel_status,
                    vercelLogUrl: deployment.vercel_log_url,
                    railwayDeploymentId: deployment.railway_deployment_id,
                    railwayStatus: deployment.railway_status,
                    railwayLogUrl: deployment.railway_log_url,
                    railwayDashboardUrl: deployment.railway_dashboard_url,
                    codeRevisionId: revision.id,
                    sourceArchivePath: revision.source_archive_path,
                    sourceHash: revision.source_hash,
                    raw: deployment,
                });
                await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                    sessionId,
                    status: 'completed',
                    stage: 'done',
                    deployment,
                    updatedAt: new Date().toISOString(),
                }, 60 * 60 * 24);
            },
        });
        // best effort asynchronous execution using in-process queue
        void jobQueue.processJobs().catch(async (err) => {
            await (0, redis_1.setCacheJson)(deploymentStatusKey(sessionId), {
                sessionId,
                status: 'failed',
                stage: 'error',
                error: err instanceof Error ? err.message : String(err),
                updatedAt: new Date().toISOString(),
            }, 60 * 60 * 24);
        });
        return { sessionId, status: 'queued' };
    });
    fastify.get('/deployment-status/:sessionId', async (req, reply) => {
        const user = await requireUser(req, reply);
        if (!user)
            return;
        const params = req.params;
        const sessionId = (params.sessionId || '').trim();
        if (!sessionId)
            return reply.status(400).send({ error: 'sessionId is required.' });
        const projects = await (0, projectStore_1.listUserProjects)(user.id);
        const exists = projects.some((p) => p.id === sessionId);
        if (!exists)
            return reply.status(404).send({ error: 'Project not found.' });
        const status = await (0, redis_1.getCacheJson)(deploymentStatusKey(sessionId));
        return { sessionId, status: status || { status: 'unknown', stage: 'unknown' } };
    });
}
