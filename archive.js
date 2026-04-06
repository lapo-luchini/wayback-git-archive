const fs = require('fs').promises;
const fsConstants = require('fs').constants;
const path = require('path');
const simpleGit = require('simple-git');

// ================= CONFIGURATION =================
// The base URL (will be stripped from paths in commits)
const BASE_URL = 'https://www.mrob.com/pub/comp/hypercalc';

// List of relative pages within the base URL
// Leave as ['/'] for just the homepage
const PAGES = ['/hypercalc-javascript.html', '/hypercalc.txt'];

// Directory where the git repository will be created
const REPO_DIR = './repo';

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
 * Convert Wayback timestamp (YYYYMMDDHHmmss) to ISO 8601 UTC string directly.
 */
function waybackToISO(ts) {
    const year = ts.substring(0, 4);
    const month = ts.substring(4, 6);
    const day = ts.substring(6, 8);
    const hour = ts.substring(8, 10);
    const minute = ts.substring(10, 12);
    const second = ts.substring(12, 14);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

/**
 * Convert ISO 8601 UTC string to Wayback timestamp (YyyyMmDdHhMmSs).
 * Accepts strings like '2023-04-15T12:34:56Z' or '2023-04-15T12:34:56.789Z'
 * and returns a 14-digit timestamp string (e.g., '20230415123456').
 */
function isoToWayback(isoStr) {
    return isoStr.slice(0, 19).replace(/[-T:]/g, '');
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
            return isoToWayback(log.trim());
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
    const cdxUrl = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&mimetype=text/html&filter=statuscode:200`;

    try {
        const response = await fetch(cdxUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        if (!data || data.length < 2) return [];

        // First row is header ['timestamp', 'original', ...], skip it
        let snapshots = data.slice(1).map((row) => ({
            timestamp: row[0],
            originalUrl: row[1],
        }));

        // Filter by fromDate if provided: only keep timestamps > fromDate (lexicographically)
        if (fromDate) {
            snapshots = snapshots.filter((snap) => snap.timestamp > fromDate);
        }

        return snapshots;
    } catch (error) {
        console.error(`Error fetching CDX for ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Initialize Repo with strict isolation and local config
 */
async function initializeRepo(git, repoDir) {
    const gitDir = path.join(repoDir, '.git');
    let needsInit = false;

    // Strictly check if .git directory exists inside the target folder
    try {
        await fs.access(gitDir, fsConstants.F_OK);
    } catch (e) {
        needsInit = true;
    }

    if (needsInit) {
        console.log(`Initializing new repository in ${repoDir}...`);

        // Initialize the repo
        await git.init();

        // ISOLATION: Set local config to override global environment settings
        // This prevents issues with global user.name, emails, and GPG signing
        console.log('Applying local git configuration to ignore environment settings...');
        await git.addConfig('user.name', GIT_AUTHOR.name);
        await git.addConfig('user.email', GIT_AUTHOR.email);
        await git.addConfig('commit.gpgsign', 'false'); // Disable signature requirement
        await git.addConfig('init.defaultBranch', 'main'); // Ensure consistent branch name

        // Create README
        const readmePath = path.join(repoDir, 'README.md');
        const content = `# Wayback Machine Archive

This repository is an automated archive of web pages from the Wayback Machine.

Source Base URL: \`${BASE_URL}\`

## Pages Archived
${PAGES.map((p) => `- ${p}`).join('\n')}
`;
        await fs.writeFile(readmePath, content);
        await git.add('README.md');
        await git.commit('Initial commit: README');
        console.log('Repository initialized and README created.');
    } else {
        // Verify config if repo exists (ensure GPG is off for this repo if we run commits)
        // We set it again just to be safe, it overrides global config for this repo only.
        await git.addConfig('commit.gpgsign', 'false');
        await git.addConfig('user.name', GIT_AUTHOR.name);
        await git.addConfig('user.email', GIT_AUTHOR.email);
    }
}

/**
 * Main execution function
 */
async function main() {
    console.log(`Checking repository at ${REPO_DIR}...`);

    // Ensure directory exists
    await fs.mkdir(REPO_DIR, { recursive: true });

    // Initialize Git pointing specifically to REPO_DIR
    const git = simpleGit(REPO_DIR);

    // Initialize or verify repository
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
                s.pagePath = page;
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
        const dateStr = waybackToISO(snap.timestamp);

        console.log(`[${i + 1}/${allSnapshots.length}] Processing ${snap.timestamp} for ${snap.pagePath}`);

        const fullPath = path.join(REPO_DIR, snap.filePath);

        try {
            // Download content
            const response = await fetch(snap.downloadUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WaybackGitArchiver/1.0)' },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Read raw array buffer
            const buffer = await response.arrayBuffer();

            // Ensure directory exists
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            // Write file (convert ArrayBuffer to Buffer)
            await fs.writeFile(fullPath, Buffer.from(buffer));

            // Git Add
            await git.add(snap.filePath);

            // Git Commit
            // Commit message shows the relative page path, not the full URL
            const commitMessage = `Snapshot: ${snap.pagePath} at ${snap.timestamp}`;

            try {
                // Commit using local config (already set) + explicit date
                await git.commit(commitMessage, null, {
                    '--date': dateStr,
                    // We don't need --author here because we forced user.name/email in local config
                    // However, adding it again doesn't hurt safety.
                });
            } catch (commitErr) {
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
