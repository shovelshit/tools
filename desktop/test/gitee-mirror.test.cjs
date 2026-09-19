const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/electron.yml'), 'utf8');
const block = workflow.split('      - name: Mirror published assets to Gitee')[1].split('\n  cleanup_release:')[0];
const script = block.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');

function runMirror(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitee-mirror-test-'));
  const prelude = `
gh() { mkdir -p "$RUNNER_TEMP/gitee-release"; touch "$RUNNER_TEMP/gitee-release/app.dmg"; }
git() { if [[ "$*" == *push* ]]; then touch "$RUNNER_TEMP/synced"; fi; }
curl() {
  if [[ "$*" == *attach_files* ]]; then echo '{"id":2}'; return; fi
  if [[ "$*" == *releases/tags* ]]; then
    if [[ "$MODE" == existing ]]; then echo '{"id":123}'; return; fi
    echo '{"message":"Not Found"}'; return 22
  fi
  if [[ "$MODE" == failure ]]; then echo '{"message":"Release creation rejected"}'; return 22; fi
  if [[ ! -f "$RUNNER_TEMP/synced" ]]; then echo '{"message":"Commit not found"}'; return 22; fi
  echo '{"id":123}'
}
`;
  try {
    return spawnSync('bash', ['-c', prelude + script], { encoding: 'utf8', env: {
      ...process.env, MODE: mode, RUNNER_TEMP: dir, GITEE_TOKEN: 'test-token',
      RELEASE_TAG: 'v0.1.20', GITHUB_SHA: 'test-sha', GITHUB_REPOSITORY: 'owner/repo'
    }});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('Gitee mirror synchronizes the release commit before creating its release', () => {
  const result = runMirror('new');
  assert.equal(result.status, 0, result.stderr);
});

test('Gitee mirror reuses an existing release on retry', () => {
  const result = runMirror('existing');
  assert.equal(result.status, 0, result.stderr);
});

test('Gitee creation errors remain visible instead of disappearing into command substitution', () => {
  const result = runMirror('failure');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release creation rejected/);
});
