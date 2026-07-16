// The official `e2b` package from npm, unmodified, pointed at Dormice by two
// URLs and an API-key prefix — migrating an E2B application is configuration,
// not code.
//
//   DORMICE_API_TOKEN=... node examples/e2b-compat.mjs
import { Sandbox } from 'e2b';

const endpoint = process.env.DORMICE_ENDPOINT ?? 'http://127.0.0.1:3676';
const token = process.env.DORMICE_API_TOKEN;
if (!token) {
  console.error(
    'Set DORMICE_API_TOKEN (it is in /etc/dormice/env on an install.sh host).',
  );
  process.exit(1);
}

const sbx = await Sandbox.create({
  apiKey: `e2b_${token}`,
  apiUrl: `${endpoint}/e2b/api`,
  sandboxUrl: `${endpoint}/e2b/envd`,
  // E2B semantics hold: this is a real deadline, and this sandbox really is
  // killed when it expires. (Sandboxes made through the native API never get
  // a deadline — there, permanence is the default.)
  timeoutMs: 120_000,
});
console.log(`created ${sbx.sandboxId}`);

try {
  // Output streams live, frame by frame — not one lump when the command ends.
  await sbx.commands.run('for i in 1 2 3; do echo tick $i; sleep 1; done', {
    onStdout: (data) => {
      process.stdout.write(data);
    },
  });

  await sbx.files.write('/home/user/hello.txt', 'through the official SDK\n');
  const text = await sbx.files.read('/home/user/hello.txt');
  console.log(`read back: ${text.trimEnd()}`);
} finally {
  await sbx.kill();
  console.log('killed');
}

// Dormice extension worth knowing: Sandbox.create({ metadata: { name } })
// makes create idempotent — the same key returns the same sandbox instead of
// a new one, which is how an E2B application picks up permanent sandboxes
// without leaving the e2b package.
