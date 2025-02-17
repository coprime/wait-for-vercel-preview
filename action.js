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
  sha,
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
      const headers = {
        "Authorization": `Bearer ${VERCEL_TOKEN}`
      }
      const vercelDeps = await axios.get(`https://api.vercel.com/v6/deployments?teamId=${VERCEL_TEAM}`, { headers });
      const hasQueuedDeployments = vercelDeps.data.deployments.some(d => d.state === 'QUEUED' || d.state === 'BUILDING' || d.state === 'INITIALIZING')
      const queuedDeployments = vercelDeps.data.deployments.filter(d => d.state === 'QUEUED' || d.state === 'BUILDING' || d.state === 'INITIALIZING')
      const vercelProjects = await axios.get(`https://api.vercel.com/v9/projects?teamId=${VERCEL_TEAM}`, { headers });
      const latestDeployments = vercelProjects.data.projects.map(d => d.latestDeployments)
      const finalLinks = []
      latestDeployments.forEach(projectDeployments => {
        projectDeployments.forEach(deployment => {
          if (deployment.meta.githubCommitSha === sha) {
            const toAdd = {
              url: deployment.automaticAliases[deployment.automaticAliases.length - 1],
              name: deployment.name,
            }
            finalLinks.push(toAdd)
          }
        })
      })
      if (!hasQueuedDeployments) return finalLinks
      else {
        console.log(`Still deploying ${queuedDeployments.map(d => d.name).join(', ')}`)
        await wait(checkIntervalInMilliseconds);
      }
    } catch (e) {
      console.error('error in vercel call', e)
    }

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
    const MAX_TIMEOUT = Number(core.getInput('max_timeout')) || 720;
    const ALLOW_INACTIVE = Boolean(core.getInput('allow_inactive')) || false;
    const PATH = core.getInput('path') || '/';
    const CHECK_INTERVAL_IN_MS =
      (Number(core.getInput('check_interval')) || 2) * 1000;

    // Fail if we have don't have a github token
    if (!GITHUB_TOKEN) core.setFailed('Required field `token` was not provided');
    if (!VERCEL_TOKEN) core.setFailed('Required field `vercel_token` was not provided');

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
    const urls = await waitForDeploymentToStart({
      sha,
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      VERCEL_TOKEN,
    });

    if (!urls) {
      core.setFailed('no vercel deployment found, exiting...');
      return;
    }
    console.log('urls', urls)
    core.setOutput('urls', urls);

    urls.map(d=> d.url).forEach(async (url, i) => {
     await waitForUrl({
      url: `https://${url}`,
      maxTimeout: MAX_TIMEOUT,
      checkIntervalInMilliseconds: CHECK_INTERVAL_IN_MS,
      vercelPassword: VERCEL_PASSWORD,
      path: PATH,
    });
    })

  } catch (error) {
    core.setFailed(error.message);
  }
};

exports.run = run;
