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
let zip = null; // Used for Batch mode
let currentZipSize = 0;

// --- DOM Elements ---
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const projectListEl = document.getElementById('project-list');
const statTotal = document.getElementById('stat-total');
const statProcessed = document.getElementById('stat-processed');
const statSize = document.getElementById('stat-size');

// Settings Elements
const dateStartInput = document.getElementById('date-start');
const dateEndInput = document.getElementById('date-end');
const downloadModeInput = document.getElementById('download-mode');
const delayInput = document.getElementById('delay-ms');
const skipForksInput = document.getElementById('skip-forks');

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

async function processProject(project, username, options) {
    if (stopRequested) return;
    
    const { mode, rootZipFolder } = options;
    const uiId = project.id; 

    console.log(`[Main] Processing project: ${project.id} (slug: ${project.slug})`);
    updateStatus(uiId, 'loading', 'Fetching latest revision...');
    
    try {
        // 1. Resolve Version
        // API endpoints for assets/html require the numeric version (e.g., 42), NOT the UUID.
        let versionId = project.current_version;

        if (versionId === undefined || versionId === null) {
            versionId = project.latest_revision?.version || 
                        project.latest_version?.version || 
                        project.revision?.version;
        }

        // If still missing, fetch fresh metadata to find numeric version
        if (versionId === undefined || versionId === null) {
             console.log(`[Main] No numeric version for ${project.id}, fetching metadata...`);
             try {
                 const full = await getProjectById(project.id);
                 versionId = full?.current_version;
                 
                 // If still null, check revisions history
                 if (versionId === undefined || versionId === null) {
                     const revs = await getAllProjectRevisions(project.id);
                     versionId = revs[0]?.version;
                 }
             } catch(e) {
                 console.warn("[Main] Failed to resolve version metadata:", e);
             }
        }

        if (versionId === undefined || versionId === null) {
            console.error("Project dump:", project);
            throw new Error('No numeric version found (API requires numeric version)');
        }
        
        console.log(`[Main] Using version: ${versionId} (Type: ${typeof versionId})`);

        // 2. Setup Zip Target
        // If mode is individual, we create a temporary zip. If batch, we use the passed folder.
        const targetZip = mode === 'individual' ? new JSZip() : rootZipFolder;
        // For batch, we make a subfolder. For individual, the root of the zip is the project.
        const projectFolderName = project.slug || project.id || `project_${project.id}`;
        const outputFolder = mode === 'individual' ? targetZip : targetZip.folder(projectFolderName);

        // 3. Download Content
        updateStatus(uiId, 'loading', 'Downloading assets...');
        const [assetList, htmlContent] = await Promise.all([
            getAssets(project.id, versionId),
            getProjectHtml(project.id, versionId)
        ]);

        const files = await processAssets(assetList, project.id, versionId);

        // 4. Add HTML
        const htmlBuffer = htmlContent 
            ? new TextEncoder().encode(htmlContent)
            : new TextEncoder().encode(`<html><body><h1>${project.title}</h1><p>Source unavailable.</p></body></html>`);
        files['index.html'] = htmlBuffer;

        // 5. Write to target folder
        for (const [path, content] of Object.entries(files)) {
            outputFolder.file(path.replace(/^\/+/, ''), content);
        }

        // 6. Handle Individual Download
        if (mode === 'individual') {
            updateStatus(uiId, 'loading', 'Zipping...');
            const blob = await targetZip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${username}_${projectFolderName}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        updateStatus(uiId, 'done', mode === 'individual' ? 'Saved' : 'Packaged');

    } catch (e) {
        console.error(`[Main] Error processing ${project.slug}:`, e);
        updateStatus(uiId, 'error', `Failed: ${e.message}`);
    }
}

async function startBackup() {
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) return alert('Please enter a username');

    // Read Settings
    const mode = downloadModeInput.value;
    const delay = parseInt(delayInput.value) || 3000;
    const skipForks = skipForksInput.checked;
    
    const startDate = dateStartInput.value ? new Date(dateStartInput.value) : null;
    const endDate = dateEndInput.value ? new Date(dateEndInput.value) : null;

    console.log(`[Main] Backup config: User=${username}, Mode=${mode}, Delay=${delay}, SkipForks=${skipForks}`);

    // Reset UI
    isRunning = true;
    stopRequested = false;
    foundProjects = [];
    processedCount = 0;
    zip = new JSZip(); // Always init for potential Batch usage
    
    projectListEl.innerHTML = '';
    statTotal.textContent = '0';
    statProcessed.textContent = '0';
    statSize.textContent = '0 Bytes';
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = (mode === 'batch') ? "Stop & Save" : "Stop";
    usernameInput.disabled = true;

    try {
        const userFolder = zip.folder(username);
        const generator = getAllUserProjectsGenerator(username);
        
        for await (const project of generator) {
            if (stopRequested) break;

            // --- FILTERING LOGIC ---
            
            // 1. Date Filter
            if (startDate || endDate) {
                const pDate = new Date(project.created_at); // or updated_at? Usually creation for archive.
                if (startDate && pDate < startDate) continue;
                if (endDate && pDate > endDate) continue;
            }

            // 2. Fork Filter
            if (skipForks && project.parent_id) {
                console.log(`[Main] Skipping fork: ${project.slug} (Parent: ${project.parent_id})`);
                continue;
            }

            console.log(`[Main] Discovered project: ${project.id}`);
            foundProjects.push(project);
            statTotal.textContent = foundProjects.length;
            
            const el = createProjectElement(project);
            projectListEl.appendChild(el);

            if (!project.id) {
                updateStatus('unknown', 'error', 'Missing ID');
                continue;
            }

            // Process
            await processProject(project, username, {
                mode: mode,
                rootZipFolder: userFolder
            });
            
            // Rate Limit
            if (delay > 0) {
                console.log(`[Main] Waiting ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

    } catch (e) {
        console.error("[Main] Loop error:", e);
        alert(`Error: ${e.message}`);
    } finally {
        finishBackup(mode);
    }
}

async function finishBackup(mode) {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.textContent = "Stop";
    usernameInput.disabled = false;

    // In individual mode, we are done.
    if (mode === 'individual') {
        alert(`Done! Processed ${processedCount} projects.`);
        return;
    }

    // In batch mode, we check if we have anything to zip
    if (processedCount === 0) {
        alert("No projects were processed.");
        return;
    }

    // Generate Giant Zip
    startBtn.textContent = "Saving ZIP...";
    startBtn.disabled = true;

    try {
        const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
             statSize.textContent = `Zipping: ${metadata.percent.toFixed(1)}%`;
        });
        
        statSize.textContent = formatBytes(content.size);
        
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = `${usernameInput.value.replace('@','')}_full_backup_${Date.now()}.zip`;
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