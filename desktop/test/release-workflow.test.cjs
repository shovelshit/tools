const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowPath = path.resolve(__dirname, "../../.github/workflows/electron.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

test("master pushes publish installers directly to a GitHub Release", () => {
  assert.match(workflow, /push:\s*\n\s+branches: \[master\]\s*\n\s+pull_request:/);
  assert.doesNotMatch(workflow, /branches: \[[^\]]*main/);
  assert.doesNotMatch(workflow, /\n\s+tags:/);
  assert.doesNotMatch(workflow, /\nconcurrency:/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/);

  assert.match(workflow, /\n  verify:/);
  assert.match(workflow, /\n  prepare_release:/);
  assert.match(workflow, /\n  package_release:/);
  assert.match(workflow, /\n  publish_release:/);
  assert.match(workflow, /\n  cleanup_release:/);
  assert.match(workflow, /gh release create[^\n]*--draft/);
  assert.match(workflow, /npm --prefix desktop pkg set version=/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /gh release edit[^\n]*--draft=false[^\n]*"\$latest_flag"/);
  assert.match(workflow, /Set application version[\s\S]*?shell: bash[\s\S]*?npm --prefix desktop pkg set version=/);
  assert.match(workflow, /publish_release:[\s\S]*?permissions:\s*\n\s+actions: read\s*\n\s+contents: write/);
  assert.match(workflow, /Wait for earlier master releases[\s\S]*?actions\/workflows\/electron\.yml\/runs[\s\S]*?\.run_number < \$GITHUB_RUN_NUMBER[\s\S]*?\.status != \\"completed\\"/);
  assert.match(workflow, /\.run_number > \$GITHUB_RUN_NUMBER[\s\S]*?\.conclusion == \\"success\\"/);
  assert.match(workflow, /latest_flag="--latest=false"/);
  assert.doesNotMatch(workflow, /--slurp/);
  assert.match(workflow, /cleanup_release:[\s\S]*?needs: \[prepare_release, package_release, publish_release\]/);
  assert.match(workflow, /cleanup_release:[\s\S]*?if: \$\{\{ always\(\) && needs\.prepare_release\.result != 'skipped' && needs\.prepare_release\.outputs\.tag != '' && needs\.publish_release\.result != 'success' \}\}/);
  const cleanup = workflow.split("\n  cleanup_release:")[1];
  assert.match(cleanup, /gh api --method GET --paginate[\s\S]*?repos\/\$GITHUB_REPOSITORY\/releases/);
  assert.match(cleanup, /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$release_id"/);
  assert.match(cleanup, /git\/matching-refs\/tags\/\$RELEASE_TAG[\s\S]*?git\/refs\/tags\/\$RELEASE_TAG/);
  assert.match(cleanup, /for attempt in 1 2 3 4/);
  assert.doesNotMatch(cleanup, /releases\/tags|\|\| true/);
});

test("release workflow never stores installers as Actions artifacts", () => {
  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  const packageJob = workflow.split("\n  package_release:")[1].split("\n  publish_release:")[0];
  assert.doesNotMatch(packageJob, /CSC_IDENTITY_AUTO_DISCOVERY: "false"\s*\n\s+GH_TOKEN:/);
  assert.match(packageJob, /Upload macOS release assets[\s\S]*?GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(packageJob, /Upload Windows release assets[\s\S]*?GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /prepare_release:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.match(workflow, /package_release:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.match(workflow, /publish_release:[\s\S]*?permissions:\s*\n\s+contents: write/);
});
