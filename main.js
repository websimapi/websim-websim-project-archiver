import JSZip from 'https://esm.sh/jszip@3.10.1';
import { getAllUserProjectsGenerator } from './api_user.js';
import { getProjectHtml } from './api_html.js';
import { getAssets, processAssets } from './api_assets.js';
import { getAllProjectRevisions } from './api_project.js';

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

async function processProject(project, userFolder) {
    updateStatus(project.id, 'loading', 'Fetching latest revision...');
    
    try {
        // 1. Get Latest Version ID
        // Note: Project object usually has `latest_revision` or we can fetch revisions.
        let versionId = project.latest_revision?.id;
        
        // If not in basic object, fetch history
        if (!versionId) {
             const revisions = await getAllProjectRevisions(project.id);
             if (revisions.length > 0) {
                 versionId = revisions[0].id;
             }
        }

        if (!versionId) {
            throw new Error('No revisions found');
        }

        // Safety for folder name
        const folderName = project.slug || project.id || `project_${project.id}`;
        const projectFolder = userFolder.folder(folderName);

        // 2. Fetch HTML
        updateStatus(project.id, 'loading', 'Downloading HTML...');
        const html = await getProjectHtml(project.id, versionId);
        if (html) {
            projectFolder.file('index.html', html);
        } else {
            projectFolder.file('index.html', `<!-- Failed to fetch HTML for ${folderName} -->`);
        }

        // 3. Fetch Assets
        updateStatus(project.id, 'loading', 'Scanning assets...');
        const assetList = await getAssets(project.id, versionId);
        
        if (assetList.length > 0) {
            updateStatus(project.id, 'loading', `Downloading ${assetList.length} assets...`);
            const assetFiles = await processAssets(assetList, project.id, versionId);
            
            const assetsFolder = projectFolder.folder('assets');
            for (const [path, content] of Object.entries(assetFiles)) {
                assetsFolder.file(path, content);
            }
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        updateStatus(project.id, 'done', 'Packaged');

    } catch (e) {
        console.error(`Error processing ${project.slug}:`, e);
        updateStatus(project.id, 'error', `Failed: ${e.message}`);
    }
}

async function startBackup() {
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) return alert('Please enter a username');

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
        // We do this semi-streaming: We fetch batches of projects, add them to UI, then process them sequentially
        const generator = getAllUserProjectsGenerator(username);
        
        for await (const project of generator) {
            if (stopRequested) break;

            // Add to list
            foundProjects.push(project);
            statTotal.textContent = foundProjects.length;
            
            const el = createProjectElement(project);
            projectListEl.appendChild(el);
            
            // Scroll to bottom
            // projectListEl.scrollTop = projectListEl.scrollHeight;

            // Process immediately (Sequential for safety/simplicity)
            // Ideally we could have a concurrency pool here, but for ZIP integrity and rate limits, sequential is safer.
            await processProject(project, userFolder);
        }

    } catch (e) {
        alert(`Error fetching project list: ${e.message}`);
    } finally {
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