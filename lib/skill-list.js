const fs = require('fs');
const path = require('path');
const { readFrontmatterFile } = require('./frontmatter');

/** Skills in a skills folder: each subfolder holding a SKILL.md. */
function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      try {
        const skillFile = path.join(dir, d.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return null;
        const { frontmatter, content } = readFrontmatterFile(skillFile);
        return {
          name: d.name,
          title: frontmatter.name || d.name,
          description: String(frontmatter.description || ''),
          frontmatter,
          content
        };
      } catch (_) { return null; }
    }).filter(Boolean);
}

module.exports = { listSkills };
