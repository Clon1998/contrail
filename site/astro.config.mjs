// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { BASE, DOCS, REPO, SITE } from "./site.config.mjs";

/** Sidebar entry for a page generated from `docs/` (see site.config.mjs). */
const doc = (/** @type {string} */ slug) => {
  const entry = DOCS.find((d) => d.slug === slug);
  if (!entry) throw new Error(`unknown doc page: ${slug}`);
  return { label: entry.label, slug };
};

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Contrail",
      description:
        "A fast desktop log viewer for AWS ECS services. Switch SSO profiles, browse clusters and services, and read live, structured logs. Read-only, no credentials stored.",
      logo: { src: "./src/assets/logo.svg", alt: "Contrail logo" },
      favicon: "/favicon.svg",
      // The preview picture for links shared in Slack, Teams… (app/ui: pnpm screenshots).
      head: [
        { tag: "meta", attrs: { property: "og:image", content: `${SITE}${BASE}/og.png` } },
        { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}${BASE}/og.png` } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Contrail: your ECS logs, live and readable." } },
      ],
      social: [{ icon: "github", label: "GitHub", href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/site/` },
      customCss: [
        "@fontsource-variable/schibsted-grotesk",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/custom.css",
      ],
      // The landing page's hero, see the comment in the component.
      components: { Hero: "./src/components/Hero.astro" },
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Quick start", slug: "quick-start" },
            { label: "Download", slug: "download" },
          ],
        },
        {
          label: "Guides",
          items: [doc("guides/user-guide"), doc("guides/teams")],
        },
        {
          label: "Reference",
          items: [doc("search-syntax"), { label: "AWS permissions", slug: "permissions" }],
        },
        {
          label: "Contributing",
          items: [doc("contributing/development")],
        },
        {
          label: "About",
          items: [doc("security"), doc("faq")],
        },
      ],
    }),
  ],
});
