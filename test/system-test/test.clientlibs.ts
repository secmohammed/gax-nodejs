/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as execa from 'execa';
import * as fs from 'fs';
import * as path from 'path';
import * as rimraf from 'rimraf';
import * as util from 'util';
import {describe, it, before} from 'mocha';

const mkdir = util.promisify(fs.mkdir);
const rmrf = util.promisify(rimraf);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const baseRepoUrl = 'https://github.com/googleapis/';
const monoRepoBaseRepoUrl = 'https://github.com/googleapis/google-cloud-node';
const clonedRepos: Array<string> = []; // keeps track of already cloned repos
const monoRepoDirectory = 'google-cloud-node';
const testDir = path.join(process.cwd(), '.system-test-run');
const gaxDir = path.resolve(__dirname, '..', '..', '..');

// We will pack google-gax using `npm pack`, defining some constants to make it
// easier to consume that tarball
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../../package.json');
const gaxTarball = path.join(gaxDir, `${pkg.name}-${pkg.version}.tgz`);

async function latestRelease(
  cwd: string,
  inMonorepo: boolean
): Promise<string> {
  // tags in the monorepo follow the format <libraryname>-major.minor.patch e.g. batch-0.0.1
  // or the format <libraryname>-vmajor.minor.patch e.g. batch-v0.0.1
  // tags in individual repos follow the format vmajor.minor.patch e.g. v0.0.1
  const {stdout} = inMonorepo
    ? await execa('git', ['tag', '--list', `${cwd}-*`], {
        cwd: monoRepoDirectory,
      })
    : await execa('git', ['tag', '--list'], {cwd});
  // regex escape characters in template literal need to be escaped twice
  const filterPattern = inMonorepo
    ? new RegExp(`^${cwd}-v{0,1}(\\d+)\\.(\\d)+\\.(\\d+)$`)
    : new RegExp('^v(\\d+)\\.(\\d+)\\.(\\d+)$');
  const tags = stdout
    .split('\n')
    .filter(str => str.match(filterPattern))
    .sort((tag1: string, tag2: string): number => {
      const match1 = tag1.match(filterPattern);
      const match2 = tag2.match(filterPattern);
      if (!match1 || !match2) {
        throw new Error(`Cannot compare git tags ${tag1} and ${tag2}`);
      }
      // compare major version, then minor versions, then patch versions.
      // return positive number, zero, or negative number
      for (let idx = 1; idx <= 3; ++idx) {
        if (match1[idx] !== match2[idx]) {
          return Number(match1[idx]) - Number(match2[idx]);
        }
      }
      return 0;
    });
  // the last tag in the list is the latest release
  return tags[tags.length - 1];
}

// if a package in the monorepo has a hyphen in the name, its corresponding
// directory in packages/ does not
function monoRepoPackageSubdirectory(packageName: string): string {
  return `${monoRepoDirectory}/packages/google-cloud-${packageName.replace(
    '-',
    ''
  )}`;
}
async function preparePackage(
  packageName: string,
  inMonorepo: boolean
): Promise<void> {
  // clone googleapis/google-cloud node if monorepo, googleapis/nodejs-<package> if not
  const repoUrl = inMonorepo
    ? `${monoRepoBaseRepoUrl}.git`
    : `${baseRepoUrl}${packageName}.git`;
  // only clone a repo if we haven't done so already
  if (!clonedRepos.includes(repoUrl)) {
    try {
      await execa(
        'git',
        ['clone', repoUrl, inMonorepo ? monoRepoDirectory : packageName],
        {stdio: 'inherit'}
      );
      clonedRepos.push(repoUrl);
    } catch (error: unknown) {
      throw new Error(`Problem cloning monorepo: ${error}`);
    }
  }

  const tag = await latestRelease(packageName, inMonorepo);
  await execa('git', ['checkout', tag], {
    cwd: inMonorepo ? monoRepoDirectory : packageName,
    stdio: 'inherit',
  });

  const packagePath = monoRepoPackageSubdirectory(packageName); // used if in monoRepo
  const packageJson = path.join(
    inMonorepo ? packagePath : packageName,
    'package.json'
  );
  const packageJsonStr = (await readFile(packageJson)).toString();
  const packageJsonObj = JSON.parse(packageJsonStr);
  packageJsonObj['dependencies']['google-gax'] = `file:${gaxTarball}`;
  await writeFile(packageJson, JSON.stringify(packageJsonObj, null, '  '));
  packageJsonObj['dependencies']['google-gax'] = `file:${gaxTarball}`;
  await writeFile(packageJson, JSON.stringify(packageJsonObj, null, '  '));
  await execa('npm', ['install'], {
    cwd: inMonorepo ? packagePath : packageName,
    stdio: 'inherit',
  });
}

async function runSystemTest(
  packageName: string,
  inMonorepo: boolean
): Promise<void> {
  await execa('npm', ['run', 'system-test'], {
    cwd: inMonorepo ? monoRepoPackageSubdirectory(packageName) : packageName,
    stdio: 'inherit',
  });
}
// nodejs-kms does not have system test.
async function runSamplesTest(
  packageName: string,
  inMonorepo: boolean
): Promise<void> {
  await execa('npm', ['run', 'samples-test'], {
    cwd: inMonorepo ? monoRepoPackageSubdirectory(packageName) : packageName,
    stdio: 'inherit',
  });
}

describe('Run system tests for some libraries', () => {
  before(async () => {
    console.log('Packing google-gax...');
    await execa('npm', ['pack'], {cwd: gaxDir, stdio: 'inherit'});

    if (!fs.existsSync(gaxTarball)) {
      throw new Error(`npm pack tarball ${gaxTarball} does not exist`);
    }

    await rmrf(testDir);
    await mkdir(testDir);
    process.chdir(testDir);
    console.log(`Running tests in ${testDir}.`);
  });

  // Speech has unary, LRO, and streaming
  // Speech is not in the monorepo
  describe('speech', () => {
    before(async () => {
      await preparePackage('nodejs-speech', false);
    });
    it('should pass system tests', async () => {
      await runSystemTest('nodejs-speech', false);
    });
  });

  // KMS api has IAM service injected from gax. All its IAM related test are in samples-test.
  // KMS is in the google-cloud-node monorepo
  describe('kms', () => {
    before(async () => {
      await preparePackage('kms', true);
    });
    it('should pass samples tests', async () => {
      await runSamplesTest('kms', true);
    });
  });
});
