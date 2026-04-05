const axios = require('axios');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const simpleGit = require('simple-git');
const moment = require('moment');

// ================= CONFIGURATION =================
// The base URL (will be stripped from paths in commits)
const BASE_URL = 'https://www.example.com';

// List of relative pages within the base URL
// Leave as ['/'] for just the homepage
const PAGES = ['/', '/about', '/contact', '/blog'];

// Directory where the git repository will be created
const REPO_DIR = './archive_repo';

// Git Author Details
const GIT_AUTHOR = {
    name: 'Wayback Archiver',
    email: 'archiver@localhost',
};

// Rate limiting delay (ms) between requests to be polite to the API
const REQUEST_DELAY = 1000;
// =================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Determines the file path for a relative URL.
 * e.g. "/" -> "index.html", "/about" -> "about.html"
 */
function pageToFilePath(relativeUrl) {
    let cleanPath = relativeUrl;

    // Remove leading slash
    if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.substring(1);
    }

    // Handle root path
    if (cleanPath === '' || cleanPath === '/') {
        return 'index.html';
    }

    // Determine if it looks like a file or a directory
    const ext = path.extname(cleanPath);

    if (!ext) {
        // No extension, assume HTML content from Wayback
        return cleanPath + '.html';
    }

    return cleanPath;
}

/**
 * Get the ISO date of the last commit for a specific file.
 * Returns null if the file has no history.
 */
async function getLastCommitDate(git, filePath) {
    try {
        // We use raw git log command to get the date of the latest commit for this file
        const log = await git.raw(['log', '-1', '--format=%aI', '--', filePath]);
        if (log && log.trim()) {
            return log.trim();
        }
        return null;
    } catch (error) {
        // Error usually means file is not tracked or no commits yet
        return null;
    }
}

/**
 * Fetch available snapshots from the Wayback CDX API
 * Optionally filter by 'from' date to get only newer snapshots
 */
async function getSnapshots(url, fromDate = null) {
    // Construct CDX URL
    let cdxUrl = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&mimetype=text/html&filter=statuscode:200`;

    if (fromDate) {
        // Wayback timestamp format is YYYYMMDDHHmmss
        const waybackDate = moment(fromDate).utc().format('YYYYMMDDHHmmss');
        cdxUrl += `&from=${waybackDate}`;
    }

    try {
        const response = await axios.get(cdxUrl);
        const data = response.data;

        if (!data || data.length < 2) return [];

        // First row is header ['timestamp', 'original', ...], skip it
        return data.slice(1).map((row) => ({
            timestamp: row[0],
            originalUrl: row[1],
        }));
    } catch (error) {
        console.error(`Error fetching CDX for ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Initialize Repo and create README if it doesn't exist
 */
async function initializeRepo(git, repoDir) {
    const readmePath = path.join(repoDir, 'README.md');

    try {
        await fs.access(readmePath, fsConstants.F_OK);
        // README exists, assume repo is initialized
        return false;
    } catch (e) {
        // README does not exist, create it
    }

    const content = `# Wayback Machine Archive

This repository is an automated archive of web pages from the Wayback Machine.

**Source Base URL:** ${BASE_URL}
**Generated on:** ${moment().format('LLLL')}

## Pages Archived
 ${PAGES.map((p) => `- ${p}`).join('\n')}
`;

    await fs.writeFile(readmePath, content);
    await git.add('README.md');

    // Commit with current date
    await git.commit('Initial commit: README', null, {
        '--author': `${GIT_AUTHOR.name} <${GIT_AUTHOR.email}>`,
    });

    console.log('Created initial README.md commit.');
    return true;
}

/**
 * Main execution function
 */
async function main() {
    console.log(`Checking repository at ${REPO_DIR}...`);

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

    // Initialize README if needed
    await initializeRepo(git, REPO_DIR);

    // Collect all snapshots across all URLs first
    let allSnapshots = [];

    for (const page of PAGES) {
        const fullUrl = `${BASE_URL}${page}`;
        const filePath = pageToFilePath(page);

        console.log(`Fetching snapshot list for ${page}...`);

        // Check last modification date in git
        const lastDate = await getLastCommitDate(git, filePath);
        if (lastDate) {
            console.log(`  -> Last snapshot found in git at ${lastDate}. Checking for updates...`);
        }

        // Fetch snapshots, filtering by 'from' date if we have history
        const snapshots = await getSnapshots(fullUrl, lastDate);

        if (snapshots.length > 0) {
            snapshots.forEach((s) => {
                // Construct URL to download the raw content (id_ prefix)
                s.downloadUrl = `https://web.archive.org/web/${s.timestamp}id_/${s.originalUrl}`;
                s.filePath = filePath;
                s.pagePath = page; // For cleaner commit messages
                allSnapshots.push(s);
            });
        }

        await sleep(REQUEST_DELAY);
    }

    if (allSnapshots.length === 0) {
        console.log('No new snapshots found.');
        return;
    }

    // Sort all snapshots globally by timestamp
    allSnapshots.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    console.log(`Found ${allSnapshots.length} new snapshots to process.`);

    // Process each snapshot
    for (let i = 0; i < allSnapshots.length; i++) {
        const snap = allSnapshots[i];
        const dateStr = moment(snap.timestamp, 'YYYYMMDDHHmmss').format();

        console.log(`[${i + 1}/${allSnapshots.length}] Processing ${snap.timestamp} for ${snap.pagePath}`);

        const fullPath = path.join(REPO_DIR, snap.filePath);

        try {
            // Download content
            const response = await axios.get(snap.downloadUrl, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaybackGitArchiver/1.0)' },
            });

            // Ensure directory exists
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            // Write file
            await fs.writeFile(fullPath, response.data);

            // Git Add
            await git.add(snap.filePath);

            // Git Commit
            // Commit message shows the relative page path, not the full URL
            const commitMessage = `Snapshot: ${snap.pagePath} at ${snap.timestamp}`;

            try {
                await git.commit(commitMessage, null, {
                    '--date': dateStr,
                    '--author': `${GIT_AUTHOR.name} <${GIT_AUTHOR.email}>`,
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

    console.log('Archiving complete.');
}

main().catch((err) => {
    console.error('Fatal Error:', err);
    process.exit(1);
});
