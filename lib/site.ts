/**
 * The app's public origin, for absolute URLs in metadata, sitemaps and social
 * cards. Vercel sets VERCEL_PROJECT_PRODUCTION_URL automatically; APP_URL
 * overrides it for other hosts or a custom domain.
 */
export function siteUrl(): string {
  const explicit = process.env.APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;

  return "http://localhost:3000";
}
