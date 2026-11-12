const { PROJECT_FAVORITES_FILE } = require('./paths');
const { readJson, writeDataJson } = require('./file-helpers');

/** Slugs of the projects the user starred. */
function readFavorites() {
  const data = readJson(PROJECT_FAVORITES_FILE, { slugs: [] });
  return Array.isArray(data.slugs) ? data.slugs : [];
}

/** Star (`on` true) or unstar a project; returns the updated slug list. */
function setFavorite(slug, on) {
  const slugs = readFavorites().filter(s => s !== slug);
  if (on) slugs.push(slug);
  writeDataJson(PROJECT_FAVORITES_FILE, { slugs });
  return slugs;
}

module.exports = { readFavorites, setFavorite };
