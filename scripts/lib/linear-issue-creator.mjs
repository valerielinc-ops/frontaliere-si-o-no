/**
 * linear-issue-creator.mjs — Auto-create Linear issues on workflow failure.
 *
 * Usage from CLI:
 *   node scripts/lib/linear-issue-creator.mjs \
 *     --title "CI Failure: Deploy" \
 *     --description "Deploy failed at step X" \
 *     --priority 2 \
 *     --label Bug \
 *     --project Crawlers
 *
 * Usage as module:
 *   import { createLinearIssue } from './linear-issue-creator.mjs';
 *   await createLinearIssue({ title, description, priority, labels, project });
 *
 * Requires LINEAR_API_KEY env var (from GitHub Secrets or Firebase Remote Config).
 */

const TEAM_ID = 'b6b27ed3-d12b-4acd-a507-81b468f93ebf'; // Frontaliere Ticino
const LINEAR_API = 'https://api.linear.app/graphql';

const PROJECT_MAP = {
  'Crawlers': '86bf03a8-3fa8-4ca3-aac2-ddab058b7cbc',
  'SEO': '90864ac9-b4db-4e2f-be4d-9afa8726d7bf',
  'Newsletter Implementation': '100c074c-678f-4fec-bc17-ed6b65398f9b',
};

const WORKFLOW_PROJECT_MAP = {
  'Update': 'Crawlers',
  'Collect Border': 'Crawlers',
  'Generate Blog': 'SEO',
  'Deploy to GitHub': 'SEO',
  'Send Newsletter': 'Newsletter Implementation',
  'Fuel Prices': 'Crawlers',
};

function getProjectForWorkflow(workflowName) {
  for (const [pattern, project] of Object.entries(WORKFLOW_PROJECT_MAP)) {
    if (workflowName.includes(pattern)) return project;
  }
  return 'Crawlers'; // default
}

async function linearGraphQL(query, variables, apiKey) {
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Linear API: ${json.errors[0].message}`);
  return json.data;
}

/**
 * Search for existing open issues with a similar title to avoid duplicates.
 */
async function findExistingIssue(titlePrefix, apiKey) {
  const data = await linearGraphQL(`
    query($filter: IssueFilter) {
      issues(filter: $filter, first: 5) {
        nodes { id identifier title }
      }
    }
  `, {
    filter: {
      team: { id: { eq: TEAM_ID } },
      state: { type: { nin: ["completed", "canceled"] } },
      title: { contains: titlePrefix },
    },
  }, apiKey);
  return data.issues.nodes[0] || null;
}

/**
 * Create a Linear issue. De-duplicates by checking for existing open issues
 * with the same title prefix.
 */
export async function createLinearIssue({
  title,
  description = '',
  priority = 2, // 1=Urgent, 2=High, 3=Normal, 4=Low
  labels = [],
  project,
  workflow,
}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error('[linear-issue-creator] LINEAR_API_KEY not set, skipping issue creation');
    return null;
  }

  // Determine project from workflow name if not explicit
  const projectName = project || (workflow ? getProjectForWorkflow(workflow) : 'Crawlers');
  const projectId = PROJECT_MAP[projectName];

  // De-duplicate: check if a similar issue already exists
  const titlePrefix = title.slice(0, 60);
  const existing = await findExistingIssue(titlePrefix, apiKey);
  if (existing) {
    console.log(`[linear-issue-creator] Issue already exists: ${existing.identifier} — ${existing.title}`);
    return existing;
  }

  // Truncate description to Linear's limit
  const desc = description.length > 10000 ? description.slice(0, 9900) + '\n\n...(truncated)' : description;

  // Resolve label IDs
  let labelIds = [];
  if (labels.length > 0) {
    try {
      const data = await linearGraphQL(`
        query($teamId: String!) {
          issueLabels(filter: { team: { id: { eq: $teamId } } }) {
            nodes { id name }
          }
        }
      `, { teamId: TEAM_ID }, apiKey);
      const labelMap = Object.fromEntries(data.issueLabels.nodes.map(l => [l.name, l.id]));
      labelIds = labels.map(l => labelMap[l]).filter(Boolean);
    } catch { /* ignore label resolution failures */ }
  }

  // Create the issue
  const input = {
    teamId: TEAM_ID,
    title: title.slice(0, 200),
    description: desc,
    priority,
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(projectId ? { projectId } : {}),
  };

  const data = await linearGraphQL(`
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier title url }
      }
    }
  `, { input }, apiKey);

  const issue = data.issueCreate.issue;
  console.log(`[linear-issue-creator] Created: ${issue.identifier} — ${issue.title}`);
  console.log(`[linear-issue-creator] URL: ${issue.url}`);
  return issue;
}

// CLI mode
if (process.argv[1]?.endsWith('linear-issue-creator.mjs')) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const title = get('--title');
  if (!title) {
    console.error('Usage: node linear-issue-creator.mjs --title "..." [--description "..."] [--priority N] [--label Bug] [--project Crawlers] [--workflow "Update Coop"]');
    process.exit(1);
  }

  createLinearIssue({
    title,
    description: get('--description') || '',
    priority: Number(get('--priority') || 2),
    labels: get('--label') ? [get('--label')] : ['Bug'],
    project: get('--project'),
    workflow: get('--workflow'),
  }).then(issue => {
    if (issue) process.exit(0);
    else process.exit(1);
  }).catch(err => {
    console.error(`[linear-issue-creator] Error: ${err.message}`);
    process.exit(1);
  });
}
