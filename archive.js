const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const simpleGit = require('simple-git');
const moment = require('moment');

// ================= CONFIGURATION =================
// List of URLs to archive
const URLS = [
    'http://example.com/',
    // Add more URLs here
];

// Directory where the git repository will be created
const REPO_DIR = './wayback_history';

// Git Author Details
const GIT_AUTHOR = {
    name: 'Wayback Archiver',
    email: 'archiver@localhost'
};

// Rate limiting delay (ms) between requests to be polite to the API
const REQUEST_DELAY = 1000; 
// =================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sanitize a URL to create a valid filesystem path.
 * e.g., http://example.com/path?q=1 -> example.com/path_q_1
 */
function urlToFilePath(url) {
    try {
        const parsed = new URL(url);
        let base = parsed.hostname;
        let pathname = parsed.pathname;

        // Remove trailing slash from path to avoid directory ambiguity
        if (pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        
        // If path is empty, use index.html
        if (!pathname) {
            pathname = '/index.html';
        } else {
            // Determine if it looks like a file or a directory
            const ext = path.extname(pathname);
            if (!ext) {
                // No extension, assume HTML and append, or treat as directory
                // We will try to save as HTML for simplicity
                pathname += '.html';
            }
        }

        // Sanitize query parameters
        let query = parsed.search.replace(/\?/g, '_').replace(/=/g, '_').replace(/&/g, '_');
        
        // Combine
        let fullPath = path.join(base, pathname);
        
        // Append query string if present (sanitized)
        if (query && query !== '_') {
            // Remove extension, add query, re-add extension
            const ext = path.extname(fullPath);
            const baseName = fullPath.slice(0, -ext.length);
            fullPath = `${baseName}${query}${ext}`;
        }

        // Remove invalid characters
        return fullPath.replace(/[<>:"|?*]/g, '_');
    } catch (e) {
        console.error(`Invalid URL: ${url}`);
        return null;
    }
}

/**
 * Fetch available snapshots from the Wayback CDX API
 */
async function getSnapshots(url) {
    const cdxUrl = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&mimetype=text/html&filter=statuscode:200`;
    
    try {
        const response = await axios.get(cdxUrl);
        const data = response.data;

        if (!data || data.length < 2) return [];

        // First row is header ['timestamp', 'original', ...], skip it
        return data.slice(1).map(row => ({
            timestamp: row[0],
            originalUrl: row[1],
            statuscode: row[2]
        }));
    } catch (error) {
        console.error(`Error fetching CDX for ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Main execution function
 */
async function main() {
    console.log(`Initializing repository at ${REPO_DIR}...`);
    
    // Ensure directory exists
    await fs.mkdir(REPO_DIR, { recursive: true });
    
    // Initialize Git
    const git = simpleGit(REPO_DIR);
    let isRepo = false;
    
    try {
        isRepo = await git.checkIsRepo();
    } catch (e) {
        isRepo = false;
    }

    if (!isRepo) {
        await git.init();
    }

    // Collect all snapshots across all URLs first
    let allSnapshots = [];

    for (const url of URLS) {
        console.log(`Fetching snapshot list for ${url}...`);
        const snapshots = await getSnapshots(url);
        
        snapshots.forEach(s => {
            // Construct URL to download the raw content (id_ prefix)
            s.downloadUrl = `https://web.archive.org/web/${s.timestamp}id_/${s.originalUrl}`;
            allSnapshots.push(s);
        });

        await sleep(REQUEST_DELAY);
    }

    // Sort all snapshots globally by timestamp
    allSnapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    console.log(`Found ${allSnapshots.length} total snapshots to process.`);

    // Process each snapshot
    for (let i = 0; i < allSnapshots.length; i++) {
        const snap = allSnapshots[i];
        const dateStr = moment(snap.timestamp, "YYYYMMDDHHmmss").format();
        const dateTimestamp = moment(snap.timestamp, "YYYYMMDDHHmmss").toDate();

        console.log(`[${i+1}/${allSnapshots.length}] Processing ${snap.timestamp} for ${snap.originalUrl}`);

        const relativePath = urlToFilePath(snap.originalUrl);
        if (!relativePath) continue;

        const fullPath = path.join(REPO_DIR, relativePath);

        try {
            // Download content
            const response = await axios.get(snap.downloadUrl, { 
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaybackGitArchiver/1.0)' }
            });

            // Ensure directory exists
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            // Write file
            await fs.writeFile(fullPath, response.data);

            // Git Add
            await git.add(relativePath);

            // Git Commit
            // We use raw arguments to set the date specifically
            // Format: git commit --date="YYYY-MM-DD HH:mm:ss" --author="Name <email>"
            const commitMessage = `Snapshot: ${snap.originalUrl} at ${snap.timestamp}`;
            
            try {
                await git.commit(commitMessage, null, {
                    '--date': dateStr,
                    '--author': `${GIT_AUTHOR.name} <${GIT_AUTHOR.email}>`
                });
            } catch (commitErr) {
                // simple-git throws if there is nothing to commit
                if (commitErr.message.includes('nothing to commit')) {
                    console.log(`  -> Skipped (No changes from previous snapshot)`);
                } else {
                    throw commitErr;
                }
            }

        } catch (err) {
            console.error(`  -> Failed to process snapshot: ${err.message}`);
        }

        await sleep(REQUEST_DELAY);
    }

    console.log("Archiving complete.");
}

main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
