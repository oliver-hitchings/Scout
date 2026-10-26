// Runs with the artifact's bundled runtime and imports only its installed code.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [appRoot, workspace] = process.argv.slice(2);
const installed = (relative) => import(pathToFileURL(path.join(appRoot, relative)).href);
const { createOnboardingProposal } = await installed('ui/lib/onboardingProposal.mjs');
const { runScan, runScanWith } = await installed('tools/scout.mjs');
process.on('message', async ({ id, command }) => {
  try {
    let result;
    if (command === 'onboarding') result = await createOnboardingProposal(workspace, 'codex');
    else if (command === 'scan') result = await runScan(workspace, 'codex', 'primary', {
      runScanWithFn: (root, provider, mode, options) => runScanWith(root, provider, mode, {
        ...options,
        // Collection and advert liveness are explicit synthetic source boundaries;
        // provider assessment still invokes the actual subprocess adapter.
        collectSourcesFn: async () => ({ generatedAt: new Date().toISOString(), queries: ['Synthetic Engineer'],
          sources: { acceptance: { configured: true, status: 'healthy', count: 1, jobs: [{
            company: 'Synthetic Studio', title: 'Synthetic Engineer', location: 'Remote',
            url: 'https://jobs.example.test/installed-role', providerId: 'installed-role',
            description: 'Deliver reliable synthetic systems.',
          }] } } }),
        checkLivenessFn: async (items) => ({ live: items, removed: [], summary: { checked: items.length, gone: 0, unverified: 0 } }),
      }),
    });
    else throw new Error('Unknown acceptance command');
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error.message }); }
});
process.send({ ready: true });
