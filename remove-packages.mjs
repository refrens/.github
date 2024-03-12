#!/usr/bin/node

import { Octokit } from 'octokit';
import { program } from 'commander';
import fetch from 'node-fetch';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, request: { fetch } });

const org = 'refrens';
const packageType = 'npm';
const defaultPageSize = 100;
let deleted = 0;

async function fetchPackages(name, pageSize, page) {
  console.log(`fetching page ${page}`);
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

async function fetchPackageIds(name, pageSize, page) {
  const ids = [];
  let currentPage = page;
  while (1) {
    const packages = await fetchPackages(name, pageSize, currentPage);
    ids.push(packages);
    if (packages.length < pageSize) {
      break;
    } else {
      currentPage += 1;
    }
  }
  return ids.flat();
}

async function deletePackage(name, id) {
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
  deleted += 1;
  if (deleted % 10 === 0) {
    console.log(`deleted ${deleted}`);
  }
}

program
  .option('-n, --name <name>', 'package name')
  .option('-k, --keep <keep>', 'keep latest count', parseInt)
  .option('-s, --page-size <pageSize>', 'page size', parseInt)
  .action(async (options) => {
    const { name, keep = 500, pageSize = defaultPageSize } = options;
    if (keep % pageSize !== 0) {
      console.error(`keep must be in multiples of ${pageSize}`);
      process.exit(1);
    }
    const ids = await fetchPackageIds(name, pageSize, keep / pageSize + 1);
    console.log(`total packages: ${ids.length}`);
    await Promise.all(
      ids.map((id) => {
        return deletePackage(name, id);
      }),
    );
    console.log('removed all packages');
    process.exit();
  });
program.parse(process.argv);
