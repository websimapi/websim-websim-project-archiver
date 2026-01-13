import JSZip from 'https://esm.sh/jszip@3.10.1';
import { getAllUserProjectsGenerator } from './api_user.js';
import { getProjectHtml } from './api_html.js';
import { getAssets, processAssets } from './api_assets.js';
import { getAllProjectRevisions, getProjectById, getProjectBySlug, getRevisionDetails } from './api_project.js';

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
    console.log(`[Main] Project keys available:`, Object.keys(project));
    
    updateStatus(uiId, 'loading', 'Fetching latest revision...');
    
    try {
        // 1. Get Latest Version ID
        let versionId = project.latest_revision?.id;
        
        // Sometimes it's directly in 'latest_version' or 'revision'
        if (!versionId && project.latest_version) versionId = project.latest_version.id;
        if (!versionId && project.revision) versionId = project.revision.id;

        if (!versionId) {
             console.log(`[Main] No latest_revision for ${project.id}, attempting strategies...`);
             
             // Strategy A: Fetch by Slug
             if (username && project.slug) {
                try {
                    console.log(`[Main] A: Fetching metadata via slug: ${username}/${project.slug}`);
                    const fullProj = await getProjectBySlug(username, project.slug);
                    if (fullProj) {
                        console.log(`[Main] Slug lookup returned keys:`, Object.keys(fullProj));
                        
                        // Handle wrapped responses (e.g. { project_revision: {...}, project: {...} })
                        if (fullProj.project_revision && fullProj.project_revision.id) {
                             versionId = fullProj.project_revision.id;
                             console.log(`[Main] Found version via slug (project_revision): ${versionId}`);
                        } else if (fullProj.project && fullProj.project.latest_revision?.id) {
                             versionId = fullProj.project.latest_revision.id;
                             console.log(`[Main] Found version via slug (project.latest_revision): ${versionId}`);
                        } else if (fullProj.latest_revision?.id) {
                            versionId = fullProj.latest_revision.id;
                        }

                        // Update to proper UUID if found in wrapped object
                        const foundProjId = fullProj.project?.id || fullProj.id;
                        if (foundProjId && foundProjId !== project.id) {
                            console.log(`[Main] Updating project ID: ${project.id} -> ${foundProjId}`);
                            project.id = foundProjId;
                        }
                    }
                } catch(e) {
                    console.warn(`[Main] Slug fetch failed: ${e.message}`);
                }
             }

             // Strategy B: Fetch by ID
             if (!versionId && project.id) {
                try {
                    console.log(`[Main] B: Fetching metadata via ID: ${project.id}`);
                    const fullProj = await getProjectById(project.id);
                    if (fullProj) {
                        console.log(`[Main] ID lookup keys:`, Object.keys(fullProj));
                        
                        // Handle wrapped responses
                        if (fullProj.project_revision && fullProj.project_revision.id) {
                             versionId = fullProj.project_revision.id;
                             console.log(`[Main] Found version via ID (project_revision): ${versionId}`);
                        } else if (fullProj.project && fullProj.project.latest_revision?.id) {
                             versionId = fullProj.project.latest_revision.id;
                             console.log(`[Main] Found version via ID (project.latest_revision): ${versionId}`);
                        } else if (fullProj.latest_revision?.id) {
                             versionId = fullProj.latest_revision.id;
                        }
                    }
                } catch(e) {
                    console.warn(`[Main] ID fetch failed: ${e.message}`);
                }
             }

             // Strategy C: Revision History Fallback
             if (!versionId) {
                 console.log(`[Main] C: Trying history API...`);
                 try {
                    const revisions = await getAllProjectRevisions(project.id);
                    if (revisions && revisions.length > 0) {
                        // Find first valid ID
                        const validRev = revisions.find(r => r && r.id);
                        if (validRev) {
                            versionId = validRev.id;
                            console.log(`[Main] Found latest revision from history: ${versionId}`);
                        } else {
                             console.error(`[Main] Revisions found but missing IDs. First item:`, revisions[0]);
                        }
                    } else {
                        console.warn(`[Main] No revisions returned from history API.`);
                    }
                 } catch (e) {
                     console.error(`[Main] Failed to fetch revisions: ${e.message}`);
                 }
             }
        }

        if (!versionId) {
             // Debug dump before failing
             console.error(`[Main] FAILED to find version. Project Dump:`, JSON.stringify(project, null, 2));
             throw new Error('No revisions found for project (all strategies failed)');
        }

        // Safety for folder name
        const folderName = project.slug || project.id || `project_${project.id}`;
        const projectFolder = userFolder.folder(folderName);

        // 2. Fetch Source Files (HTML, CSS, JS, etc.)
        if (stopRequested) return;
        updateStatus(uiId, 'loading', 'Downloading source files...');
        
        let sourceFiles = {};
        try {
            const revData = await getRevisionDetails(project.id, versionId);
            const rev = revData.revision || revData; // Handle nested response

            // A. Check 'files' object (Standard for multi-file projects)
            if (rev.files) {
                for (const [filename, fileData] of Object.entries(rev.files)) {
                    // fileData might be a string or an object {content: "..."}
                    const content = typeof fileData === 'string' ? fileData : fileData.content;
                    if (content) sourceFiles[filename] = content;
                }
            }

            // B. Check Legacy/Single-file fields
            if (!sourceFiles['index.html']) {
                if (rev.html) sourceFiles['index.html'] = rev.html;
                else if (rev.content && typeof rev.content === 'string') sourceFiles['index.html'] = rev.content;
            }
            if (!sourceFiles['style.css'] && rev.css) sourceFiles['style.css'] = rev.css;
            if (!sourceFiles['script.js'] && rev.js) sourceFiles['script.js'] = rev.js;

        } catch (e) {
            console.warn(`[Main] Error fetching revision details:`, e);
        }

        // C. Last Resort for HTML
        if (!sourceFiles['index.html']) {
             console.log(`[Main] HTML not found in metadata, trying direct endpoint...`);
             const html = await getProjectHtml(project.id, versionId);
             if (html) sourceFiles['index.html'] = html;
        }

        // Write Source Files to Zip
        const sourceKeys = Object.keys(sourceFiles);
        if (sourceKeys.length > 0) {
            for (const [name, content] of Object.entries(sourceFiles)) {
                projectFolder.file(name, content);
            }
            console.log(`[Main] Added ${sourceKeys.length} source files to zip.`);
        } else {
            projectFolder.file('index.html', `<!-- Failed to fetch source files for ${project.id} -->`);
        }

        // 3. Fetch Uploaded Assets (Images, Sounds, etc.)
        if (stopRequested) return;
        updateStatus(uiId, 'loading', 'Scanning assets...');
        
        try {
            const assetList = await getAssets(project.id, versionId);
            console.log(`[Main] Found ${assetList.length} assets for ${project.id}`);
            
            if (assetList.length > 0) {
                if (stopRequested) return;
                updateStatus(uiId, 'loading', `Downloading ${assetList.length} assets...`);
                
                const assetFiles = await processAssets(assetList, project.id, versionId);
                const assetKeys = Object.keys(assetFiles);
                
                if (assetKeys.length > 0) {
                    // Write directly to project folder (preserving paths).
                    for (const [path, content] of Object.entries(assetFiles)) {
                        // Check if we are overwriting index.html which we might have fetched from source
                        if (path === 'index.html' && sourceFiles['index.html']) {
                            console.log('[Main] Skipping asset index.html as source takes precedence.');
                            continue;
                        }
                        projectFolder.file(path, content);
                    }
                    console.log(`[Main] Added ${assetKeys.length} assets to zip.`);
                }
            } else {
                 console.log('[Main] No assets found in list.');
            }
        } catch (e) {
            console.warn(`[Main] Asset processing failed:`, e);
            // Don't fail the whole project for asset errors, just log it
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        updateStatus(uiId, 'done', 'Packaged');
        console.log(`[Main] Finished processing ${project.id}`);

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