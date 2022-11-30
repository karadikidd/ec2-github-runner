const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunner(label, runnerName) {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    core.info(`looking for label: ${label} or name: ${runnerName}`)
    const runners = await octokit.paginate('GET /repos/{owner}/{repo}/actions/runners', config.githubContext);
    core.debug(`Total unfiltered runners: ${runners.length}`)
    core.debug(`Found the following unfiltered runners: ${JSON.stringify(runners, null, 2)}`)
    const foundRunners = _.filter(runners, { labels: [{ name: label }] });
    const foundRunnersByDnsName = _.filter(runners, { name: runnerName });
    core.debug(`Total filtered runners: ${foundRunners.length}`)
    core.debug(`Total filtered runners by name: ${foundRunnersByDnsName.length}`)
    core.debug(`Found the following filtered runners: ${JSON.stringify(foundRunners, null, 2)}`)
    core.debug(`Found the following filtered runners by name: ${JSON.stringify(foundRunnersByDnsName, null, 2)}`)
    if (foundRunners.length) {
      core.info(`Found runner by label: ${label}`)
      return foundRunners[0]
    } else if (foundRunnersByDnsName.length) {
      core.info(`Found runner by name: ${runnerName}`)
      return foundRunnersByDnsName[0]
    } else {
      core.info(`Could not find runner using label ${label} or by name: ${runnerName}`)
      return null;
    }
  } catch (error) {
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', config.githubContext);
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunner(runnerName = null) {
  const runnerNameToUse = runnerName ? runnerName : config.input.runnerName
  const runner = await getRunner(config.input.label, runnerNameToUse);
  const octokit = github.getOctokit(config.input.githubToken);

  // skip the runner removal process if the runner is not found
  if (!runner || (runner.status !== 'offline' && runnerName)) {
    core.info(`GitHub self-hosted runner with label ${config.input.label} was not found, or the status is not offline, so removal is skipped`);
    return;
  }

  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', _.merge(config.githubContext, { runner_id: runner.id }));
    core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    return;
  } catch (error) {
    core.error('GitHub self-hosted runner removal error');
    throw error;
  }
}

async function waitForRunnerRegistered(label, runnerName) {
  const timeoutMinutes = 5;
  const retryIntervalSeconds = 30;
  const quietPeriodSeconds = 30;
  let waitSeconds = 0;
  // const octokit = github.getOctokit(config.input.githubToken);

  core.info(`Waiting ${quietPeriodSeconds}s for the AWS EC2 instance to be registered in GitHub as a new self-hosted runner`);
  await new Promise(r => setTimeout(r, quietPeriodSeconds * 1000));
  core.info(`Checking every ${retryIntervalSeconds}s if the GitHub self-hosted runner is registered`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      const runner = await getRunner(label, runnerName);
    
      // const apiRateStatus = await octokit.request('GET /users/octocat');
      // core.info(JSON.stringify(apiRateStatus, null, 2));
      if (waitSeconds > timeoutMinutes * 60) {
        core.error('GitHub self-hosted runner registration error');
        clearInterval(interval);
        reject(`A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instance was not able to register itself in GitHub as a new self-hosted runner.`);
      }

      if (runner && runner.status === 'online') {
        core.info(`GitHub self-hosted runner ${runner.name} is registered and ready to use`);
        clearInterval(interval);
        resolve();
      } else {
        waitSeconds += retryIntervalSeconds;
        core.info(`Runner is not yet ready, sleeping for ${retryIntervalSeconds} seconds...`);
      }
    }, retryIntervalSeconds * 1000);
  });
}

module.exports = {
  getRunner,
  getRegistrationToken,
  removeRunner,
  waitForRunnerRegistered,
};
