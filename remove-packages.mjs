#!/usr/bin/node

/**
 * @fileoverview CLI utility to bulk-remove old npm package versions from
 * the GitHub Packages registry for the `refrens` organisation.
 *
 * Usage:
 *   GITHUB_TOKEN=<token> node remove-packages.mjs [options]
 *
 * Options:
 *   -n, --name <name>           Target a specific package (default: "all")
 *   -k, --keep <keep>           Number of latest versions to keep (default: 500, must be a multiple of pageSize)
 *   -s, --page-size <pageSize>  Number of versions to fetch per API call (default: 100)
 *
 * @requires GITHUB_TOKEN environment variable with `packages:read` and `packages:delete` scopes.
 */

import { Octokit } from 'octokit';
import { program } from 'commander';
import fetch from 'node-fetch';
import cliProgress from 'cli-progress';

/** Authenticated GitHub API client (uses GITHUB_TOKEN env var). */
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { fetch } });

/** GitHub organisation that owns the packages. */
const org = 'refrens';

/** Package type filter — only npm packages are targeted. */
const packageType = 'npm';

/** Default number of versions returned per API page. */
const defaultPageSize = 100;

/**
 * Fetches a single page of package version IDs from the GitHub API.
 *
 * @param {string} name      - The package name to query.
 * @param {number} pageSize  - Number of versions to retrieve per page.
 * @param {number} page      - 1-indexed page number to fetch.
 * @returns {Promise<number[]>} Array of version IDs returned by this page.
 */
async function fetchPackages(name, pageSize, page) {
  const resp = await octokit.request(
    'GET /orgs/{org}/packages/{package_type}/{package_name}/versions',
    {
      org,
      package_type: packageType,
      package_name: name,
      per_page: pageSize,
      page,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  const { data } = resp;
  return data.map(({ id }) => id);
}

/**
 * Paginates through all package versions starting from a given page and
 * collects every version ID into a single flat array.
 *
 * Pagination stops when a page returns fewer results than `pageSize`,
 * indicating the last page has been reached.
 *
 * @param {string} name      - The package name to query.
 * @param {number} pageSize  - Number of versions to retrieve per page.
 * @param {number} page      - Starting page number (1-indexed).
 * @returns {Promise<number[]>} Flat array of all collected version IDs.
 */
async function fetchPackageIds(name, pageSize, page, pagesBar) {
  const ids = [];
  let currentPage = page;
  while (1) {
    const packages = await fetchPackages(name, pageSize, currentPage);
    ids.push(packages);
    pagesBar.increment();
    // If fewer results than the page size were returned, we've hit the last page.
    if (packages.length < pageSize) {
      break;
    } else {
      currentPage += 1;
    }
  }
  pagesBar.setTotal(currentPage - page + 1);
  return ids.flat();
}

/**
 * Deletes a single package version by its ID from the GitHub Packages registry.
 *
 * Catches and logs errors (e.g. 404s, rate-limits) so that a single failure
 * does not abort the entire batch.
 *
 * @param {string} name - The package name the version belongs to.
 * @param {number} id   - The version ID to delete.
 * @returns {Promise<{ success: boolean, id: number }>}
 */
async function deletePackage(name, id) {
  try {
    await octokit.request(
      'DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        org,
        package_type: packageType,
        package_name: name,
        package_version_id: id,
        headers: {
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    return { success: true, id };
  } catch (error) {
    console.error(`failed to delete version ${id} of ${name}: ${error.message}`);
    return { success: false, id };
  }
}

/**
 * High-level orchestrator that fetches package version IDs (skipping the first
 * `keep` versions) and then deletes all remaining versions concurrently.
 *
 * Uses `Promise.allSettled` so that individual failures (e.g. rate-limits,
 * already-deleted versions) do not abort the entire batch.
 *
 * Displays a per-package progress bar for version deletions. An optional
 * `overallBar` (from a shared MultiBar) is incremented once this package
 * finishes.
 *
 * The `keep` value is divided by `pageSize` (+1) to compute the starting page,
 * effectively skipping the most recent versions that should be preserved.
 *
 * @param {string} name       - The package whose old versions should be purged.
 * @param {number} keep       - Number of latest versions to retain.
 * @param {number} pageSize   - Page size for the version listing API calls.
 * @param {cliProgress.MultiBar} multiBar   - Shared MultiBar instance for creating bars.
 * @param {cliProgress.SingleBar | null} overallBar - Optional overall-packages bar to increment.
 * @returns {Promise<void>}
 */
async function fetchAndDelete(name, keep, pageSize, multiBar, overallBar) {
  const pagesBar = multiBar.create(keep / pageSize + 15, 0, { package: name, unit: 'pages' });
  // Start fetching from the page *after* the versions we want to keep.
  const ids = await fetchPackageIds(name, pageSize, keep / pageSize + 1, pagesBar);
  const total = ids.length;

  // Create a per-package bar tracking individual version deletions.
  const versionBar = multiBar.create(total, 0, { package: name, unit: 'versions' });

  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const result = await deletePackage(name, id);
      versionBar.increment();
      return result;
    }),
  );

  // Summarise successes and failures after the batch completes.
  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.success).length;
  const failed = results.length - succeeded;
  multiBar.remove(versionBar);
  multiBar.remove(pagesBar);
  // multiBar.log(`  ${name}: ${succeeded} deleted, ${failed} failed out of ${total}\n`);

  // Tick the overall-packages bar if present.
  if (overallBar) {
    overallBar.increment();
  }
}

/**
 * Retrieves the names of all npm packages published under the organisation.
 *
 * @returns {Promise<string[]>} Array of package names.
 */
async function getPackageNames() {
  const resp = await octokit.request('GET /orgs/{org}/packages', {
    org,
    package_type: packageType,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const { data } = resp;
  return data.map(({ name }) => name);
}

// ── CLI definition ──────────────────────────────────────────────────────────────
program
  .option('-n, --name <name>', 'package name')
  .option('-k, --keep <keep>', 'keep latest count', parseInt)
  .option('-s, --page-size <pageSize>', 'page size', parseInt)
  .action(async (options) => {
    const { name = 'all', keep = 500, pageSize = defaultPageSize } = options;

    // `keep` must align to page boundaries so the starting page calculation is exact.
    if (keep % pageSize !== 0) {
      console.error(`keep must be in multiples of ${pageSize}`);
      process.exit(1);
    }

    // Shared multi-bar container for all progress bars.
    const multiBar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: ' \x1b[32m{bar}\x1b[0m | {package} | {value}/{total} {unit}',
      },
      cliProgress.Presets.shades_grey,
    );

    if (name !== 'all') {
      // Target a single package.
      await fetchAndDelete(name, keep, pageSize, multiBar, null);
    } else {
      // Process every package in the organisation, one at a time.
      const packageNames = await getPackageNames();

      // Overall bar tracks how many packages have been fully processed.
      const overallBar = multiBar.create(packageNames.length, 0, {
        package: 'overall',
        unit: 'packages',
      });

      for (const name of packageNames) {
        await fetchAndDelete(name, keep, pageSize, multiBar, overallBar);
      }

      overallBar.stop();
    }

    multiBar.stop();
    console.log('done');
    process.exit();
  });

program.parse(process.argv);
