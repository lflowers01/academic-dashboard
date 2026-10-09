export const PROVIDERS = {
  labflow: {
    name: 'Labflow',
    example: 'Open the Labflow course home',
    matches: url => url.hostname === 'courses.catalystedu.com' && /^\/app\/course\/[^/]+\/?$/.test(url.pathname),
    normalize: url => `${url.origin}${url.pathname.replace(/\/$/, '')}`,
  },
  macmillan: {
    name: 'Macmillan Achieve',
    example: 'Open the Achieve course page',
    matches: url => url.hostname === 'achieve.macmillanlearning.com' && /^\/courses\/[^/]+\/mycourse\/?$/.test(url.pathname),
    normalize: url => `${url.origin}${url.pathname.replace(/\/$/, '')}`,
  },
  pearson: {
    name: 'Pearson MyLab',
    example: 'Open Homework and Tests in MyLab',
    matches: url => url.hostname === 'mylab.pearson.com' && /^\/Student\/(?:DoAssignments|IntegratedAssignmentOverview)\.aspx$/i.test(url.pathname),
    normalize: url => `${url.origin}/Student/DoAssignments.aspx?view=all`,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerUrl(value) {
  try {
    const url = new URL(String(value));
    const entry = Object.entries(PROVIDERS).find(([, provider]) => provider.matches(url));
    return entry ? { id: entry[0], url: entry[1].normalize(url) } : null;
  } catch { return null; }
}

export function validProviderSettings(provider, value) {
  const normalized = providerUrl(value?.url);
  const courseId = Number(value?.courseId);
  return normalized?.id === provider && Number.isInteger(courseId) && courseId > 0
    ? { url: normalized.url, courseId }
    : null;
}
