const fs = require('fs');
const axios = require('axios');

const goldenTestConfig = {
  angular: ['*'],
  cypress: ['*'],
  esbuild: ['*'],
  eslint: ['*'],
  gradle: ['*'],
  jest: ['*'],
  js: ['*'],
  'learn-smoke-test': ['*'],
  next: ['*'],
  node: ['*'],
  nuxt: ['*'],
  nx: ['*'],
  'nx-init': ['*'],
  playwright: ['*'],
  plugin: ['*'],
  react: ['*'],
  release: ['*'],
  rollup: ['*'],
  rspack: ['*'],
  storybook: ['*'],
  vite: ['*'],
  vue: ['*'],
  web: ['*'],
  webpack: ['*'],
  'workspace-create': ['*'],
};

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

function parseTestResults() {
  const testResults = [];

  console.log('🔍 Looking for test results in project folders...');

  for (const projectName of Object.keys(goldenTestConfig)) {
    const testResultsPath = `e2e/${projectName}/test-results.json`;

    if (fs.existsSync(testResultsPath)) {
      try {
        const rawResults = JSON.parse(fs.readFileSync(testResultsPath, 'utf8'));
        console.log(
          `✅ Found test results for ${projectName}: ${testResultsPath}`
        );

        const projectResults = parseProjectResults(rawResults, projectName);
        testResults.push(...projectResults);
      } catch (error) {
        console.warn(`⚠️  Failed to parse ${testResultsPath}:`, error.message);
      }
    } else {
      console.log(
        `ℹ️  No test results found for ${projectName} (${testResultsPath}) - skipping`
      );
    }
  }

  return testResults;
}

function parseProjectResults(nxResults, projectName) {
  const testResults = [];

  console.log(`📊 Processing results for project: ${projectName}`);

  // Handle Jest test result format
  if (nxResults.testResults && Array.isArray(nxResults.testResults)) {
    console.log(
      `📋 Found Jest format results with ${nxResults.testResults.length} test suites`
    );

    nxResults.testResults.forEach((testSuite) => {
      const parsed = parseJestTestSuite(testSuite, projectName, nxResults);
      if (parsed) testResults.push(parsed);
    });
  } else {
    console.warn(
      `⚠️  Unexpected test result format for ${projectName}, expected Jest format with testResults array`
    );
  }

  console.log(`📈 Found ${testResults.length} test results for ${projectName}`);
  return testResults;
}

// Parse Jest test suite result
function parseJestTestSuite(testSuite, projectName, overallResults) {
  // Extract test file name from the test suite
  const testFile =
    testSuite.name || testSuite.testFilePath || `${projectName} test suite`;

  // Determine if this test suite passed or failed
  const hasFailed =
    testSuite.status === 'failed' ||
    testSuite.numFailingTests > 0 ||
    testSuite.failureMessage;

  const status = hasFailed ? 'failed' : 'passed';

  return {
    project: projectName,
    testFile: testFile,
    status: status,
    failures: testSuite.numFailingTests || 0,
    successes: testSuite.numPassingTests || 0,
    total: testSuite.numPassingTests + testSuite.numFailingTests || 0,
    duration: testSuite.perfStats
      ? testSuite.perfStats.end - testSuite.perfStats.start
      : 0,
    startTime: testSuite.perfStats?.start,
    endTime: testSuite.perfStats?.end,
    failureMessage: testSuite.failureMessage,
    source: `e2e/${projectName}/test-results.json`,
    // Include overall test run info
    overallSuccess: overallResults.success,
    totalFailedSuites: overallResults.numFailedTestSuites,
    totalFailedTests: overallResults.numFailedTests,
  };
}
// Check if a test is golden (since all tests in our config are '*', they all are)
function isGoldenTest(project, testFile) {
  const projectConfig = goldenTestConfig[project];
  if (!projectConfig) return false;

  // Handle wildcard '*' - all tests in project are golden
  if (projectConfig.includes('*')) return true;

  return projectConfig.some((pattern) => {
    if (pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(testFile);
    }
    return testFile.includes(pattern);
  });
}

function analyzeGoldenTestFailures(testResults) {
  const goldenFailures = [];
  const summary = {
    totalTests: testResults.length,
    totalFailures: 0,
    goldenFailures: 0,
    nonGoldenFailures: 0,
    projects: new Set(),
  };

  for (const result of testResults) {
    summary.projects.add(result.project);

    if (result.status === 'failed' || result.failures > 0) {
      summary.totalFailures++;

      if (isGoldenTest(result.project, result.testFile)) {
        summary.goldenFailures++;
        goldenFailures.push(result);
      } else {
        summary.nonGoldenFailures++;
      }
    }
  }

  return {
    goldenFailures,
    summary: {
      ...summary,
      projects: Array.from(summary.projects),
    },
  };
}

// Send Slack alert for golden test failures
async function sendSlackAlert(goldenFailures, summary) {
  if (!SLACK_WEBHOOK_URL) {
    console.log(
      '❌ No Slack webhook configured (SLACK_WEBHOOK_URL), skipping notification'
    );
    return false;
  }

  if (goldenFailures.length === 0) {
    console.log('✅ No golden test failures detected, no alert needed');
    return false;
  }

  // Group failures by project
  const failuresByProject = {};
  for (const failure of goldenFailures) {
    if (!failuresByProject[failure.project]) {
      failuresByProject[failure.project] = [];
    }
    failuresByProject[failure.project].push(failure);
  }

  // Build Slack message blocks
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🚨 Golden E2E Test Failures`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${goldenFailures.length}* golden tests are failing and require immediate attention!`,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Total Tests:* ${summary.totalTests}`,
        },
        {
          type: 'mrkdwn',
          text: `*Golden Failures:* ${summary.goldenFailures}`,
        },
        {
          type: 'mrkdwn',
          text: `*Affected Projects:* ${Object.keys(failuresByProject).length}`,
        },
      ],
    },
  ];

  // Add details for each project with failures
  for (const [project, failures] of Object.entries(failuresByProject)) {
    const failureList = failures
      .slice(0, 3) // Limit to 3 failures per project for readability
      .map((f) => {
        const fileName = f.testFile.split('/').pop() || f.testFile;
        const failureCount = f.failures ? ` (${f.failures} failed tests)` : '';
        return `• \`${fileName}\`${failureCount}`;
      })
      .join('\n');

    const moreFailures =
      failures.length > 3
        ? `\n_...and ${failures.length - 3} more test suites_`
        : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${project}* - FAILED:\n${failureList}${moreFailures}`,
      },
    });
  }

  // Add context information
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Branch: \`${
          process.env.GITHUB_REF_NAME ||
          process.env.GITHUB_HEAD_REF ||
          'unknown'
        }\` | Commit: \`${(process.env.GITHUB_SHA || 'unknown').substring(
          0,
          8
        )}\` | Run: <${process.env.GITHUB_SERVER_URL}/${
          process.env.GITHUB_REPOSITORY
        }/actions/runs/${process.env.GITHUB_RUN_ID}|#${
          process.env.GITHUB_RUN_NUMBER || 'local'
        }>`,
      },
    ],
  });

  const message = {
    username: 'Golden Test Monitor',
    icon_emoji: ':rotating_light:',
    blocks: blocks,
  };

  try {
    await axios.post(SLACK_WEBHOOK_URL, message);
    console.log(`✅ Slack alert sent successfully`);
    return true;
  } catch (error) {
    console.error(
      '❌ Failed to send Slack alert:',
      error.response?.data || error.message
    );
    return false;
  }
}

// Main execution function
async function main() {
  console.log('🔍 Starting Golden Test Monitor...');
  console.log(`📋 Monitoring ${Object.keys(goldenTestConfig).length} projects`);

  // Parse test results
  const testResults = parseTestResults();
  if (testResults.length === 0) {
    console.log(
      'ℹ️  No test results found - this may be normal if no e2e tests ran'
    );
    console.log('✅ Exiting gracefully - no golden tests to check');
    process.exit(0);
  }

  console.log(`📊 Found ${testResults.length} test results\n`);

  // Analyze for golden test failures
  const { goldenFailures, summary } = analyzeGoldenTestFailures(testResults);

  // Display summary
  console.log('📈 Analysis Summary:');
  console.log(`   Total Tests: ${summary.totalTests}`);
  console.log(`   Total Failures: ${summary.totalFailures}`);
  console.log(`   Golden Failures: ${summary.goldenFailures} ⚠️`);
  console.log(`   Non-Golden Failures: ${summary.nonGoldenFailures}`);
  console.log(`   Affected Projects: ${summary.projects.join(', ')}\n`);

  // Send Slack alert if needed
  await sendSlackAlert(goldenFailures, summary);

  // Exit with appropriate code
  if (summary.goldenFailures > 0) {
    console.log('❌ Golden tests are failing - immediate attention required!');
    process.exit(1);
  } else {
    console.log('✅ All golden tests are passing!');
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Golden Test Monitor failed:', error);
    process.exit(1);
  });
}

module.exports = {
  goldenTestConfig,
  parseTestResults,
  analyzeGoldenTestFailures,
  sendSlackAlert,
  main,
};
