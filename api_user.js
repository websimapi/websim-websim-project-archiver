import { makeRequest } from './core.js';

export async function getUserProjects(username, cursor = null) {
    const params = new URLSearchParams();
    params.set('first', '20'); // Fetch in batches
    if (cursor) params.set('after', cursor);
    
    // Note: The endpoint might return { projects: { data: [], meta: {} } } or just { data: [], meta: {} }
    // We handle this variation in the processor
    return makeRequest(`/users/${username}/projects?${params.toString()}`);
}

export async function* getAllUserProjectsGenerator(username) {
    let hasNext = true;
    let cursor = null;
    let pageCount = 0;
    
    while(hasNext) {
        console.log(`[API] Fetching user projects page ${pageCount}, cursor: ${cursor}`);
        try {
            const response = await getUserProjects(username, cursor);
            console.log(`[API] Raw User Project Response:`, response);
            
            let projects = [];
            let meta = null;

            if (response.projects) {
                projects = response.projects.data || [];
                meta = response.projects.meta;
            } else if (response.data) {
                projects = response.data;
                meta = response.meta;
            }

            console.log(`[API] Found ${projects.length} projects in page ${pageCount}`);
            if (projects.length > 0) {
                 console.log(`[API] Sample project item:`, projects[0]);
            }

            // Yield found projects individually
            for (const p of projects) {
                yield p;
            }

            if (meta && meta.has_next_page && meta.end_cursor) {
                cursor = meta.end_cursor;
                console.log(`[API] Next cursor: ${cursor}`);
            } else {
                console.log(`[API] No more pages.`);
                hasNext = false;
            }

        } catch (e) {
            console.error("Error fetching user projects:", e);
            throw e;
        }
        pageCount++;
    }
}