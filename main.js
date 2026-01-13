import JSZip from 'jszip';
import { getAllUserProjectsGenerator } from './api_user.js';
import { getProjectHtml } from './api_html.js';
import { getAssets, processAssets } from './api_assets.js';
import { getAllProjectRevisions, getProjectById, getProjectBySlug } from './api_project.js';

// --- State ---
let isRunning = false;
let stopRequested = false;
let foundProjects = [];
let processedCount = 0;
let zip = null;
let currentZipSize = 0;

// --- DOM Elements ---
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const projectListEl = document.getElementById('project-list');
const statTotal = document.getElementById('stat-total');
const statProcessed = document.getElementById('stat-processed');
const statSize = document.getElementById('stat-size');

// --- Helpers ---
const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const createProjectElement = (project) => {
    // Robust fallback for project properties
    const safeTitle = project.title || project.name || project.slug || project.id || 'Untitled';
    const safeSlug = project.slug || project.id;
    const safeId = project.id;

    const el = document.createElement('div');
    el.className = 'project-item';
    el.id = `proj-${safeId}`;
    el.innerHTML = `
        <div class="status-icon pending" id="icon-${safeId}">●</div>
        <div class="project-info">
            <span class="project-name">${safeTitle}</span>
            <div class="project-meta">
                <span>/${safeSlug}</span>
                <span id="log-${safeId}" class="log-msg">Waiting...</span>
            </div>
        </div>
    `;
    return el;
};

const updateStatus = (projectId, status, msg) => {
    const icon = document.getElementById(`icon-${projectId}`);
    const log = document.getElementById(`log-${projectId}`);
    if (!icon || !log) return;

    // Reset classes
    icon.className = 'status-icon';
    if (status === 'loading') icon.classList.add('loading');
    else if (status === 'done') icon.classList.add('done');
    else if (status === 'error') icon.classList.add('error');
    else icon.classList.add('pending');

    icon.textContent = status === 'done' ? '✓' : (status === 'error' ? '!' : '●');
    log.textContent = msg;
};

// --- Core Logic ---

async function processProject(project, username, userFolder) {
    if (stopRequested) return;
    
    // Use the initial ID for UI updates to ensure we target the correct DOM elements
    const uiId = project.id; 

    console.log(`[Main] Processing project: ${project.id} (slug: ${project.slug})`);
    
    updateStatus(uiId, 'loading', 'Fetching latest revision...');
    
    try {
        // 1. Get Latest Version ID (Robust strategy)
        let versionId = project.latest_revision?.id;
        if (!versionId && project.latest_version) versionId = project.latest_version.id;
        if (!versionId && project.revision) versionId = project.revision.id;
        // Fallback: If not uuid, maybe int version?
        if (!versionId && project.current_version) versionId = project.current_version;

        if (!versionId) {
             console.log(`[Main] No latest_revision for ${project.id}, attempting strategies...`);
             
             // Strategy A: Fetch by Slug
             if (username && project.slug) {
                try {
                    const fullProj = await getProjectBySlug(username, project.slug);
                    if (fullProj) {
                        if (fullProj.project_revision && fullProj.project_revision.id) versionId = fullProj.project_revision.id;
                        else if (fullProj.project && fullProj.project.latest_revision?.id) versionId = fullProj.project.latest_revision.id;
                        else if (fullProj.latest_revision?.id) versionId = fullProj.latest_revision.id;
                        
                        // Fix ID if redirected
                        const foundProjId = fullProj.project?.id || fullProj.id;
                        if (foundProjId && foundProjId !== project.id) project.id = foundProjId;
                    }
                } catch(e) { console.warn(`[Main] Slug fetch failed: ${e.message}`); }
             }

             // Strategy B: Fetch by ID
             if (!versionId && project.id) {
                try {
                    const fullProj = await getProjectById(project.id);
                    if (fullProj) {
                         if (fullProj.project_revision && fullProj.project_revision.id) versionId = fullProj.project_revision.id;
                         else if (fullProj.project && fullProj.project.latest_revision?.id) versionId = fullProj.project.latest_revision.id;
                         else if (fullProj.latest_revision?.id) versionId = fullProj.latest_revision.id;
                    }
                } catch(e) { console.warn(`[Main] ID fetch failed: ${e.message}`); }
             }

             // Strategy C: Revision History Fallback
             if (!versionId) {
                 try {
                    const revisions = await getAllProjectRevisions(project.id);
                    const validRev = revisions.find(r => r && r.id);
                    if (validRev) versionId = validRev.id;
                 } catch (e) { console.error(`[Main] Failed to fetch revisions: ${e.message}`); }
             }
        }

        if (!versionId) {
             throw new Error('No revisions found for project (all strategies failed)');
        }

        console.log(`[Main] Resolved version for ${project.id}: ${versionId}`);

        // Safety for folder name
        const folderName = project.slug || project.id || `project_${project.id}`;
        const projectFolder = userFolder.folder(folderName);

        // 2. Fetch Assets & HTML (New Robust Pipeline)
        updateStatus(uiId, 'loading', 'Downloading files...');
        
        // Fetch asset list and HTML content in parallel
        const [assetList, htmlContent] = await Promise.all([
            getAssets(project.id, versionId),
            getProjectHtml(project.id, versionId)
        ]);
        
        console.log(`[Main] Found ${assetList.length} assets.`);

        // 3. Process Assets
        updateStatus(uiId, 'loading', `Downloading ${assetList.length} assets...`);
        const files = await processAssets(assetList, project.id, versionId);

        // 4. Inject HTML
        if (htmlContent) {
            files['index.html'] = new TextEncoder().encode(htmlContent);
        } else if (!files['index.html']) {
            files['index.html'] = new TextEncoder().encode(`<html><body><h1>${project.title || 'Untitled'}</h1><p>Source unavailable.</p></body></html>`);
        }

        // 5. Write to Zip Folder
        const fileCount = Object.keys(files).length;
        for (const [path, content] of Object.entries(files)) {
            // Clean path logic is already in processAssets, but double check
            const cleanPath = path.replace(/^\/+/, '');
            projectFolder.file(cleanPath, content);
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        updateStatus(uiId, 'done', 'Packaged');
        console.log(`[Main] Finished processing ${project.id} (${fileCount} files)`);

    } catch (e) {
        console.error(`[Main] Error processing ${project.slug}:`, e);
        updateStatus(uiId, 'error', `Failed: ${e.message}`);
    }
}

async function startBackup() {
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) return alert('Please enter a username');

    console.log(`[Main] Starting backup for user: ${username}`);

    // Reset UI
    isRunning = true;
    stopRequested = false;
    foundProjects = [];
    processedCount = 0;
    zip = new JSZip();
    currentZipSize = 0;
    
    projectListEl.innerHTML = '';
    statTotal.textContent = '0';
    statProcessed.textContent = '0';
    statSize.textContent = '0 Bytes';
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    usernameInput.disabled = true;

    try {
        const userFolder = zip.folder(username);
        
        // 1. Fetch Loop (Generator)
        console.log(`[Main] Initializing project generator...`);
        const generator = getAllUserProjectsGenerator(username);
        
        for await (const project of generator) {
            if (stopRequested) {
                console.log(`[Main] Stop requested during loop. Breaking...`);
                break;
            }

            console.log(`[Main] Discovered project: ${project.id}`);

            // Add to list
            foundProjects.push(project);
            statTotal.textContent = foundProjects.length;
            
            const el = createProjectElement(project);
            projectListEl.appendChild(el);

            if (!project.id) {
                console.error('[Main] Skipping project with missing ID:', project);
                updateStatus('unknown', 'error', 'Missing ID');
                continue;
            }

            // Process immediately (Sequential for safety/simplicity)
            await processProject(project, username, userFolder);
            
            // Wait 3 seconds to avoid rate limits
            console.log('[Main] Waiting 3 seconds before next project...');
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

    } catch (e) {
        console.error("[Main] Loop error:", e);
        alert(`Error fetching project list: ${e.message}`);
    } finally {
        console.log(`[Main] Loop finished. Calling finishBackup...`);
        finishBackup();
    }
}

async function finishBackup() {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    usernameInput.disabled = false;

    if (processedCount === 0) {
        alert("No projects were processed.");
        return;
    }

    const btnText = startBtn.textContent;
    startBtn.textContent = "Generating ZIP...";
    startBtn.disabled = true;

    try {
        const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
             statSize.textContent = `Zipping: ${metadata.percent.toFixed(1)}%`;
        });
        
        statSize.textContent = formatBytes(content.size);
        
        // Trigger Download
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = `${usernameInput.value.replace('@','')}_websim_backup_${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);

    } catch (e) {
        alert("Error generating ZIP: " + e.message);
    }

    startBtn.textContent = "Start Backup";
    startBtn.disabled = false;
}

startBtn.addEventListener('click', startBackup);
stopBtn.addEventListener('click', () => {
    if (isRunning) {
        stopRequested = true;
        stopBtn.textContent = "Stopping...";
        stopBtn.disabled = true;
    }
});