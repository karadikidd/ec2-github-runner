const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');
const { backOff } = require('exponential-backoff');

const backOffSettings = {
  delayFirstAttempt: false,
  startingDelay: 2000,
  timeMultiple: 2,
  numOfAttempts: 5,
};
// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label, runnerName) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --name ${runnerName} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.303.0/actions-runner-linux-${RUNNER_ARCH}-2.303.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.303.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --name ${runnerName} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function startEc2Instance(label, runnerName, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label, runnerName);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2Instance = result.Instances[0];
    core.debug(`AWS EC2 instance metadata ${JSON.stringify(result, null, 2)}`);
    core.info(`AWS EC2 with instanceId ${ec2Instance.InstanceId} is started`);
    core.info(`AWS EC2 with name ${ec2Instance.PrivateDnsName.split('.')[0]} is started`);
    return ec2Instance;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

async function startEc2InstanceExponential(label, runnerName, githubRegistrationToken) {
  const instanceId = await backOff(
    async () => {
      const instanceId = await startEc2Instance(label, runnerName, githubRegistrationToken);
      return instanceId;
    },
    {
      ...backOffSettings,
      retry: (err, attemptNumber) => {
        core.info(err);
        core.info(`retry attmept: ${attemptNumber}`);
        const retry = err.code === "RequestLimitExceeded" ? true : false
        return retry
      },
    }
  );

  return instanceId;
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
  startEc2InstanceExponential,
};
