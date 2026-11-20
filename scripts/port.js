// Used by run.sh / run.bat: `node scripts/port.js` prints the saved port (default 3000),
// `node scripts/port.js 3001` saves it to data/app-config.json for the next start, stop and autostart.
const { getPort, savePort } = require('../lib/port');

if (process.argv[2]) savePort(process.argv[2]);
else console.log(getPort());
