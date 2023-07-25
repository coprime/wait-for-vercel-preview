// @ts-check
// Dependencies are compiled using https://github.com/vercel/ncc
const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');
const setCookieParser = require('set-cookie-parser');

const calculateIterations = (maxTimeoutSec, checkIntervalInMilliseconds) =>
  Math.floor(maxTimeoutSec / (checkIntervalInMilliseconds / 1000));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForUrl = async ({
  url,
  maxTimeout,
  checkIntervalInMilliseconds,
  vercelPassword,
  path,
}) => {
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      let headers = {};

      if (vercelPassword) {
        const jwt = await getPassword({
          url,
          vercelPassword,
        });

        headers = {
          Cookie: `_vercel_jwt=${jwt}`,
        };

        core.setOutput('vercel_jwt', jwt);
      }

      let checkUri = new URL(path, url);
      console.log('checkUri', checkUri)
      if (!checkUri) return

      await axios.get(checkUri.toString(), {
        headers,
      });
      console.log('Received success status code');
      return;
    } catch (e) {
      // https://axios-http.com/docs/handling_errors
      if (e.response) {
        console.log(
          `GET status: ${e.response.status}. Attempt ${i} of ${iterations}`
        );
      } else if (e.request) {
        console.log(
          `GET error. A request was made, but no response was received. Attempt ${i} of ${iterations}`
        );
        console.log(e.message);
      } else {
        console.log('error url', url)
        console.log(e);
      }

      await wait(checkIntervalInMilliseconds);
    }
  }

  core.setFailed(`Timeout reached: Unable to connect to ${url}`);
};

/**
 * See https://vercel.com/docs/errors#errors/bypassing-password-protection-programmatically
 * @param {{url: string; vercelPassword: string }} options vercel password options
 * @returns {Promise<string>}
 */
const getPassword = async ({ url, vercelPassword }) => {
  console.log('requesting vercel JWT');

  const data = new URLSearchParams();
  data.append('_vercel_password', vercelPassword);

  const response = await axios({
    url,
    method: 'post',
    data: data.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    maxRedirects: 0,
    validateStatus: (status) => {
      // Vercel returns 303 with the _vercel_jwt
      return status >= 200 && status < 307;
    },
  });

  const setCookieHeader = response.headers['set-cookie'];

  if (!setCookieHeader) {
    throw new Error('no vercel JWT in response');
  }

  const cookies = setCookieParser(setCookieHeader);

  const vercelJwtCookie = cookies.find(
    (cookie) => cookie.name === '_vercel_jwt'
  );

  if (!vercelJwtCookie || !vercelJwtCookie.value) {
    throw new Error('no vercel JWT in response');
  }

  console.log('received vercel JWT');

  return vercelJwtCookie.value;
};

const waitForStatus = async ({
  token,
  owner,
  repo,
  deployment_id,
  maxTimeout,
  allowInactive,
  checkIntervalInMilliseconds,
}) => {
  const octokit = new github.getOctokit(token);
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  for (let i = 0; i < iterations; i++) {
    try {
      const statuses = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id,
      });

      const status = statuses.data.length > 0 && statuses.data[0];

      if (!status) {
        throw new StatusError('No status was available');
      }

      if (status && allowInactive === true && status.state === 'inactive') {
        return status;
      }

      if (status && status.state !== 'success') {
        throw new StatusError('No status with state "success" was available');
      }

      if (status && status.state === 'success') {
        return status;
      }

      throw new StatusError('Unknown status error');
    } catch (e) {
      console.log(
        `Deployment unavailable or not successful, retrying (attempt ${
          i + 1
        } / ${iterations})`
      );
      if (e instanceof StatusError) {
        if (e.message.includes('No status with state "success"')) {
          // TODO: does anything actually need to be logged in this case?
        } else {
          console.log(e.message);
        }
      } else {
        console.log(e);
      }
      await wait(checkIntervalInMilliseconds);
    }
  }
  core.setFailed(
    `Timeout reached: Unable to wait for an deployment to be successful`
  );
};

class StatusError extends Error {
  constructor(message) {
    super(message);
  }
}

/**
 * Waits until the github API returns a deployment for
 * a given actor.
 *
 * Accounts for race conditions where this action starts
 * before the actor's action has started.
 *
 * @returns
 */
const waitForDeploymentToStart = async ({
  octokit,
  owner,
  repo,
  sha,
  environment,
  actorName = 'vercel[bot]',
  maxTimeout = 20,
  checkIntervalInMilliseconds = 2000,
  VERCEL_TOKEN
}) => {
  const iterations = calculateIterations(
    maxTimeout,
    checkIntervalInMilliseconds
  );

  const VERCEL_TEAM = 'coprime'
  for (let i = 0; i < iterations; i++) {
    try {
      const vercelDeps = await axios.get(`https://api.vercel.com/v6/deployments?teamId=${VERCEL_TEAM}`, {
        headers: {
          "Authorization": `Bearer ${VERCEL_TOKEN}`
        }
      });
      // console.log('vercelDeps', vercelDeps)
      console.log('all deployments', vercelDeps.data.deployments)
      console.log('apps', vercelDeps.data.deployments.map(d => ({ name: d.name, state: d.state })))
      const hasQueuedDeployments = vercelDeps.data.deployments.some(d => d.state === 'QUEUED')
      const vercelProjects = await axios.get(`https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM}`, {
        headers: {
          "Authorization": `Bearer ${VERCEL_TOKEN}`
        }
      });
      console.log('vercel projects', vercelProjects.data)
      if (!hasQueuedDeployments) return vercelDeps.data.deployments.filter(d => d.state !== 'CANCELED').map(d => d.url)

      // return vercelDeps.data.deployments;

    } catch (e) {
      console.error('error in vercel call', e)
    }
  //   try {
  //     const deployments = await octokit.rest.repos.listDeployments({
  //       owner,
  //       repo,
  //       sha,
  //       environment,
  //     });
  //     core.setOutput('deployments', deployments);
  //     // console.log({ sha, owner, repo, environment })
  //     console.log('all deployments', deployments)

  //     const vercelDeployments =
  //       deployments.data.length > 0 &&
  //       deployments.data.filter((deployment) => {
  //         return deployment.creator.login === actorName;
  //       });
  //     core.setOutput('deployment', vercelDeployments);
  //     // console.log('creator', deployments.data?.[0]?.creator?.login)
  //     // console.log('creator stringified', JSON.stringify(deployments?.data?.[0]?.creator))
  //     console.log('vercelDeployments', JSON.stringify(vercelDeployments, null, 2))

  //     if (vercelDeployments.length > 0) {
  //       console.log('vercelDeployments', JSON.stringify(vercelDeployments, null, 2))
  //       return vercelDeployments;
  //     }

  //     console.log(
  //       `Could not find any jareds for actor ${actorName}, retrying (attempt ${
  //         i + 1
  //       } / ${iterations})`
  //     );
  //   } catch(e) {
  //     console.log(
  //       `Error while fetching deployments, retrying (attempt ${
  //         i + 1
  //       } / ${iterations})`
  //     );

  //     console.error(e)
  //   }

    await wait(checkIntervalInMilliseconds);
  }

  return null;
};

async function getShaForPullRequest({ octokit, owner, repo, number }) {
  const PR_NUMBER = github.context.payload.pull_request.number;

  if (!PR_NUMBER) {
    core.setFailed('No pull request number was found');
    return;
  }

  // Get information about the pull request
  const currentPR = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: PR_NUMBER,
  });

  if (currentPR.status !== 200) {
    core.setFailed('Could not get information about the current pull request');
    return;
  }

  // Get Ref from pull request
  const prSHA = currentPR.data.head.sha;

  return prSHA;
}

const run = async () => {
  try {
    // Inputs
    const GITHUB_TOKEN = core.getInput('token', { required: true });
    const VERCEL_PASSWORD = core.getInput('vercel_password');
    const VERCEL_TOKEN = core.getInput('vercel_token');
    const ENVIRONMENT = core.getInput('environment');
    const MAX_TIMEOUT = Number(core.getInput('max_timeout')) || 60;
    const ALLOW_INACTIVE = Boolean(core.getInput('allow_inactive')) || false;
    const PATH = core.getInput('path') || '/';
    const CHECK_INTERVAL_IN_MS =
      (Number(core.getInput('check_interval')) || 2) * 1000;

    // Fail if we have don't have a github token
    if (!GITHUB_TOKEN) {
      core.setFailed('Required field `token` was not provided');
    }

    const octokit = github.getOctokit(GITHUB_TOKEN);

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    /**
     * @type {string}
     */
    let sha;

    if (github.context.payload && github.context.payload.pull_request) {
      sha = await getShaForPullRequest({
        octokit,
        owner,
        repo,
        number: github.context.payload.pull_request.number,
      });
    } else if (github.context.sha) {
      sha = github.context.sha;
    }

    if (!sha) {
      core.setFailed('Unable to determine SHA. Exiting...');
      return;
    }

    // Get deployments associated with the pull request.
    const deployments = await waitForDeploymentToStart({
      octokit,
      owner,
      repo,
      sha,
      environment: ENVIRONMENT,
      actorName: 'vercel[bot]',
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      VERCEL_TOKEN,
    });

    if (!deployments) {
      core.setFailed('no vercel deployment found, exiting...');
      return;
    }
    const targetUrl = ''
    // const allUrls = deployments.filter(d => d.state !=='CANCELED').map(d => d.url)
    // console.log('allUrls', allUrls)
    const urls = deployments
    core.setOutput('urls', urls);

    console.log('urls', urls)
    // urls.forEach(async (url, i) => {
    //  await waitForUrl({
    //   url,
    //   maxTimeout: MAX_TIMEOUT,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    //   vercelPassword: VERCEL_PASSWORD,
    //   path: PATH,
    // });
    // })


    // const status1 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments[0].uid,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });
    // const status2 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[1]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });

    // const status3 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[2]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });
    // const status4 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[3]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });
    // const status5 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[4]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });
    // const status6 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[5]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });
    // const status7 = await waitForStatus({
    //   owner,
    //   repo,
    //   deployment_id: deployments?.[6]?.id,
    //   token: GITHUB_TOKEN,
    //   maxTimeout: MAX_TIMEOUT,
    //   allowInactive: ALLOW_INACTIVE,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    // });


    // Get target url
    // const targetUrl = status1.target_url;
    // const targetUrl2 = status2.target_url;
    // const targetUrl3 = status3.target_url;
    // const targetUrl4 = status4.target_url;
    // const targetUrl5 = status5.target_url;
    // const targetUrl6 = status6.target_url;
    // const targetUrl7 = status7.target_url;

    // if (!targetUrl) {
    //   core.setFailed(`no target_url found in the status check`);
    //   return;
    // }

    // console.log('target url1 »', targetUrl);
    // console.log('target url2 »', targetUrl2);
    // console.log('target url3 »', targetUrl3);
    // console.log('target url4 »', targetUrl4);
    // console.log('target url5 »', targetUrl5);
    // console.log('target url6 »', targetUrl6);
    // console.log('target url7 »', targetUrl7);

    // Set output
    // core.setOutput('url 1', targetUrl);
    // core.setOutput('url 2 ', targetUrl2);
    // core.setOutput('url 3 ', targetUrl3);
    // core.setOutput('url 4 ', targetUrl4);
    // core.setOutput('url 5 ', targetUrl5);
    // core.setOutput('url 6 ', targetUrl6);
    // core.setOutput('url 7 ', targetUrl7);

    // Wait for url to respond with a success
    // console.log(`Waiting for a status code 200 from: ${targetUrl}`);

    // await waitForUrl({
    //   url: targetUrl,
    //   maxTimeout: MAX_TIMEOUT,
    //   checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
    //   vercelPassword: VERCEL_PASSWORD,
    //   path: PATH,
    // });
  } catch (error) {
    core.setFailed(error.message);
  }
};

exports.run = run;
