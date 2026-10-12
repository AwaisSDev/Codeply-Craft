// Shared by the main window (app.js) and the Alt+C drop (drop/drop.js).
// Starting something new with no folder picked: Craft makes the folder itself
// (Documents\Codeply Projects\<name>) instead of asking for one.
const THING_TYPES = 'websites?|web ?sites?|sites?|web ?apps?|apps?|landing ?pages?|portfolios?|dashboards?|games?|apis?|backends?|frontends?|extensions?|bots?|tools?|clones?|projects?|stores?|shops?|blogs?|scripts?|programs?';
const NEW_TYPES = THING_TYPES + '|repos?|repositor(?:y|ies)';
function newProjectName(raw) {
  const t = String(raw || '').trim();
  if (t.length < 8 || /^(how|what|why|when|which|who|where|is|are|does|do|should|explain|tell me)\b/i.test(t)) return null;
  const hit = new RegExp(`\\b(build|make|create|code|develop|design|generate|start|set ?up|scaffold|write)\\b[^.?!]{0,60}?\\b(${NEW_TYPES})\\b`, 'i').exec(t);
  if (!hit) return null;
  // named after what's being built ("a todo app"), not the word "repo"
  const m = new RegExp(`\\b(?:a|an|my|the|new)\\s+((?:[a-z0-9-]+\\s+){0,2}?)(${THING_TYPES})\\b`, 'i').exec(t);
  return m ? `${m[1]}${m[2]}`.trim() : 'new-project';
}
