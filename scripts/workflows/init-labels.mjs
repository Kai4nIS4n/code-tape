import { defaultLabels } from './config.mjs';
import { GitHubClient } from './github-client.mjs';

const client = new GitHubClient();

for (const label of defaultLabels) {
  await client.upsertLabel(label);
  console.log(`upserted label ${label.name}`);
}
