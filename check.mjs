// npm run check — verifies the Brightspace connection works (used during setup).
import { checkConnection } from './brightspace.mjs';
try {
  const courses = await checkConnection();
  console.log(`OK: connected to Brightspace, ${courses.length} active course(s) found.`);
  process.exit(0);
} catch (e) {
  console.log(`FAILED (${e.kind || 'error'}): ${e.message}`);
  console.log(e.kind === 'auth' || /setup|credential/i.test(e.message)
    ? 'Brightspace is not signed in yet. Run:  npx -y brightspace-mcp-server@latest setup --purdue'
    : 'Check your internet connection and try again.');
  process.exit(1);
}
