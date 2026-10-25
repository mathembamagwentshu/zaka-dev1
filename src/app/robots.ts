import type { MetadataRoute } from "next";

/** Private sandbox: payer pages are reachable only through personal links; nothing is indexed. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
