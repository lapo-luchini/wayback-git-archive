# Wayback Git Archiver

A NodeJS script to archive the history of a website from the Wayback Machine into a local Git repository. It downloads every available snapshot for a list of pages and commits them with the original timestamps, allowing you to browse the history of a site using standard Git tools.

## Features

*   **Chronological History**: Commits are dated to match the exact time the Wayback Machine took the snapshot.
*   **Incremental Updates**: If you run the script again, it only fetches new snapshots since the last update, preserving the existing history.
*   **Environment Isolation**: Works independently of your global Git configuration (ignores global usernames, signatures, etc.) to ensure a clean repository.
*   **Clean Structure**: Strips the base URL from file paths and commit messages, focusing on the relative page structure.
*   **Automated README**: Generates a `README.md` in the archive repository with the source URL and generation date.

## Prerequisites

*   [NodeJS](https://nodejs.org/) (v14 or higher recommended)
*   [Git](https://git-scm.com/) installed and available in the system PATH.

## Installation

1.  Clone or download this script into a folder.
2.  Install the required dependencies:

    ```bash
    pnpm install
    ```

## Usage

1.  Open `archive.js` in a text editor.
2.  Modify the **Configuration** section at the top of the file:

    ```javascript
    // ================= CONFIGURATION =================
    // The base URL (will be stripped from paths in commits)
    const BASE_URL = 'https://www.example.com';

    // List of relative pages within the base URL
    const PAGES = [
        '/',
        '/about',
        '/contact',
        '/blog'
    ];

    // Directory where the git repository will be created
    const REPO_DIR = './archive_repo';
    // =================================================
    ```

3.  Run the script:

    ```bash
    node archive.js
    ```

4.  Once finished, navigate to the output folder to view the history:

    ```bash
    cd repo
    git log --oneline
    ```

## How It Works

1.  **CDX API**: The script queries the Wayback Machine CDX API to list all available snapshots for the configured pages.
2.  **Filtering**: It checks the local Git history for each file. If a file exists, it requests snapshots only *after* the last commit date (incremental update).
3.  **Sorting**: All new snapshots (across all pages) are sorted chronologically.
4.  **Downloading**: It downloads the raw content (using the `id_` modifier to strip Wayback toolbars).
5.  **Committing**: It saves the file and commits it to the repository using `simple-git`. The commit date is set to the Wayback snapshot timestamp, and the author is fixed to "Wayback Archiver".

## Configuration Options

| Variable | Description |
| :--- | :--- |
| `BASE_URL` | The protocol and domain of the site you want to archive (e.g., `https://site.com`). |
| `PAGES` | An array of relative paths to archive (e.g., `['/', '/login']`). |
| `REPO_DIR` | The local folder where the Git repository will be created. |
| `GIT_AUTHOR` | The name and email used for the Git commits. |
| `REQUEST_DELAY` | Delay in milliseconds between requests to avoid rate limiting. |

## Output Example

A typical commit log in the created repository looks like this:

```text
a1b2c3d (HEAD -> main) Snapshot: /about at 20231020120000
e4f5g6h Snapshot: / at 20231015090000
i7j8k9l Snapshot: /contact at 20220901150000
m0n1o2p Initial commit: README
```

## License

This project is open-source and available under the ISC License.
