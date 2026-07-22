const fs = require('fs');

function getCustomTitle(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let customTitle = '';
    let summaryTitle = '';
    for (const line of lines) {
      if (!line.includes('"type":"custom-title"') && !line.includes('"type":"summary"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'custom-title' && entry.customTitle) {
          customTitle = entry.customTitle;
        } else if (entry.type === 'summary' && entry.summary) {
          summaryTitle = entry.summary;
        }
      } catch (_) { /* malformed line */ }
    }
    return customTitle || summaryTitle;
  } catch (_) { return ''; }
}

module.exports = { getCustomTitle };
